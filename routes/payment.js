// routes/payment.js
// Native ETH only (Sepolia) - Simplified Purchase Flow
// No reward-related functionality, only item purchases via crypto

const express = require("express");
const { body, validationResult } = require("express-validator");
const crypto = require("crypto");

const Player = require("../models/Player");
const blockchainService = require("../services/blockchainService");

const router = express.Router();

// SmartStore.sol numeric item IDs mapping
const ITEM_STORE_IDS = {
  wallet_upgrade_1: 1,
  wallet_upgrade_2: 2,
  ai_replay: 3,
  custom_skin: 4,
};

// Reverse map: numeric → string itemId
const NUMERIC_TO_ITEM_ID = {
  1: "wallet_upgrade_1",
  2: "wallet_upgrade_2",
  3: "ai_replay",
  4: "custom_skin",
};

// ==================== PURCHASE FLOW ====================
// These endpoints work with Unity mobile game via encoded transaction data

// POST /api/purchase/prepare - Prepare purchase transaction
// Returns encoded tx data for MetaMask Mobile deep link
router.post(
  "/prepare",
  [
    body("itemId").notEmpty(),
    body("walletAddress").optional().isEthereumAddress(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { itemId, walletAddress } = req.body;

      // Resolve to numeric ID
      let numericId;
      if (typeof itemId === "number" || /^\d+$/.test(String(itemId))) {
        numericId = parseInt(itemId, 10);
      } else {
        numericId = ITEM_STORE_IDS[itemId];
        if (!numericId) {
          return res.status(400).json({ success: false, message: `Unknown itemId: ${itemId}` });
        }
      }

      if (numericId < 1 || numericId > 4) {
        return res.status(400).json({ success: false, message: `Invalid itemId: ${numericId}` });
      }

      // Determine wallet address - use provided or try to get from player auth
      let playerWallet = walletAddress;
      
      if (!playerWallet && req.headers.authorization) {
        try {
          // If JWT auth is used, extract player wallet
          const authService = require("../services/unityAuthService");
          const player = await authService.verifyToken(req.headers.authorization.replace("Bearer ", ""));
          if (player) {
            playerWallet = player.walletAddress;
          }
        } catch (e) {
          // Auth failed, continue without wallet
        }
      }

      if (!playerWallet) {
        return res.status(400).json({
          success: false,
          message: "Wallet address is required",
        });
      }

      playerWallet = playerWallet.toLowerCase();
      console.log(`[Purchase] prepare: wallet=${playerWallet} numericId=${numericId}`);

      // Get item details from blockchain
      const item = await blockchainService.getItem(numericId);
      
      // Check if player already owns the item
      const hasItem = await blockchainService.hasPlayerBoughtItem(playerWallet, numericId);
      if (hasItem) {
        return res.status(400).json({
          success: false,
          message: "Item already owned",
          itemId: numericId,
          itemName: item.name,
        });
      }

      // Prepare the transaction data
      const txData = await blockchainService.prepareStorePurchaseTx(playerWallet, numericId);

      return res.json({
        success: true,
        ...txData,
        stringItemId: NUMERIC_TO_ITEM_ID[numericId] || `item_${numericId}`,
        itemId: numericId, // Include itemId for tracking
      });

    } catch (err) {
      console.error("[Purchase] prepare error:", err.message);
      return res.status(400).json({ success: false, message: err.message });
    }
  }
);

// POST /api/purchase/confirm - Confirm purchase by checking event
// This endpoint listens for the ItemPurchased event from the blockchain
router.post(
  "/confirm",
  [
    body("walletAddress").isEthereumAddress(),
    body("itemId").isInt({ min: 1 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { walletAddress, itemId } = req.body;
      const playerAddress = walletAddress.toLowerCase();
      const numericItemId = parseInt(itemId, 10);

      // Check if player owns the item
      const hasItem = await blockchainService.hasPlayerBoughtItem(playerAddress, numericItemId);

      if (!hasItem) {
        return res.status(400).json({
          success: false,
          message: "Purchase not confirmed yet. Please wait for transaction confirmation.",
        });
      }

      // Get item details
      const item = await blockchainService.getItem(numericItemId);

      return res.json({
        success: true,
        message: "Item purchase confirmed",
        itemId: numericItemId,
        itemName: item.name,
        playerAddress,
      });

    } catch (err) {
      console.error("[Purchase] confirm error:", err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

// POST /api/purchase/check-ownership - Check if player owns item
// Utility endpoint for checking ownership status
router.post(
  "/check-ownership",
  [
    body("walletAddress").isEthereumAddress(),
    body("itemId").isInt({ min: 1 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { walletAddress, itemId } = req.body;
      const playerAddress = walletAddress.toLowerCase();
      const numericItemId = parseInt(itemId, 10);

      const hasItem = await blockchainService.hasPlayerBoughtItem(playerAddress, numericItemId);
      const item = await blockchainService.getItem(numericItemId);

      return res.json({
        success: true,
        ownsItem: hasItem,
        itemId: numericItemId,
        itemName: item.name,
        playerAddress,
      });

    } catch (err) {
      console.error("[Purchase] check-ownership error:", err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

// Legacy endpoint - kept for backward compatibility
// Maps to /api/purchase/prepare
router.post("/prepare-store-tx", async (req, res) => {
  // This endpoint is kept for backward compatibility
  // Use /api/purchase/prepare instead
  const { itemId, walletAddress } = req.body;
  
  if (!walletAddress) {
    return res.status(400).json({
      success: false,
      message: "walletAddress is required",
    });
  }

  // Call prepare endpoint logic
  try {
    let numericId;
    if (typeof itemId === "number" || /^\d+$/.test(String(itemId))) {
      numericId = parseInt(itemId, 10);
    } else {
      numericId = ITEM_STORE_IDS[itemId];
      if (!numericId) {
        return res.status(400).json({ success: false, message: `Unknown itemId: ${itemId}` });
      }
    }

    if (numericId < 1 || numericId > 4) {
      return res.status(400).json({ success: false, message: `Invalid itemId: ${numericId}` });
    }

    const playerWallet = walletAddress.toLowerCase();
    const txData = await blockchainService.prepareStorePurchaseTx(playerWallet, numericId);
    const item = await blockchainService.getItem(numericId);

    return res.json({
      success: true,
      ...txData,
      stringItemId: NUMERIC_TO_ITEM_ID[numericId] || `item_${numericId}`,
    });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

// ==================== PAYMENT INTENT TRACKING ====================
// In-memory storage for payment intents (for old payment flow compatibility)
// Note: This is different from txHash polling - it's for tracking the legacy payment flow

const paymentIntents = new Map(); // intentId -> { itemId, status, createdAt, updatedAt }

// POST /api/payment/create-intent - Create payment intent for StoreManager.cs line 319
// Body: { itemId }
// Returns: { intentId, status }
router.post(
  "/create-intent",
  [
    body("itemId").notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { itemId } = req.body;

      // Generate unique intent ID (UUID)
      const intentId = crypto.randomUUID();

      // Resolve itemId to numeric ID for consistency
      let numericId;
      if (typeof itemId === "number" || /^\d+$/.test(String(itemId))) {
        numericId = parseInt(itemId, 10);
      } else {
        numericId = ITEM_STORE_IDS[itemId] || itemId;
      }

      // Store intent in memory
      paymentIntents.set(intentId, {
        itemId: numericId,
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      console.log(`[Payment] create-intent: intentId=${intentId} itemId=${numericId}`);

      return res.json({
        success: true,
        intentId,
        status: "pending",
        itemId: numericId,
      });

    } catch (err) {
      console.error("[Payment] create-intent error:", err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

// GET /api/payment/status/:intentId - Get payment status for StoreManager.cs line 383
// This is different from txHash polling - it's for tracking the old payment flow
router.get(
  "/status/:intentId",
  async (req, res) => {
    const { intentId } = req.params;

    if (!intentId) {
      return res.status(400).json({ success: false, message: "intentId is required" });
    }

    try {
      console.log(`[Payment] status check: intentId=${intentId}`);

      const intent = paymentIntents.get(intentId);

      if (!intent) {
        return res.status(404).json({
          success: false,
          message: "Payment intent not found",
          status: "not_found",
        });
      }

      return res.json({
        success: true,
        intentId,
        status: intent.status,
        itemId: intent.itemId,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
      });

    } catch (err) {
      console.error("[Payment] status/:intentId error:", err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

// Helper function to update payment intent status (can be called by other endpoints)
// This would be used when the actual payment is confirmed via blockchain
function updatePaymentIntent(intentId, newStatus) {
  const intent = paymentIntents.get(intentId);
  if (intent) {
    intent.status = newStatus;
    intent.updatedAt = new Date().toISOString();
    paymentIntents.set(intentId, intent);
    return true;
  }
  return false;
}

module.exports = router;
module.exports.updatePaymentIntent = updatePaymentIntent;

// ==================== NEW ENDPOINTS ====================

// POST /api/purchase/submit-tx - Submit transaction hash after MetaMask signing
// Receives txHash from Unity after user signs in MetaMask
router.post(
  "/submit-tx",
  [
    body("txHash").notEmpty(),
    body("itemId").notEmpty(),
    body("walletAddress").isEthereumAddress(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { txHash, itemId, walletAddress } = req.body;
      const playerAddress = walletAddress.toLowerCase();

      // Resolve itemId to numeric ID
      let numericId;
      if (typeof itemId === "number" || /^\d+$/.test(String(itemId))) {
        numericId = parseInt(itemId, 10);
      } else {
        numericId = ITEM_STORE_IDS[itemId];
        if (!numericId) {
          return res.status(400).json({ success: false, message: `Unknown itemId: ${itemId}` });
        }
      }

      console.log(`[Purchase] submit-tx: txHash=${txHash} itemId=${numericId} wallet=${playerAddress}`);

      // Verify transaction on blockchain
      let receipt;
      try {
        receipt = await blockchainService.provider.waitForTransaction(txHash, 1, 60000); // Wait for 1 confirmation, timeout 60s
      } catch (waitErr) {
        // Transaction not confirmed yet or failed
        console.error(`[Purchase] waitForTransaction error:`, waitErr.message);
        return res.status(202).json({
          success: false,
          message: "Transaction not yet confirmed. Please wait.",
          status: "pending",
          txHash,
        });
      }

      // Check transaction status
      if (!receipt || receipt.status !== 1) {
        console.error(`[Purchase] Transaction failed: ${txHash}, status: ${receipt?.status}`);
        return res.status(400).json({
          success: false,
          message: "Transaction failed on blockchain",
          status: "failed",
          txHash,
          blockNumber: receipt?.blockNumber,
        });
      }

      console.log(`[Purchase] Transaction confirmed: ${txHash}, block: ${receipt.blockNumber}`);

      // Verify the purchase on the smart contract
      const hasItem = await blockchainService.hasPlayerBoughtItem(playerAddress, numericId);
      if (!hasItem) {
        return res.status(400).json({
          success: false,
          message: "Item purchase not found on blockchain",
          status: "failed",
          txHash,
        });
      }

      // Get item details
      const item = await blockchainService.getItem(numericId);
      const stringItemId = NUMERIC_TO_ITEM_ID[numericId] || `item_${numericId}`;

      // Update player inventory in database (if player exists)
      let playerUpdated = false;
      try {
        const player = await Player.findOne({ walletAddress: playerAddress });
        if (player) {
          // Check if player already has this item
          if (!player.ownedItems.includes(stringItemId)) {
            player.ownedItems.push(stringItemId);
            await player.save();
            playerUpdated = true;
            console.log(`[Purchase] Updated player inventory: ${playerAddress} now owns ${stringItemId}`);
          } else {
            console.log(`[Purchase] Player already owns item: ${playerAddress} - ${stringItemId}`);
          }
        } else {
          console.log(`[Purchase] No player found with wallet: ${playerAddress}`);
        }
      } catch (dbErr) {
        console.error(`[Purchase] Database update error:`, dbErr.message);
        // Continue - blockchain verification is the source of truth
      }

      return res.json({
        success: true,
        message: "Transaction confirmed and item purchased successfully",
        status: "confirmed",
        txHash,
        blockNumber: receipt.blockNumber,
        confirmations: receipt.confirmations,
        itemId: numericId,
        stringItemId,
        itemName: item.name,
        playerAddress,
        playerInventoryUpdated: playerUpdated,
      });

    } catch (err) {
      console.error("[Purchase] submit-tx error:", err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

// GET /api/purchase/status - Polling endpoint for Unity to check tx status
router.get(
  "/status",
  async (req, res) => {
    const { txHash } = req.query;

    if (!txHash) {
      return res.status(400).json({ success: false, message: "txHash is required" });
    }

    try {
      console.log(`[Purchase] status check: txHash=${txHash}`);

      // Get current block to calculate confirmations
      const currentBlock = await blockchainService.provider.getBlockNumber();

      // Try to get transaction receipt
      let receipt;
      try {
        receipt = await blockchainService.provider.getTransactionReceipt(txHash);
      } catch (receiptErr) {
        console.error(`[Purchase] getTransactionReceipt error:`, receiptErr.message);
        return res.status(200).json({
          success: true,
          status: "pending",
          txHash,
          confirmations: 0,
        });
      }

      // Transaction not found or not yet mined
      if (!receipt) {
        return res.status(200).json({
          success: true,
          status: "pending",
          txHash,
          confirmations: 0,
        });
      }

      // Transaction mined - check status
      const confirmations = currentBlock - receipt.blockNumber + 1;

      if (receipt.status === 1) {
        return res.status(200).json({
          success: true,
          status: "confirmed",
          txHash,
          blockNumber: receipt.blockNumber,
          confirmations,
          gasUsed: receipt.gasUsed?.toString(),
        });
      } else {
        return res.status(200).json({
          success: true,
          status: "failed",
          txHash,
          blockNumber: receipt.blockNumber,
          confirmations,
          gasUsed: receipt.gasUsed?.toString(),
        });
      }

    } catch (err) {
      console.error("[Purchase] status error:", err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);
