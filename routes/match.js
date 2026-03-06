// routes/match.js
// ⭐ AUTHORITY LAYER — Creates official AI matches and assigns difficulty profiles

const express = require("express");
const crypto  = require("crypto");
const jwt     = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const { v4: uuidv4 } = require("uuid");

const { Match }   = require("../models/Match");
const Player      = require("../models/Player");
const authenticate = require("../middleware/authenticate");

const router = express.Router();

// AI Difficulty Profiles — defined SERVER-SIDE only (anti-farming)
const AI_PROFILES = {
  easy: {
    difficulty:    "easy",
    reactionSpeed: 0.60,
    errorMargin:   25,
    strategy:      "defensive",
  },
  medium: {
    difficulty:    "medium",
    reactionSpeed: 0.45,
    errorMargin:   15,
    strategy:      "balanced",
  },
  hard: {
    difficulty:    "hard",
    reactionSpeed: 0.35,
    errorMargin:   8,
    strategy:      "aggressive",
  },
  expert: {
    difficulty:    "expert",
    reactionSpeed: 0.20,
    errorMargin:   3,
    strategy:      "expert_adaptive",
  },
};

/**
 * POST /api/match/create
 *
 * Unity calls this to start an official AI reward match.
 * Backend assigns the AI profile and returns a signed match token.
 * Unity MUST use the returned AI profile — otherwise reward is denied.
 *
 * Body: { difficulty: "easy"|"medium"|"hard"|"expert" }
 */
router.post(
  "/create",
  authenticate,
  [body("difficulty").isIn(["easy","medium","hard","expert"])],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const player = req.player;

      // ── Anti-farming check ────────────────────────────────────────────────
      player.resetDailyRewardsIfNeeded();
      const maxPerDay = parseInt(process.env.MAX_REWARDS_PER_DAY) || 10;
      if (player.rewardsClaimedToday >= maxPerDay) {
        return res.status(429).json({
          success: false,
          message: `Daily reward limit reached (${maxPerDay}/day). Try again tomorrow.`,
        });
      }

      if (!player.walletAddress) {
        return res.status(400).json({
          success: false,
          message: "Wallet not linked. Link your MetaMask wallet to play for rewards.",
        });
      }

      // ── Assign AI Profile ─────────────────────────────────────────────────
      const profile     = AI_PROFILES[req.body.difficulty];
      const profileJson = JSON.stringify(profile);
      const profileHash = crypto.createHash("sha256").update(profileJson).digest("hex");

      // ── Create match record ───────────────────────────────────────────────
      const matchId    = uuidv4();
      const ttl        = parseInt(process.env.MATCH_TOKEN_TTL) || 3600;
      const expiry     = new Date(Date.now() + ttl * 1000);

      // Signed match token — Unity sends this back with result
      const matchToken = jwt.sign(
        { matchId, playerId: player._id.toString(), profileHash },
        process.env.JWT_SECRET,
        { expiresIn: ttl }
      );

      const match = await Match.create({
        matchId,
        playerId:          player._id,
        aiProfile: {
          ...profile,
          profileHash,
        },
        status:           "in_progress",
        matchToken,
        matchTokenExpiry: expiry,
      });

      // ── Return profile to Unity ───────────────────────────────────────────
      return res.status(201).json({
        success: true,
        matchId:    match.matchId,
        matchToken,
        aiProfile:  profile,   // Unity AI Engine applies these values
        expiresAt:  expiry,
      });
    } catch (err) {
      console.error("Match create error:", err);
      return res.status(500).json({ success: false, message: "Failed to create match" });
    }
  }
);

/**
 * POST /api/match/submit-result
 *
 * Unity calls this when match ends.
 * Backend validates the result before triggering reward.
 *
 * Body: {
 *   matchId: string,
 *   matchToken: string,
 *   winner: "player"|"ai",
 *   playerScore: number,
 *   aiScore: number,
 *   durationSecs: number,
 *   clientProfileHash: string   ← hash of the AI profile Unity actually used
 * }
 */
router.post(
  "/submit-result",
  authenticate,
  [
    body("matchId").isString().notEmpty(),
    body("matchToken").isString().notEmpty(),
    body("winner").isIn(["player","ai"]),
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
      if (match.status !== "in_progress") {
        return res.status(409).json({ success: false, message: "Match already submitted" });
      }

      // ── Validate match token ───────────────────────────────────────────────
      let tokenPayload;
      try {
        tokenPayload = jwt.verify(matchToken, process.env.JWT_SECRET);
      } catch (_e) {
        match.status = "suspicious";
        match.suspicionFlags.push("invalid_token");
        await match.save();
        return res.status(401).json({ success: false, message: "Invalid or expired match token" });
      }

      // ── Anti-cheat validations ─────────────────────────────────────────────
      const flags = [];

      // 1. Profile hash must match what backend assigned
      if (clientProfileHash !== match.aiProfile.profileHash) {
        flags.push("wrong_profile_hash");
      }

      // 2. Score sanity check (can't win 7-0 in under 30 seconds)
      const maxGoalRate = (Math.max(playerScore, aiScore)) / durationSecs;
      if (maxGoalRate > 0.3) flags.push("score_too_fast");

      // 3. Score must match winner
      if (winner === "player" && playerScore <= aiScore) flags.push("score_winner_mismatch");
      if (winner === "ai"     && aiScore <= playerScore)   flags.push("score_winner_mismatch");

      if (flags.length > 0) {
        match.status         = "suspicious";
        match.suspicionFlags = flags;
        match.clientReportedHash = clientProfileHash;
        await match.save();
        return res.status(422).json({
          success: false,
          message: "Match validation failed",
          flags,
        });
      }

      // ── Save result ────────────────────────────────────────────────────────
      match.status             = "completed";
      match.winner             = winner;
      match.playerScore        = playerScore;
      match.aiScore            = aiScore;
      match.durationSecs       = durationSecs;
      match.clientReportedHash = clientProfileHash;
      match.validationPassed   = true;
      await match.save();

      // Update player stats
      await Player.findByIdAndUpdate(req.player._id, {
        $inc: {
          "stats.totalMatches": 1,
          "stats.wins":   winner === "player" ? 1 : 0,
          "stats.losses": winner === "ai"     ? 1 : 0,
        },
      });

      return res.json({
        success: true,
        validated: true,
        winner,
        matchId,
        message: winner === "player"
          ? "Win validated! Call /api/reward/claim to receive your TTK."
          : "Match recorded. Better luck next time!",
      });
    } catch (err) {
      console.error("Submit result error:", err);
      return res.status(500).json({ success: false, message: "Failed to submit result" });
    }
  }
);

/**
 * GET /api/match/history
 * Returns the authenticated player's match history.
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

module.exports = router;