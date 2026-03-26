// routes/auth.js
// Balance sync additions (see previous update for full context):
//   • wallet-login and unity-login now call tryLiveBalanceRefresh() and
//     include cachedEthBalance / cachedEthBalanceWei in the response so
//     Unity can populate the balance UI instantly on re-login without
//     waiting for a separate /wallet/balance call.
//   • link-wallet calls tryLiveBalanceRefresh() after linking so the
//     player document has a balance from the moment the wallet is attached.

const express = require("express");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");

const Player = require("../models/Player");
const { verifyUnityToken } = require("../services/unityAuthService");
const { authLimiter } = require("../middleware/rateLimiter");
const { refreshAndCacheBalance } = require("./wallet");

const router = express.Router();

// ─── Shared helper ────────────────────────────────────────────────────────────
/**
 * Attempts a live ETH balance fetch + cache for the given player document.
 * Returns the formatted balance string on success, or the last cached value
 * on any RPC failure. Never throws.
 */
async function tryLiveBalanceRefresh(player) {
  if (!player.walletAddress) return player.cachedEthBalance || "0.0000";
  try {
    const info = await refreshAndCacheBalance(player.walletAddress, player);
    return info.ethBalance;
  } catch (err) {
    console.warn(`[Auth] Live balance refresh failed for ${player.walletAddress}:`, err.message);
    return player.cachedEthBalance || "0.0000";
  }
}

// ─── POST /api/auth/unity-login ───────────────────────────────────────────────
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

      // If this Unity identity has a linked wallet, refresh its balance now
      // so the login response carries the freshest possible value.
      const ethBalance = await tryLiveBalanceRefresh(player);

      const jwtPayload = {
        playerId: player._id.toString(),
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
          id: player._id,
          unityPlayerId: player.unityPlayerId,
          username: player.username,
          walletAddress: player.walletAddress,
          stats: player.stats,
          ownedItems: player.ownedItems,
          // Balance fields — Unity reads these to populate the wallet UI immediately
          cachedEthBalance: ethBalance,
          cachedEthBalanceWei: player.cachedEthBalanceWei || "0",
          ethBalanceFetchedAt: player.ethBalanceFetchedAt,
        },
      });
    } catch (err) {
      console.error("Unity login error:", err.message);
      return res.status(500).json({ success: false, message: "Authentication failed" });
    }
  }
);

// ─── POST /api/auth/wallet-login ──────────────────────────────────────────────
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
          walletLinkedAt: new Date(),
        });
        console.log(`🆕 New wallet player: ${address}`);
      }

      player.lastSeenAt = new Date();
      await player.save();

      // Fetch live balance and cache it in the player document so that:
      //   1. The response includes the current balance for immediate UI display.
      //   2. The cached value is available on future cold-start logins even if
      //      the Sepolia RPC is temporarily unavailable.
      const ethBalance = await tryLiveBalanceRefresh(player);

      const token = jwt.sign(
        { playerId: player._id.toString(), walletAddress: address },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
      );

      return res.status(200).json({
        success: true,
        token,
        player: {
          id: player._id,
          username: player.username,
          walletAddress: player.walletAddress,
          stats: player.stats,
          ownedItems: player.ownedItems,
          cachedEthBalance: ethBalance,
          cachedEthBalanceWei: player.cachedEthBalanceWei || "0",
          ethBalanceFetchedAt: player.ethBalanceFetchedAt,
        },
      });
    } catch (err) {
      console.error("Wallet login error:", err.message);
      return res.status(500).json({ success: false, message: "Authentication failed" });
    }
  }
);

// ─── POST /api/auth/link-wallet ───────────────────────────────────────────────
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

      // Verify the wallet signature to prove ownership
      const recoveredAddress = ethers.verifyMessage(message, signature);
      if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        return res.status(401).json({ success: false, message: "Signature mismatch" });
      }

      // Ensure the wallet isn't already claimed by a different account
      const existing = await Player.findOne({
        walletAddress: walletAddress.toLowerCase(),
        _id: { $ne: req.player._id },
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          message: "Wallet already linked to another account",
        });
      }

      // Use { new: true } so we get the updated document back for the balance fetch
      const player = await Player.findByIdAndUpdate(
        req.player._id,
        {
          walletAddress: walletAddress.toLowerCase(),
          walletLinkedAt: new Date(),
        },
        { new: true }
      );

      // Fetch and cache the live balance now that the wallet is linked so the
      // next login response and /wallet/balance call return a real value.
      const ethBalance = await tryLiveBalanceRefresh(player);

      console.log(`[Auth] Wallet linked: ${player.unityPlayerId} → ${walletAddress} (balance: ${ethBalance} ETH)`);

      return res.json({
        success: true,
        message: "Wallet linked successfully",
        cachedEthBalance: ethBalance,
        cachedEthBalanceWei: player.cachedEthBalanceWei || "0",
      });
    } catch (err) {
      console.error("Wallet link error:", err);
      return res.status(500).json({ success: false, message: "Failed to link wallet" });
    }
  }
);

module.exports = router;