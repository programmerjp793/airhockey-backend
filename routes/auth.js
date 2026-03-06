// routes/auth.js
// Handles Unity Authentication → Node.js player identity

const express = require("express");
const jwt     = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");

const Player      = require("../models/Player");
const { verifyUnityToken } = require("../services/unityAuthService");
const { authLimiter }      = require("../middleware/rateLimiter");

const router = express.Router();

/**
 * POST /api/auth/unity-login
 *
 * Unity sends the player's Unity Authentication token.
 * Backend verifies it with Unity Gaming Services, then:
 *   - Creates player record in MongoDB if first time
 *   - Returns a JWT for subsequent API calls
 *
 * Body: { unityToken: string, username?: string }
 */
router.post(
  "/unity-login",
  authLimiter,
  [
    body("unityToken").isString().notEmpty().withMessage("Unity token required"),
    body("username").optional().isLength({ min: 3, max: 30 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { unityToken, username } = req.body;

      // ── Step 1: Verify Unity token with UGS ────────────────────────────────
      const unityPayload = await verifyUnityToken(unityToken);
      // unityPayload = { playerId: "...", projectId: "...", ... }

      if (!unityPayload || !unityPayload.sub) {
        return res.status(401).json({ success: false, message: "Invalid Unity token" });
      }

      const unityPlayerId = unityPayload.sub;

      // ── Step 2: Upsert player in MongoDB ───────────────────────────────────
      let player = await Player.findOne({ unityPlayerId });

      if (!player) {
        // First login — create player record
        player = await Player.create({
          unityPlayerId,
          username: username || `Player_${unityPlayerId.slice(0, 8)}`,
        });
        console.log(`🆕 New player registered: ${player.unityPlayerId}`);
      }

      if (!player.isActive) {
        return res.status(403).json({ success: false, message: "Account suspended" });
      }

      // ── Step 3: Issue JWT ──────────────────────────────────────────────────
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
 * POST /api/auth/link-wallet
 *
 * Links a MetaMask wallet address to the player's profile.
 * Unity calls this after the player connects MetaMask.
 *
 * Body: { walletAddress: string, signature: string, message: string }
 */
router.post(
  "/link-wallet",
  [
    body("walletAddress").isEthereumAddress().withMessage("Invalid wallet address"),
    body("signature").isString().notEmpty(),
    body("message").isString().notEmpty(),
  ],
  require("../middleware/authenticate"),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { walletAddress, signature, message } = req.body;
      const { ethers } = require("ethers");

      // Verify the player actually owns this wallet (signature check)
      const recoveredAddress = ethers.verifyMessage(message, signature);
      if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        return res.status(401).json({ success: false, message: "Signature mismatch" });
      }

      // Check wallet not already used by another player
      const existing = await Player.findOne({
        walletAddress: walletAddress.toLowerCase(),
        _id: { $ne: req.player._id },
      });
      if (existing) {
        return res.status(409).json({ success: false, message: "Wallet already linked to another account" });
      }

      await Player.findByIdAndUpdate(req.player._id, {
        walletAddress: walletAddress.toLowerCase(),
      });

      return res.json({ success: true, message: "Wallet linked successfully" });
    } catch (err) {
      console.error("Wallet link error:", err);
      return res.status(500).json({ success: false, message: "Failed to link wallet" });
    }
  }
);

module.exports = router;