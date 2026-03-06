// routes/reward.js
// Reward Distribution Engine — verifies win and mints TTK via RewardEngine contract

const express = require("express");
const { body, validationResult } = require("express-validator");

const { Match, Transaction } = require("../models/Match");
const Player                 = require("../models/Player");
const authenticate           = require("../middleware/authenticate");
const blockchainService      = require("../services/blockchainService");

const router = express.Router();

/**
 * POST /api/reward/claim
 *
 * After a validated player win, Unity calls this to receive the TTK reward.
 * Backend:
 *   1. Confirms match is validated and unrewarded
 *   2. Confirms AI profile was used (anti-cheat final check)
 *   3. Calls RewardEngine.distributeReward() on Polygon Amoy
 *   4. Records tx hash in MongoDB
 *
 * Body: { matchId: string }
 */
router.post(
  "/claim",
  authenticate,
  [body("matchId").isString().notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const player = req.player;
      const { matchId } = req.body;

      // ── Fetch and validate match ───────────────────────────────────────────
      const match = await Match.findOne({ matchId, playerId: player._id });
      if (!match) {
        return res.status(404).json({ success: false, message: "Match not found" });
      }

      if (match.winner !== "player") {
        return res.status(400).json({ success: false, message: "Only winners can claim rewards" });
      }

      if (!match.validationPassed) {
        return res.status(400).json({ success: false, message: "Match failed anti-cheat validation" });
      }

      if (match.rewardTxHash) {
        return res.status(409).json({
          success: false,
          message: "Reward already claimed",
          txHash: match.rewardTxHash,
        });
      }

      // ── Confirm wallet is linked ───────────────────────────────────────────
      if (!player.walletAddress) {
        return res.status(400).json({ success: false, message: "No wallet address linked to player" });
      }

      // ── Anti-farming rate limit ────────────────────────────────────────────
      player.resetDailyRewardsIfNeeded();
      const maxPerDay = parseInt(process.env.MAX_REWARDS_PER_DAY) || 10;
      if (player.rewardsClaimedToday >= maxPerDay) {
        return res.status(429).json({
          success: false,
          message: "Daily reward limit reached",
        });
      }

      // ── Call RewardEngine on blockchain ───────────────────────────────────
      const { txHash, rewardAmount } = await blockchainService.distributeReward(
        player.walletAddress,
        matchId,
        match.aiProfile.difficulty
      );

      // ── Persist results ────────────────────────────────────────────────────
      match.rewardTxHash = txHash;
      match.rewardAmount = rewardAmount;
      await match.save();

      // Log transaction
      await Transaction.create({
        playerId:        player._id,
        txType:          "reward_mint",
        txHash,
        contractAddress: process.env.REWARD_ENGINE_ADDRESS,
        toAddress:       player.walletAddress,
        amountWei:       rewardAmount,
        status:          "confirmed",
        metadata:        { matchId, difficulty: match.aiProfile.difficulty },
      });

      // Update player stats
      player.rewardsClaimedToday++;
      const currentRewards = BigInt(player.stats.rewardsEarned || "0");
      player.stats.rewardsEarned = (currentRewards + BigInt(rewardAmount)).toString();
      await player.save();

      return res.json({
        success:    true,
        txHash,
        rewardAmount,
        difficulty: match.aiProfile.difficulty,
        message:    `Reward minted! TTK sent to ${player.walletAddress}`,
        explorerUrl: `https://amoy.polygonscan.com/tx/${txHash}`,
      });
    } catch (err) {
      console.error("Reward claim error:", err);
      return res.status(500).json({ success: false, message: "Reward distribution failed", error: err.message });
    }
  }
);

/**
 * GET /api/reward/history
 * Returns reward transaction history for the authenticated player.
 */
router.get("/history", authenticate, async (req, res) => {
  try {
    const txs = await Transaction.find({
      playerId: req.player._id,
      txType:   "reward_mint",
    }).sort({ createdAt: -1 }).limit(20);

    return res.json({ success: true, transactions: txs });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to fetch reward history" });
  }
});

module.exports = router;