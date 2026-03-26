// routes/payment.js
// Native ETH only (Sepolia) - Simplified Purchase Flow
//
// MOUNT POINT: This router is mounted at /api/purchase in server.js.
//
// FIX: Added /create-intent and /status/:intentId routes here so Unity can
// reach them at /api/purchase/create-intent and /api/purchase/status/:intentId.
// Previously they were only reachable at /api/payment/... which returned 404
// because the router is mounted at /api/purchase, not /api/payment.

const express = require("express");
const { body, validationResult } = require("express-validator");
const crypto = require("crypto");

const Player = require("../models/Player");
const blockchainService = require("../services/blockchainService");
const transactionService = require("../services/transactionService");

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

// ==================== PAYMENT INTENT (Fiat / GCash) ====================
// These are called by StoreManager.PurchaseBlockchainItemWithFiat()
// Unity calls: POST /api/purchase/create-intent
//              GET  /api/purchase/status/:intentId

// In-memory intent store (replace with Redis or DB for production)
const paymentIntents = new Map();

// POST /api/purchase/create-intent
// Called by Unity StoreManager.PurchaseBlockchainItemWithFiat()
router.post(
  "/create-intent",
  [body("itemId").notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { itemId } = req.body;

      const intentId = crypto.randomUUID();

      let numericId;
      if (typeof itemId === "number" || /^\d+$/.test(String(itemId))) {
        numericId = parseInt(itemId, 10);
      } else {
        numericId = ITEM_STORE_IDS[itemId] || itemId;
      }

      paymentIntents.set(intentId, {
        itemId: numericId,
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      console.log(`[Payment] create-intent: intentId=${intentId} itemId=${numericId}`);

      return res.json({
        success: true,
        // FIX: field name must be paymentIntentId (matches CreateIntentResponse.cs)
        paymentIntentId: intentId,
        status: "pending",
        itemId: numericId,
        // checkoutUrl is empty here — a real PayMongo integration would
        // call the PayMongo API and return the actual checkout URL.
        checkoutUrl: "",
      });

    } catch (err) {
      console.error("[Payment] create-intent error:", err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

// GET /api/purchase/status/:intentId
// Called by Unity StoreManager.PollPaymentStatusAsync()
router.get("/status/:intentId", async (req, res) => {
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
      txHash: intent.txHash || null,
      explorerUrl: intent.explorerUrl || null,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
    });

  } catch (err) {
    console.error("[Payment] status/:intentId error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Helper to update intent status — used internally when payment is confirmed
function updatePaymentIntent(intentId, newStatus, txHash, explorerUrl) {
  const intent = paymentIntents.get(intentId);
  if (intent) {
    intent.status = newStatus;
    intent.updatedAt = new Date().toISOString();
    if (txHash)      intent.txHash      = txHash;
    if (explorerUrl) intent.explorerUrl = explorerUrl;
    paymentIntents.set(intentId, intent);
    return true;
  }
  return false;
}

// ==================== ETH PURCHASE FLOW ====================

// POST /api/purchase/prepare-tx
// Called by WalletManager.PurchaseStoreItem() — returns transaction data for WalletConnect
router.post(
  "/prepare-tx",
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

      let playerWallet = walletAddress;

      if (!playerWallet && req.headers.authorization) {
        try {
          const authService = require("../services/unityAuthService");
          const player = await authService.verifyToken(req.headers.authorization.replace("Bearer ", ""));
          if (player) playerWallet = player.walletAddress;
        } catch (e) {
          // Auth failed, continue without wallet
        }
      }

      if (!playerWallet) {
        return res.status(400).json({ success: false, message: "Wallet address is required" });
      }

      playerWallet = playerWallet.toLowerCase();
      console.log(`[Purchase] prepare-tx: wallet=${playerWallet} numericId=${numericId}`);

      const item = await blockchainService.getItem(numericId);

      const hasItem = await blockchainService.hasPlayerBoughtItem(playerWallet, numericId);
      if (hasItem) {
        return res.status(400).json({
          success: false,
          message: "Item already owned",
          itemId: numericId,
          itemName: item.name,
        });
      }

      const txData = await blockchainService.prepareStorePurchaseTx(playerWallet, numericId);

      return res.json({
        success: true,
        ...txData,
        stringItemId: NUMERIC_TO_ITEM_ID[numericId] || `item_${numericId}`,
        itemId: numericId,
      });

    } catch (err) {
      console.error("[Purchase] prepare-tx error:", err.message);
      return res.status(400).json({ success: false, message: err.message });
    }
  }
);

// Legacy alias: POST /api/purchase/prepare-store-tx → same as /prepare
router.post("/prepare-store-tx", async (req, res) => {
  const { itemId, walletAddress } = req.body;

  if (!walletAddress) {
    return res.status(400).json({ success: false, message: "walletAddress is required" });
  }

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

    return res.json({
      success: true,
      ...txData,
      stringItemId: NUMERIC_TO_ITEM_ID[numericId] || `item_${numericId}`,
    });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/purchase/submit-tx
// Called by WalletManager after MetaMask returns txHash
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

      let receipt;
      try {
        receipt = await blockchainService.provider.waitForTransaction(txHash, 1, 60000);
      } catch (waitErr) {
        console.error(`[Purchase] waitForTransaction error:`, waitErr.message);
        return res.status(202).json({
          success: false,
          message: "Transaction not yet confirmed. Please wait.",
          status: "pending",
          txHash,
        });
      }

      if (!receipt || receipt.status !== 1) {
        // Record failed transaction
        try {
          const player = await Player.findOne({ walletAddress: playerAddress });
          if (player) {
            const item = await blockchainService.getItem(numericId);
            await transactionService.recordTransaction({
              transactionHash: txHash,
              playerId: player._id,
              playerAddress,
              itemId: numericId,
              itemName: item?.name || 'Unknown Item',
              priceETH: item ? blockchainService.fromWei(item.price) : '0',
              priceWei: item ? item.price.toString() : '0',
              status: 'failed',
              chainId: 11155111,
              contractAddress: process.env.SMART_STORE_ADDRESS,
              methodName: 'buyItem',
              type: 'purchase',
              metadata: {
                blockNumber: receipt?.blockNumber,
                reason: 'Transaction failed on blockchain',
              },
            });

            if (receipt?.blockNumber) {
              await transactionService.confirmTransaction(txHash, {
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed?.toString(),
                gasPrice: receipt.gasPrice?.toString(),
              });
            }

            await transactionService.failTransaction(txHash, 'Transaction failed on blockchain');
          }
        } catch (txErr) {
          console.error(`[Purchase] Failed to record failed transaction:`, txErr.message);
        }

        return res.status(400).json({
          success: false,
          message: "Transaction failed on blockchain",
          status: "failed",
          txHash,
          blockNumber: receipt?.blockNumber,
        });
      }

      console.log(`[Purchase] Transaction confirmed: ${txHash}, block: ${receipt.blockNumber}`);

      const hasItem = await blockchainService.hasPlayerBoughtItem(playerAddress, numericId);
      if (!hasItem) {
        return res.status(400).json({
          success: false,
          message: "Item purchase not found on blockchain",
          status: "failed",
          txHash,
        });
      }

      const item = await blockchainService.getItem(numericId);
      const stringItemId = NUMERIC_TO_ITEM_ID[numericId] || `item_${numericId}`;

      let playerUpdated = false;
      let playerId = null;
      try {
        const player = await Player.findOne({ walletAddress: playerAddress });
        if (player) {
          playerId = player._id;
          if (!player.ownedItems.includes(stringItemId)) {
            player.ownedItems.push(stringItemId);
            await player.save();
            playerUpdated = true;
            console.log(`[Purchase] Updated player inventory: ${playerAddress} now owns ${stringItemId}`);
          }
        }
      } catch (dbErr) {
        console.error(`[Purchase] Database update error:`, dbErr.message);
      }

      // Record transaction in MongoDB
      if (playerId) {
        try {
          await transactionService.recordTransaction({
            transactionHash: txHash,
            playerId,
            playerAddress,
            itemId: numericId,
            itemName: item.name,
            priceETH: blockchainService.fromWei(item.price),
            priceWei: item.price.toString(),
            status: 'pending',
            chainId: 11155111,
            contractAddress: process.env.SMART_STORE_ADDRESS,
            methodName: 'buyItem',
            type: 'purchase',
            metadata: {
              stringItemId,
              receiptBlockNumber: receipt.blockNumber,
            },
          });

          // Confirm the transaction with block details
          await transactionService.confirmTransaction(txHash, {
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            gasPrice: receipt.gasPrice.toString(),
          });

          console.log(`[Purchase] Transaction recorded: ${txHash}`);
        } catch (txErr) {
          console.error(`[Purchase] Failed to record transaction:`, txErr.message);
          // Don't fail the purchase if transaction recording fails
        }
      }

      return res.json({
        success: true,
        message: "Transaction confirmed and item purchased successfully",
        status: "confirmed",
        txHash,
        blockNumber: receipt.blockNumber,
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

// GET /api/purchase/status?txHash=...
// Called by WalletManager.PollTransactionStatus() for ETH tx polling
router.get("/status", async (req, res) => {
  const { txHash } = req.query;

  // If no txHash query param, this might be the intentId path — return 400
  if (!txHash) {
    return res.status(400).json({ success: false, message: "txHash query param is required" });
  }

  try {
    console.log(`[Purchase] status check: txHash=${txHash}`);

    const currentBlock = await blockchainService.provider.getBlockNumber();

    let receipt;
    try {
      receipt = await blockchainService.provider.getTransactionReceipt(txHash);
    } catch (receiptErr) {
      return res.status(200).json({ success: true, status: "pending", txHash, confirmations: 0 });
    }

    if (!receipt) {
      return res.status(200).json({ success: true, status: "pending", txHash, confirmations: 0 });
    }

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
      });
    }

  } catch (err) {
    console.error("[Purchase] status error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/purchase/confirm
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

      const hasItem = await blockchainService.hasPlayerBoughtItem(playerAddress, numericItemId);

      if (!hasItem) {
        return res.status(400).json({
          success: false,
          message: "Purchase not confirmed yet. Please wait for transaction confirmation.",
        });
      }

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

// POST /api/purchase/check-ownership
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

// ==================== WEB APP PURCHASE FLOW ====================
// These endpoints power the React Native wallet web app.
// Unity opens the webAppUrl → user connects MetaMask → signs tx → web app calls confirm-web-tx.

// POST /api/purchase/prepare-web-tx
// Called by Unity WalletManager.PurchaseViaWebApp()
// Returns a URL the web app can open with all tx params encoded in query string
router.post(
  "/prepare-web-tx",
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

      let playerWallet = walletAddress;

      if (!playerWallet && req.headers.authorization) {
        try {
          const authService = require("../services/unityAuthService");
          const player = await authService.verifyToken(
            req.headers.authorization.replace("Bearer ", "")
          );
          if (player) playerWallet = player.walletAddress;
        } catch (e) {
          // Auth failed, continue without wallet
        }
      }

      if (!playerWallet) {
        return res.status(400).json({ success: false, message: "Wallet address is required" });
      }

      playerWallet = playerWallet.toLowerCase();
      console.log(`[Purchase] prepare-web-tx: wallet=${playerWallet} numericId=${numericId}`);

      // Check ownership
      const hasItem = await blockchainService.hasPlayerBoughtItem(playerWallet, numericId);
      if (hasItem) {
        const item = await blockchainService.getItem(numericId);
        return res.status(400).json({
          success: false,
          message: "Item already owned",
          itemId: numericId,
          itemName: item.name,
        });
      }

      // Get full tx data from blockchain service (reuses existing logic)
      const txData = await blockchainService.prepareStorePurchaseTx(playerWallet, numericId);

      // Generate a session ID for tracking
      const sessionId = crypto.randomUUID();

      // Build the web app URL with encoded transaction params
      const webAppBaseUrl = process.env.WEB_APP_URL || "http://localhost:8081";
      const queryParams = new URLSearchParams({
        to: txData.storeAddress,
        data: txData.calldataHex,
        value: txData.valueWei,
        itemId: String(numericId),
        itemName: txData.itemName,
        priceETH: String(txData.priceETH),
        walletAddress: playerWallet,
        sessionId,
      });

      const webAppUrl = `${webAppBaseUrl}/pay?${queryParams.toString()}`;

      console.log(`[Purchase] Web app URL: ${webAppUrl}`);

      return res.json({
        success: true,
        webAppUrl,
        sessionId,
        storeAddress: txData.storeAddress,
        calldataHex: txData.calldataHex,
        valueWei: txData.valueWei,
        gasLimit: txData.gasLimit,
        chainId: txData.chainId,
        itemId: numericId,
        stringItemId: NUMERIC_TO_ITEM_ID[numericId] || `item_${numericId}`,
        itemName: txData.itemName,
        priceETH: txData.priceETH,
      });
    } catch (err) {
      console.error("[Purchase] prepare-web-tx error:", err.message);
      return res.status(400).json({ success: false, message: err.message });
    }
  }
);

// POST /api/purchase/confirm-web-tx
// Called by the React Native wallet web app after transaction is confirmed on-chain.
// Validates the tx receipt and updates the player's inventory in MongoDB.
router.post(
  "/confirm-web-tx",
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
      const { txHash, itemId, walletAddress, sessionId } = req.body;
      const playerAddress = walletAddress.toLowerCase();

      let numericId;
      if (typeof itemId === "number" || /^\d+$/.test(String(itemId))) {
        numericId = parseInt(itemId, 10);
      } else {
        numericId = ITEM_STORE_IDS[itemId];
        if (!numericId) {
          return res.status(400).json({ success: false, message: `Unknown itemId: ${itemId}` });
        }
      }

      console.log(`[Purchase] confirm-web-tx: txHash=${txHash} itemId=${numericId} wallet=${playerAddress} session=${sessionId}`);

      // Wait for the transaction receipt
      let receipt;
      try {
        receipt = await blockchainService.provider.waitForTransaction(txHash, 1, 60000);
      } catch (waitErr) {
        console.error(`[Purchase] waitForTransaction error:`, waitErr.message);
        return res.status(202).json({
          success: false,
          message: "Transaction not yet confirmed. Please wait.",
          status: "pending",
          txHash,
        });
      }

      if (!receipt || receipt.status !== 1) {
        // Record failed transaction
        try {
          const player = await Player.findOne({ walletAddress: playerAddress });
          if (player) {
            const item = await blockchainService.getItem(numericId);
            await transactionService.recordTransaction({
              transactionHash: txHash,
              playerId: player._id,
              playerAddress,
              itemId: numericId,
              itemName: item?.name || "Unknown Item",
              priceETH: item ? blockchainService.fromWei(item.price) : "0",
              priceWei: item ? item.price.toString() : "0",
              status: "failed",
              chainId: 11155111,
              contractAddress: process.env.SMART_STORE_ADDRESS,
              methodName: "buyItem",
              type: "purchase",
              metadata: { blockNumber: receipt?.blockNumber, source: "web-app", sessionId },
            });
            await transactionService.failTransaction(txHash, "Transaction failed on blockchain");
          }
        } catch (txErr) {
          console.error(`[Purchase] Failed to record failed tx:`, txErr.message);
        }

        return res.status(400).json({
          success: false,
          message: "Transaction failed on blockchain",
          status: "failed",
          txHash,
        });
      }

      console.log(`[Purchase] Web tx confirmed: ${txHash}, block: ${receipt.blockNumber}`);

      // Verify on-chain ownership
      const hasItem = await blockchainService.hasPlayerBoughtItem(playerAddress, numericId);
      if (!hasItem) {
        return res.status(400).json({
          success: false,
          message: "Item purchase not found on blockchain after confirmation",
          status: "failed",
          txHash,
        });
      }

      const item = await blockchainService.getItem(numericId);
      const stringItemId = NUMERIC_TO_ITEM_ID[numericId] || `item_${numericId}`;

      // Update MongoDB player inventory
      let playerUpdated = false;
      let playerId = null;
      try {
        const player = await Player.findOne({ walletAddress: playerAddress });
        if (player) {
          playerId = player._id;
          if (!player.ownedItems.includes(stringItemId)) {
            player.ownedItems.push(stringItemId);
            await player.save();
            playerUpdated = true;
            console.log(`[Purchase] Updated inventory: ${playerAddress} → ${stringItemId}`);
          }
        }
      } catch (dbErr) {
        console.error(`[Purchase] Database update error:`, dbErr.message);
      }

      // Record transaction in MongoDB
      if (playerId) {
        try {
          await transactionService.recordTransaction({
            transactionHash: txHash,
            playerId,
            playerAddress,
            itemId: numericId,
            itemName: item.name,
            priceETH: blockchainService.fromWei(item.price),
            priceWei: item.price.toString(),
            status: "pending",
            chainId: 11155111,
            contractAddress: process.env.SMART_STORE_ADDRESS,
            methodName: "buyItem",
            type: "purchase",
            metadata: { stringItemId, source: "web-app", sessionId },
          });

          await transactionService.confirmTransaction(txHash, {
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed?.toString(),
            gasPrice: receipt.gasPrice?.toString(),
          });

          console.log(`[Purchase] Web tx recorded: ${txHash}`);
        } catch (txErr) {
          console.error(`[Purchase] Failed to record transaction:`, txErr.message);
        }
      }

      return res.json({
        success: true,
        message: "Transaction confirmed and item purchased via web app",
        status: "confirmed",
        txHash,
        blockNumber: receipt.blockNumber,
        itemId: numericId,
        stringItemId,
        itemName: item.name,
        playerAddress,
        playerInventoryUpdated: playerUpdated,
        explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}`,
      });
    } catch (err) {
      console.error("[Purchase] confirm-web-tx error:", err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
module.exports.updatePaymentIntent = updatePaymentIntent;