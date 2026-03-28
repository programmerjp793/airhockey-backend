// routes/match.js
// Native ETH only (Sepolia Testnet)
//
// Changes from existing:
//   • "TTK" in reward message → "ETH"
//   • explorerUrl: amoy.polygonscan → sepolia.etherscan (via reward.js — match.js
//     itself doesn't build explorer URLs, so this file has minimal changes)
//   • Kept: all anti-cheat logic, match token JWT, /create, /submit-result,
//           /save, /history — unchanged

const express = require("express");
const crypto  = require("crypto");
const jwt     = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const { v4: uuidv4 } = require("uuid");

const Match        = require("../models/Match");
const Player       = require("../models/Player");
const authenticate = require("../middleware/authenticate");

const router = express.Router();

// AI Difficulty Profiles — server-side only (anti-farming)
const AI_PROFILES = {
  easy:   { difficulty: "easy",   reactionSpeed: 0.60, errorMargin: 25, strategy: "defensive"      },
  medium: { difficulty: "medium", reactionSpeed: 0.45, errorMargin: 15, strategy: "balanced"        },
  hard:   { difficulty: "hard",   reactionSpeed: 0.35, errorMargin:  8, strategy: "aggressive"      },
  expert: { difficulty: "expert", reactionSpeed: 0.20, errorMargin:  3, strategy: "expert_adaptive" },
};

/**
 * POST /api/match/create
 * Unity calls this to start an official AI reward match.
 * Body: { difficulty: "easy"|"medium"|"hard"|"expert" }
 */
router.post(
  "/create",
  authenticate,
  [body("difficulty").isIn(["easy", "medium", "hard", "expert"])],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const player = req.player;

      const playerDoc = await Player.findById(player._id);
      if (playerDoc.resetDailyRewardsIfNeeded) playerDoc.resetDailyRewardsIfNeeded();

      const maxPerDay = parseInt(process.env.MAX_REWARDS_PER_DAY) || 10;
      if (playerDoc.rewardsClaimedToday >= maxPerDay) {
        return res.status(429).json({
          success: false,
          message: `Daily reward limit reached (${maxPerDay}/day). Try again tomorrow.`,
        });
      }

      if (!player.walletAddress) {
        return res.status(400).json({
          success: false,
          message: "Wallet not linked. Connect MetaMask to play for rewards.",
        });
      }

      const profile     = AI_PROFILES[req.body.difficulty];
      const profileJson = JSON.stringify(profile);
      const profileHash = crypto.createHash("sha256").update(profileJson).digest("hex");

      const matchId = uuidv4();
      const ttl     = parseInt(process.env.MATCH_TOKEN_TTL) || 3600;
      const expiry  = new Date(Date.now() + ttl * 1000);

      const matchToken = jwt.sign(
        { matchId, playerId: player._id.toString(), profileHash },
        process.env.JWT_SECRET,
        { expiresIn: ttl }
      );

      const match = await Match.create({
        matchId,
        playerId: player._id,
        aiProfile: { ...profile, profileHash },
        status:           "in_progress",
        matchToken,
        matchTokenExpiry: expiry,
      });

      return res.status(201).json({
        success:   true,
        matchId:   match.matchId,
        matchToken,
        aiProfile: profile,
        expiresAt: expiry,
      });
    } catch (err) {
      console.error("Match create error:", err);
      return res.status(500).json({ success: false, message: "Failed to create match" });
    }
  }
);

/**
 * POST /api/match/submit-result
 * Unity calls this when match ends. Full anti-cheat validation before reward.
 * Body: { matchId, matchToken, winner, playerScore, aiScore, durationSecs, clientProfileHash }
 */
router.post(
  "/submit-result",
  authenticate,
  [
    body("matchId").isString().notEmpty(),
    body("matchToken").isString().notEmpty(),
    body("winner").isIn(["player", "ai"]),
    body("playerScore").isInt({ min: 0, max: 20 }),
    body("aiScore").isInt({ min: 0, max: 20 }),
    body("durationSecs").isInt({ min: 10, max: 3600 }),
    body("clientProfileHash").isString().notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const {
        matchId, matchToken, winner,
        playerScore, aiScore, durationSecs, clientProfileHash,
      } = req.body;

      const match = await Match.findOne({ matchId, playerId: req.player._id });
      if (!match) return res.status(404).json({ success: false, message: "Match not found" });
      if (match.status !== "in_progress")
        return res.status(409).json({ success: false, message: "Match already submitted" });

      // Validate match token
      let tokenPayload;
      try {
        tokenPayload = jwt.verify(matchToken, process.env.JWT_SECRET);
      } catch (_e) {
        match.status = "suspicious";
        match.suspicionFlags.push("invalid_token");
        await match.save();
        return res.status(401).json({ success: false, message: "Invalid or expired match token" });
      }

      // Anti-cheat checks
      const flags = [];
      if (clientProfileHash !== match.aiProfile.profileHash) flags.push("wrong_profile_hash");
      const maxGoalRate = Math.max(playerScore, aiScore) / durationSecs;
      if (maxGoalRate > 0.3) flags.push("score_too_fast");
      if (winner === "player" && playerScore <= aiScore) flags.push("score_winner_mismatch");
      if (winner === "ai"     && aiScore <= playerScore) flags.push("score_winner_mismatch");

      if (flags.length > 0) {
        match.status             = "suspicious";
        match.suspicionFlags     = flags;
        match.clientReportedHash = clientProfileHash;
        await match.save();
        return res.status(422).json({ success: false, message: "Match validation failed", flags });
      }

      match.status             = "completed";
      match.winner             = winner;
      match.playerScore        = playerScore;
      match.aiScore            = aiScore;
      match.durationSecs       = durationSecs;
      match.clientReportedHash = clientProfileHash;
      match.validationPassed   = true;
      await match.save();

      await Player.findByIdAndUpdate(req.player._id, {
        $inc: {
          "stats.totalMatches": 1,
          "stats.wins":   winner === "player" ? 1 : 0,
          "stats.losses": winner === "ai"     ? 1 : 0,
        },
      });

      // ─── Personal Best Time ─────────────────────────────────────────────────
      if (winner === "player") {
        const playerDoc = await Player.findById(req.player._id);
        if (playerDoc.bestTime === null || playerDoc.bestTime === undefined || durationSecs < playerDoc.bestTime) {
          playerDoc.bestTime = durationSecs;
          playerDoc.bestTimeMatchId = matchId;
          await playerDoc.save();
          console.log(`[Match] New personal best: ${durationSecs}s for player ${req.player._id}`);
        }
      }

      return res.json({
        success:   true,
        validated: true,
        winner,
        matchId,
        // FIX: was "TTK" — updated to "ETH"
        message: winner === "player"
          ? "Win validated! Call /api/reward/claim to receive your ETH reward."
          : "Match recorded. Better luck next time!",
      });
    } catch (err) {
      console.error("Submit result error:", err);
      return res.status(500).json({ success: false, message: "Failed to submit result" });
    }
  }
);

/**
 * POST /api/match/save
 * Simplified save — called by Unity GameManager on match end.
 * Body: { matchId, playerScore, opponentScore, winner, durationSeconds,
 *         walletAddress, aiDifficulty, validationPassed }
 */
router.post("/save", authenticate, async (req, res) => {
  try {
    const {
      matchId, playerScore, opponentScore,
      winner, durationSeconds, walletAddress,
      aiDifficulty, validationPassed,
    } = req.body;

    const player = req.player;

    const existing = await Match.findOne({ matchId });
    if (existing) {
      return res.json({ success: true, matchId: existing.matchId, message: "Match already saved" });
    }

    const match = await Match.create({
      matchId,
      playerId:         player._id,
      playerScore,
      opponentScore,
      winner,
      durationSecs:     durationSeconds,
      walletAddress:    walletAddress || player.walletAddress,
      validationPassed: validationPassed || false,
      status:           "completed",
      aiProfile:        { difficulty: aiDifficulty || "medium" },
    });

    const statsUpdate = winner === "player"
      ? { $inc: { "stats.wins": 1,   "stats.totalMatches": 1 } }
      : winner === "tie"
      ? { $inc: { "stats.ties": 1,   "stats.totalMatches": 1 } }
      : { $inc: { "stats.losses": 1, "stats.totalMatches": 1 } };

    await Player.findByIdAndUpdate(player._id, statsUpdate);

    // ─── Personal Best Time ─────────────────────────────────────────────────
    if (winner === "player" && durationSeconds > 0) {
      const playerDoc = await Player.findById(player._id);
      if (playerDoc.bestTime === null || playerDoc.bestTime === undefined || durationSeconds < playerDoc.bestTime) {
        playerDoc.bestTime = durationSeconds;
        playerDoc.bestTimeMatchId = matchId;
        await playerDoc.save();
        console.log(`[Match] New personal best: ${durationSeconds}s for player ${player._id}`);
      }
    }

    return res.json({ success: true, matchId: match.matchId, message: "Match saved" });
  } catch (err) {
    console.error("[Match] Save error:", err);
    return res.status(500).json({ success: false, message: "Failed to save match", error: err.message });
  }
});

/**
 * GET /api/match/history
 */
router.get("/history", authenticate, async (req, res) => {
  try {
    const matches = await Match.find({ playerId: req.player._id })
      .select("-matchToken -aiProfile.profileHash")
      .sort({ createdAt: -1 })
      .limit(20);

    return res.json({ success: true, matches });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to fetch history" });
  }
});
/**
 * GET /api/match/highscores
 * Returns the player's top 10 personal best wins sorted by fastest time.
 */
router.get("/highscores", authenticate, async (req, res) => {
  try {
    const matches = await Match.find({
      playerId: req.player._id,
      winner: "player",
      status: { $in: ["completed", "rewarded", "validated"] },
      durationSecs: { $gt: 0 },
    })
      .select("matchId playerScore aiScore opponentScore durationSecs startedAt difficulty")
      .sort({ durationSecs: 1 })   // fastest first
      .limit(10);

    const highscores = matches.map((m, i) => ({
      rank: i + 1,
      matchId: m.matchId,
      difficulty: m.difficulty || m.aiProfile?.difficulty || "medium",
      playerScore: m.playerScore,
      opponentScore: m.aiScore || m.opponentScore || 0,
      durationSecs: m.durationSecs,
      startedAt: m.startedAt,
    }));

    // Include personal best from player profile
    const player = await Player.findById(req.player._id).select("bestTime bestTimeMatchId");

    return res.json({
      success: true,
      bestTime: player?.bestTime || 0,
      bestTimeMatchId: player?.bestTimeMatchId || "",
      highscores,
    });
  } catch (err) {
    console.error("[Match] Highscores error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch highscores" });
  }
});

module.exports = router;