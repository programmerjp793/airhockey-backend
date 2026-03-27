// models/Match.js
const mongoose = require('mongoose');

// ─── AI Profile Sub-Schema ────────────────────────────────────────────────────
const AIProfileSchema = new mongoose.Schema({
  difficulty: { type: String, enum: ['easy', 'medium', 'hard', 'expert'], default: 'medium' },
  reactionSpeed: { type: Number, min: 0, max: 1, default: 0.5 },
  errorMargin: { type: Number, min: 0, max: 100, default: 0.3 },
  strategy: { type: String, enum: ['aggressive', 'defensive', 'balanced', 'adaptive', 'expert_adaptive'], default: 'balanced' },
  profileHash: { type: String, default: '' },
}, { _id: false });

// ─── Suspicion Flag Sub-Schema ────────────────────────────────────────────────
const SuspicionFlagSchema = new mongoose.Schema({
  type: { type: String },
  detail: { type: String },
  flaggedAt: { type: Date, default: () => new Date() },
}, { _id: false });

// ─── Match Schema ─────────────────────────────────────────────────────────────
const MatchSchema = new mongoose.Schema({

  matchId: { type: String, required: true, unique: true },
  playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', index: true },
  unityPlayerId: { type: String, index: true },
  aiProfile: { type: AIProfileSchema, default: () => ({}) },
  matchToken: { type: String, required: false, default: null },

  status: {
    type: String,
    enum: ['pending', 'active', 'in_progress', 'submitted', 'validated', 'completed', 'rewarded', 'failed', 'suspicious'],
    default: 'pending',
    index: true,
  },

  playerScore: { type: Number, default: 0 },
  aiScore: { type: Number, default: 0 },
  opponentScore: { type: Number, default: 0 },

  winner: {
    type: String,
    enum: ['player', 'ai', 'opponent', 'tie', null],
    default: null,
  },

  validationPassed: { type: Boolean, default: false },
  submittedProfileHash: { type: String, default: '' },
  clientReportedHash: { type: String, default: '' },

  suspicionFlags: { type: [SuspicionFlagSchema], default: [] },
  isFlagged: { type: Boolean, default: false },

  rewardAmount: { type: String, default: '0' },
  rewardTxHash: { type: String, default: null },
  rewardClaimedAt: { type: Date, default: null },

  startedAt: { type: Date, default: () => new Date() },
  submittedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  durationSecs: { type: Number, default: 0 },
  maxDurationSeconds: { type: Number, default: 600 },

  walletAddress: { type: String, default: null },
  difficulty: { type: String, default: 'medium' },

}, { timestamps: false, versionKey: false });

// ─── Indexes ──────────────────────────────────────────────────────────────────
MatchSchema.index({ matchId: 1 });
MatchSchema.index({ playerId: 1, status: 1 });
MatchSchema.index({ unityPlayerId: 1, startedAt: -1 });
MatchSchema.index({ isFlagged: 1 });

// ─── Instance Methods ─────────────────────────────────────────────────────────
MatchSchema.methods.addSuspicionFlag = function (type, detail) {
  this.suspicionFlags.push({ type, detail });
  this.isFlagged = true;
  this.status = 'suspicious';
};

MatchSchema.methods.getDurationSeconds = function () {
  const end = this.submittedAt || new Date();
  const start = this.startedAt;
  return Math.floor((end - start) / 1000);
};

// ─── Export ───────────────────────────────────────────────────────────────────
// NOTE: The Transaction model was removed from this file.
// It was causing OverwriteModelError because models/Transaction.js already
// registers mongoose.model('Transaction', ...) and is loaded first via
// services/transactionService.js.  Any code that needs the Transaction model
// should require it directly:
//
//   const Transaction = require('./Transaction');
//
module.exports = mongoose.models.Match || mongoose.model('Match', MatchSchema);