// models/Player.js
// MongoDB schema for a game player.
// Stores Unity identity, wallet link, game stats, anti-farming counters,
// and a cached ETH balance that is refreshed on every on-chain interaction.

const mongoose = require('mongoose');

const PlayerStatsSchema = new mongoose.Schema({
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  ties: { type: Number, default: 0 },
  totalMatches: { type: Number, default: 0 },
  rewardsEarned: { type: String, default: '0' },  // TTK amount as string (BigInt-safe)
}, { _id: false });

const PlayerSchema = new mongoose.Schema({

  // ─── Unity Identity ────────────────────────────────────────────────────────
  unityPlayerId: {
    type: String,
    required: true,
    unique: true,
  },

  username: {
    type: String,
    default: '',
    trim: true,
    maxlength: 32,
  },

  email: {
    type: String,
    default: '',
    trim: true,
    lowercase: true,
  },

  // ─── Blockchain Identity ───────────────────────────────────────────────────
  walletAddress: {
    type: String,
    default: null,
    lowercase: true,
    trim: true,
    sparse: true,
  },

  walletLinkedAt: {
    type: Date,
    default: null,
  },

  // ─── Cached ETH Balance ────────────────────────────────────────────────────
  // Updated every time the player hits /wallet/balance, /wallet/info,
  // completes a purchase (submit-tx / confirm-web-tx), or logs in.
  // Unity reads this on re-login so the UI shows the last-known balance
  // instantly, then a live refresh overwrites it in the background.
  cachedEthBalance: {
    type: String,
    default: '0.0000',   // formatted string, e.g. "0.0123"
  },

  cachedEthBalanceWei: {
    type: String,
    default: '0',        // raw wei as string (BigInt-safe)
  },

  ethBalanceFetchedAt: {
    type: Date,
    default: null,       // null = never fetched
  },

  // ─── Game Stats ────────────────────────────────────────────────────────────
  stats: {
    type: PlayerStatsSchema,
    default: () => ({}),
  },

  // ─── Store: Owned Items ────────────────────────────────────────────────────
  ownedItems: {
    type: [String],
    default: [],
  },

  // ─── Anti-Farming Counters ─────────────────────────────────────────────────
  rewardsClaimedToday: {
    type: Number,
    default: 0,
  },

  rewardResetDate: {
    type: Date,
    default: () => new Date(),
  },

  currentWinStreak: {
    type: Number,
    default: 0,
  },

  totalSuspicionFlags: {
    type: Number,
    default: 0,
  },

  isBanned: {
    type: Boolean,
    default: false,
  },

  // ─── High Score ──────────────────────────────────────────────────────────────
  bestTime: {
    type: Number,
    default: null,         // fastest win duration in seconds (null = no wins yet)
  },

  bestTimeMatchId: {
    type: String,
    default: null,         // matchId where the best time was achieved
  },

  // ─── Metadata ─────────────────────────────────────────────────────────────
  lastSeenAt: {
    type: Date,
    default: () => new Date(),
  },

  createdAt: {
    type: Date,
    default: () => new Date(),
  },

}, {
  timestamps: false,
  versionKey: false,
});

// ─── Indexes ──────────────────────────────────────────────────────────────────
PlayerSchema.index({ unityPlayerId: 1 });
PlayerSchema.index({ walletAddress: 1 }, { sparse: true });

// ─── Instance Methods ─────────────────────────────────────────────────────────

PlayerSchema.methods.resetDailyRewardsIfNeeded = function () {
  const now = new Date();
  const resetDate = new Date(this.rewardResetDate);
  const nowDay = now.toISOString().slice(0, 10);
  const resetDay = resetDate.toISOString().slice(0, 10);
  if (nowDay !== resetDay) {
    this.rewardsClaimedToday = 0;
    this.rewardResetDate = now;
  }
};

/**
 * Saves a freshly fetched ETH balance into the player document.
 * Call this whenever blockchainService.getPlayerInfo() succeeds.
 *
 * @param {string} formattedBalance  e.g. "0.0123"
 * @param {string} balanceWei        e.g. "12300000000000000"
 */
PlayerSchema.methods.cacheEthBalance = async function (formattedBalance, balanceWei) {
  this.cachedEthBalance = formattedBalance || '0.0000';
  this.cachedEthBalanceWei = balanceWei || '0';
  this.ethBalanceFetchedAt = new Date();
  await this.save();
};

PlayerSchema.methods.toPublicProfile = function () {
  return {
    id: this._id.toString(),
    unityPlayerId: this.unityPlayerId,
    username: this.username,
    walletAddress: this.walletAddress,
    stats: this.stats,
    ownedItems: this.ownedItems,
    // Include cached balance so Unity can display it immediately on re-login
    cachedEthBalance: this.cachedEthBalance,
    cachedEthBalanceWei: this.cachedEthBalanceWei,
    ethBalanceFetchedAt: this.ethBalanceFetchedAt,
    // High score
    bestTime: this.bestTime || 0,
    bestTimeMatchId: this.bestTimeMatchId || "",
  };
};

module.exports = mongoose.model('Player', PlayerSchema);