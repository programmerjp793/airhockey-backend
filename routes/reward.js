// routes/reward.js
// Native ETH only (Sepolia Testnet)
//
// Changes from existing:
//   • blockchainService.distributeReward()  → blockchainService.rewardPlayer()
//   • amoy.polygonscan.com                  → sepolia.etherscan.io
//   • "TTK sent to"                         → "ETH sent to"
//   • Added GET /player/:address            → Unity calls this to get ETH balance + tier
//   • Kept: all anti-farming logic, match validation, transaction logging

const express = require("express");
const { body, validationResult } = require("express-validator");

const { Match, Transaction } = require("../models/Match");
const Player                 = require("../models/Player");
const authenticate           = require("../middleware/authenticate");
const blockchainService      = require("../services/blockchainService");

const router = express.Router();

const EXPLORER = "https://sepolia.etherscan.io";

/**
 * POST /api/reward/claim
 * Body: { matchId?, matchResult?, playerScore?, opponentScore?, walletAddress? }
 */
router.post("/claim", authenticate, async (req, res) => {
  try {
    const player = req.player;
    const { matchId, matchResult, playerScore, opponentScore, walletAddress } = req.body;

    // ── Determine wallet address ───────────────────────────────────────────
    const rewardWallet = walletAddress?.toLowerCase()
                      || player.walletAddress?.toLowerCase();

    if (!rewardWallet) {
      return res.status(400).json({
        success: false,
        message: "No wallet address linked. Connect MetaMask first.",
      });
    }

    // ── Verify it's a win ──────────────────────────────────────────────────
    const isWin = matchResult === "win"
               || (playerScore !== undefined && opponentScore !== undefined
                   && playerScore > opponentScore);

    if (!isWin) {
      return res.status(400).json({ success: false, message: "Only winners can claim rewards" });
    }

    // ── If matchId provided, validate against DB ───────────────────────────
    if (matchId) {
      const match = await Match.findOne({ matchId, playerId: player._id });

      if (!match) return res.status(404).json({ success: false, message: "Match not found" });
      if (match.winner !== "player")
        return res.status(400).json({ success: false, message: "Only winners can claim rewards" });
      if (!match.validationPassed)
        return res.status(400).json({ success: false, message: "Match failed anti-cheat validation" });
      if (match.rewardTxHash)
        return res.status(409).json({
          success: false, message: "Reward already claimed", txHash: match.rewardTxHash,
        });
    }

    // ── Anti-farming rate limit ────────────────────────────────────────────
    const playerDoc = await Player.findById(player._id);
    if (playerDoc.resetDailyRewardsIfNeeded) playerDoc.resetDailyRewardsIfNeeded();

    const maxPerDay = parseInt(process.env.MAX_REWARDS_PER_DAY) || 10;
    if (playerDoc.rewardsClaimedToday >= maxPerDay) {
      return res.status(429).json({
        success: false,
        message: `Daily reward limit reached (${maxPerDay}/day)`,
      });
    }

    // ── Call RewardEngine on blockchain ───────────────────────────────────
    // FIX: was blockchainService.distributeReward() — renamed to rewardPlayer()
    const difficulty = "medium";
    const { txHash, rewardAmount } = await blockchainService.rewardPlayer(
      rewardWallet,
      matchId || `direct_${Date.now()}`,
      difficulty
    );

    // ── Update match if matchId provided ──────────────────────────────────
    if (matchId) {
      await Match.findOneAndUpdate(
        { matchId, playerId: player._id },
        { rewardTxHash: txHash, rewardAmount }
      );
    }

    // ── Log transaction ────────────────────────────────────────────────────
    await Transaction.create({
      playerId:        player._id,
      txType:          "reward_mint",
      txHash,
      contractAddress: process.env.REWARD_ENGINE_ADDRESS,
      toAddress:       rewardWallet,
      amountWei:       rewardAmount,
      status:          "confirmed",
      metadata:        { matchId, difficulty, playerScore, opponentScore },
    });

    // ── Update player stats ────────────────────────────────────────────────
    playerDoc.rewardsClaimedToday++;
    const currentRewards = BigInt(playerDoc.stats?.rewardsEarned || "0");
    playerDoc.stats.rewardsEarned = (currentRewards + BigInt(rewardAmount)).toString();
    await playerDoc.save();

    return res.json({
      success:     true,
      txHash,
      rewardAmount,
      difficulty,
      message:     `ETH reward sent to ${rewardWallet}`,  // was "TTK sent to"
      explorerUrl: `${EXPLORER}/tx/${txHash}`,             // was amoy.polygonscan.com
    });

  } catch (err) {
    console.error("Reward claim error:", err);
    return res.status(500).json({
      success: false,
      message: "Reward distribution failed",
      error:   err.message,
    });
  }
});

/**
 * GET /api/reward/player/:address
 * NEW — Unity WalletManager calls this via RefreshPlayerInfo().
 * Returns ETH balance + wallet tier from blockchainService.getPlayerInfo().
 */
router.get("/player/:address", async (req, res) => {
  try {
    const { address } = req.params;

    if (!address || !address.startsWith("0x")) {
      return res.status(400).json({ success: false, message: "Invalid wallet address" });
    }

    // getPlayerInfo returns { address, ethBalance, tier, ownedItemIds }
    const info = await blockchainService.getPlayerInfo(address.toLowerCase());

    return res.json({
      success:    true,
      address:    info.address,
      ethBalance: info.ethBalance,  // formatted ETH string e.g. "0.0250"
      tier:       info.tier,
    });

  } catch (err) {
    console.error("[Reward] /player/:address error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to fetch player info" });
  }
});

/**
 * GET /api/reward/history
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