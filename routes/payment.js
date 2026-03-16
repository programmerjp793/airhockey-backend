// routes/payment.js
// Native ETH only (Sepolia) - Simplified Purchase Flow
// No reward-related functionality, only item purchases via crypto

const express = require("express");
const { body, validationResult } = require("express-validator");

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

module.exports = router;
