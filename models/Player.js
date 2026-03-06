// models/Player.js
// MongoDB schema for a game player.
// Stores Unity identity, wallet link, game stats, and anti-farming counters.

const mongoose = require('mongoose');

const PlayerStatsSchema = new mongoose.Schema({
  wins:           { type: Number, default: 0 },
  losses:         { type: Number, default: 0 },
  totalMatches:   { type: Number, default: 0 },
  rewardsEarned:  { type: String, default: '0' },  // TTK amount as string (BigInt-safe)
}, { _id: false });

const PlayerSchema = new mongoose.Schema({

  // ─── Unity Identity ────────────────────────────────────────────────────────
  unityPlayerId: {
    type:     String,
    required: true,
    unique:   true,        // ← removed index:true (schema.index() below handles it)
  },

  username: {
    type:    String,
    default: '',
    trim:    true,
    maxlength: 32,
  },

  email: {
    type:    String,
    default: '',
    trim:    true,
    lowercase: true,
  },

  // ─── Blockchain Identity ───────────────────────────────────────────────────
  walletAddress: {
    type:      String,
    default:   null,
    lowercase: true,
    trim:      true,
    sparse:    true,       // ← removed index:true (schema.index() below handles it)
  },

  walletLinkedAt: {
    type:    Date,
    default: null,
  },

  // ─── Game Stats ────────────────────────────────────────────────────────────
  stats: {
    type:    PlayerStatsSchema,
    default: () => ({}),
  },

  // ─── Store: Owned Items ────────────────────────────────────────────────────
  ownedItems: {
    type:    [String],
    default: [],
  },

  // ─── Anti-Farming Counters ─────────────────────────────────────────────────
  rewardsClaimedToday: {
    type:    Number,
    default: 0,
  },

  rewardResetDate: {
    type:    Date,
    default: () => new Date(),
  },

  currentWinStreak: {
    type:    Number,
    default: 0,
  },

  totalSuspicionFlags: {
    type:    Number,
    default: 0,
  },

  isBanned: {
    type:    Boolean,
    default: false,
  },

  // ─── Metadata ─────────────────────────────────────────────────────────────
  lastSeenAt: {
    type:    Date,
    default: () => new Date(),
  },

  createdAt: {
    type:    Date,
    default: () => new Date(),
  },

}, {
  timestamps: false,
  versionKey: false,
});

// ─── Indexes (defined once here only) ────────────────────────────────────────
PlayerSchema.index({ unityPlayerId: 1 });
PlayerSchema.index({ walletAddress: 1 }, { sparse: true });

// ─── Instance Methods ─────────────────────────────────────────────────────────

PlayerSchema.methods.resetDailyRewardsIfNeeded = function () {
  const now       = new Date();
  const resetDate = new Date(this.rewardResetDate);
  const nowDay   = now.toISOString().slice(0, 10);
  const resetDay = resetDate.toISOString().slice(0, 10);
  if (nowDay !== resetDay) {
    this.rewardsClaimedToday = 0;
    this.rewardResetDate     = now;
  }
};

PlayerSchema.methods.toPublicProfile = function () {
  return {
    id:            this._id.toString(),
    unityPlayerId: this.unityPlayerId,
    username:      this.username,
    walletAddress: this.walletAddress,
    stats:         this.stats,
    ownedItems:    this.ownedItems,
  };
};

module.exports = mongoose.model('Player', PlayerSchema);