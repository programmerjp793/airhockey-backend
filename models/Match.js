// models/Match.js
// MongoDB schema for an AI reward match.
// Tracks the full lifecycle: create → play → submit → validate → reward.

const mongoose = require('mongoose');

// ─── AI Profile Sub-Schema ────────────────────────────────────────────────────
const AIProfileSchema = new mongoose.Schema({
  difficulty:    { type: String, enum: ['easy', 'medium', 'hard', 'expert'], default: 'medium' },
  reactionSpeed: { type: Number, min: 0, max: 1, default: 0.5 },
  errorMargin:   { type: Number, min: 0, max: 1, default: 0.3 },
  strategy:      { type: String, enum: ['aggressive', 'defensive', 'balanced', 'adaptive'], default: 'balanced' },
  profileHash:   { type: String, default: '' },
}, { _id: false });

// ─── Suspicion Flag Sub-Schema ────────────────────────────────────────────────
const SuspicionFlagSchema = new mongoose.Schema({
  type:      { type: String },
  detail:    { type: String },
  flaggedAt: { type: Date, default: () => new Date() },
}, { _id: false });

// ─── Match Schema ─────────────────────────────────────────────────────────────
const MatchSchema = new mongoose.Schema({

  // ─── Identity ───────────────────────────────────────────────────────────────
  matchId: {
    type:     String,
    required: true,
    unique:   true,        // ← removed index:true (schema.index() below handles it)
  },

  playerId: {
    type:  mongoose.Schema.Types.ObjectId,
    ref:   'Player',
    index: true,           // ← kept — this one is NOT duplicated below
  },

  unityPlayerId: {
    type:  String,
    index: true,           // ← kept — this one is NOT duplicated below
  },

  // ─── AI Profile ─────────────────────────────────────────────────────────────
  aiProfile: {
    type:    AIProfileSchema,
    default: () => ({}),
  },

  // ─── Match Token ────────────────────────────────────────────────────────────
  matchToken: {
    type:     String,
    required: true,
  },

  // ─── Status ─────────────────────────────────────────────────────────────────
  status: {
    type:    String,
    enum:    ['pending', 'active', 'submitted', 'validated', 'rewarded', 'failed', 'suspicious'],
    default: 'pending',
    index:   true,         // ← kept — this one is NOT duplicated below
  },

  // ─── Scores ─────────────────────────────────────────────────────────────────
  playerScore: { type: Number, default: 0 },
  aiScore:     { type: Number, default: 0 },

  winner: {
    type: String,
    enum: ['player', 'ai', null],
    default: null,
  },

  // ─── Validation ─────────────────────────────────────────────────────────────
  validationPassed:     { type: Boolean, default: false },
  submittedProfileHash: { type: String,  default: '' },

  // ─── Anti-Cheat Flags ────────────────────────────────────────────────────────
  suspicionFlags: {
    type:    [SuspicionFlagSchema],
    default: [],
  },

  isFlagged: {
    type:    Boolean,
    default: false,        // ← removed index:true (schema.index() below handles it)
  },

  // ─── Blockchain / Reward ─────────────────────────────────────────────────────
  rewardAmount:    { type: String, default: '0' },
  rewardTxHash:    { type: String, default: null },
  rewardClaimedAt: { type: Date,   default: null },

  // ─── Timing ──────────────────────────────────────────────────────────────────
  startedAt:          { type: Date,   default: () => new Date() },
  submittedAt:        { type: Date,   default: null },
  completedAt:        { type: Date,   default: null },
  maxDurationSeconds: { type: Number, default: 600 },

  // ─── Metadata ────────────────────────────────────────────────────────────────
  difficulty: {
    type:    String,
    default: 'medium',
  },

}, {
  timestamps: false,
  versionKey: false,
});

// ─── Indexes (defined once here only) ────────────────────────────────────────
MatchSchema.index({ matchId: 1 });
MatchSchema.index({ playerId: 1, status: 1 });
MatchSchema.index({ unityPlayerId: 1, startedAt: -1 });
MatchSchema.index({ isFlagged: 1 });

// ─── Instance Methods ─────────────────────────────────────────────────────────

MatchSchema.methods.addSuspicionFlag = function (type, detail) {
  this.suspicionFlags.push({ type, detail });
  this.isFlagged = true;
  this.status    = 'suspicious';
};

MatchSchema.methods.getDurationSeconds = function () {
  const end   = this.submittedAt || new Date();
  const start = this.startedAt;
  return Math.floor((end - start) / 1000);
};

module.exports = mongoose.model('Match', MatchSchema);