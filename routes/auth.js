// routes/auth.js
const express = require("express");
const jwt     = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");

const Player      = require("../models/Player");
const { verifyUnityToken } = require("../services/unityAuthService");
const { authLimiter }      = require("../middleware/rateLimiter");

const router = express.Router();

/**
 * POST /api/auth/unity-login
 * Body: { unityToken: string, unityPlayerId: string, username?: string }
 */
router.post(
  "/unity-login",
  authLimiter,
  [
    body("unityToken").isString().notEmpty().withMessage("Unity token required"),
    body("unityPlayerId").isString().notEmpty().withMessage("Unity player ID required"),
    body("username").optional().isLength({ min: 3, max: 30 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { unityToken, unityPlayerId, username } = req.body;

      const unityPayload = await verifyUnityToken(unityToken, unityPlayerId);

      if (!unityPayload || !unityPayload.sub) {
        return res.status(401).json({ success: false, message: "Invalid Unity token" });
      }

      const verifiedPlayerId = unityPayload.sub;

      let player = await Player.findOne({ unityPlayerId: verifiedPlayerId });

      if (!player) {
        player = await Player.create({
          unityPlayerId: verifiedPlayerId,
          username: username || `Player_${verifiedPlayerId.slice(0, 8)}`,
        });
        console.log(`🆕 New player registered: ${player.unityPlayerId}`);
      }

      player.lastSeenAt = new Date();
      await player.save();

      const jwtPayload = {
        playerId:      player._id.toString(),
        unityPlayerId: player.unityPlayerId,
        walletAddress: player.walletAddress || null,
      };

      const token = jwt.sign(jwtPayload, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || "7d",
      });

      return res.status(200).json({
        success: true,
        token,
        player: {
          id:            player._id,
          unityPlayerId: player.unityPlayerId,
          username:      player.username,
          walletAddress: player.walletAddress,
          stats:         player.stats,
          ownedItems:    player.ownedItems,
        },
      });
    } catch (err) {
      console.error("Unity login error:", err.message);
      return res.status(500).json({ success: false, message: "Authentication failed" });
    }
  }
);

/**
 * POST /api/auth/wallet-login
 * Body: { walletAddress: string }
 */
router.post(
  "/wallet-login",
  authLimiter,
  [
    body("walletAddress").isEthereumAddress().withMessage("Invalid wallet address"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { walletAddress } = req.body;
      const address = walletAddress.toLowerCase();

      let player = await Player.findOne({ walletAddress: address });

      if (!player) {
        player = await Player.create({
          walletAddress: address,
          username: `Player_${address.slice(2, 8)}`,
          unityPlayerId: address,
        });
        console.log(`🆕 New wallet player: ${address}`);
      }

      player.lastSeenAt = new Date();
      await player.save();

      const token = jwt.sign(
        { playerId: player._id.toString(), walletAddress: address },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
      );

      return res.status(200).json({
        success: true,
        token,
        player: {
          id:            player._id,
          username:      player.username,
          walletAddress: player.walletAddress,
          stats:         player.stats,
          ownedItems:    player.ownedItems,
        },
      });
    } catch (err) {
      console.error("Wallet login error:", err.message);
      return res.status(500).json({ success: false, message: "Authentication failed" });
    }
  }
);

/**
 * POST /api/auth/link-wallet
 * Body: { walletAddress: string, signature: string, message: string }
 */
router.post(
  "/link-wallet",
  require("../middleware/authenticate"),
  [
    body("walletAddress").isEthereumAddress().withMessage("Invalid wallet address"),
    body("signature").isString().notEmpty(),
    body("message").isString().notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { walletAddress, signature, message } = req.body;
      const { ethers } = require("ethers");

      const recoveredAddress = ethers.verifyMessage(message, signature);
      if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        return res.status(401).json({ success: false, message: "Signature mismatch" });
      }

      const existing = await Player.findOne({
        walletAddress: walletAddress.toLowerCase(),
        _id: { $ne: req.player._id },
      });
      if (existing) {
        return res.status(409).json({ success: false, message: "Wallet already linked to another account" });
      }

      await Player.findByIdAndUpdate(req.player._id, {
        walletAddress: walletAddress.toLowerCase(),
        walletLinkedAt: new Date(),
      });

      return res.json({ success: true, message: "Wallet linked successfully" });
    } catch (err) {
      console.error("Wallet link error:", err);
      return res.status(500).json({ success: false, message: "Failed to link wallet" });
    }
  }
);

module.exports = router;