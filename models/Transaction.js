// models/Transaction.js
// MongoDB schema for blockchain transactions (purchases, payments, etc.)

const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  // ─── Transaction Identifiers ───────────────────────────────────────────────
  transactionHash: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true,
  },

  // ─── Player Reference ──────────────────────────────────────────────────────
  playerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Player',
    required: true,
    index: true,
  },

  playerAddress: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true,
  },

  // ─── Item Purchase Details ─────────────────────────────────────────────────
  itemId: {
    type: Number,
    required: true,
    index: true,
  },

  itemName: {
    type: String,
    default: null,
  },

  priceETH: {
    type: String,  // Store as string for precision (BigInt-safe)
    required: true,
  },

  priceWei: {
    type: String,  // Store full Wei amount as string
    required: true,
  },

  // ─── Transaction Status ────────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'failed'],
    default: 'pending',
    index: true,
  },

  failureReason: {
    type: String,
    default: null,
  },

  // ─── Blockchain Details ────────────────────────────────────────────────────
  chainId: {
    type: Number,
    required: true,  // 11155111 for Sepolia
    default: 11155111,
  },

  blockNumber: {
    type: Number,
    default: null,
    index: true,
  },

  gasUsed: {
    type: String,  // Store as string for large numbers
    default: null,
  },

  gasPrice: {
    type: String,  // Store as string
    default: null,
  },

  transactionFeeETH: {
    type: String,  // (gasUsed * gasPrice) in ETH
    default: null,
  },

  // ─── Transaction Type ──────────────────────────────────────────────────────
  type: {
    type: String,
    enum: ['purchase', 'admin_action', 'reward', 'refund'],
    default: 'purchase',
    index: true,
  },

  // ─── Contract Info ─────────────────────────────────────────────────────────
  contractAddress: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },

  methodName: {
    type: String,
    default: 'buyItem',  // e.g., 'buyItem', 'purchaseMulti', etc.
  },

  // ─── Timestamps ────────────────────────────────────────────────────────────
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },

  confirmedAt: {
    type: Date,
    default: null,
  },

  // ─── Additional Data ───────────────────────────────────────────────────────
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },

}, { timestamps: true });

// Index for common queries
TransactionSchema.index({ playerId: 1, createdAt: -1 });
TransactionSchema.index({ playerAddress: 1, createdAt: -1 });
TransactionSchema.index({ status: 1, createdAt: -1 });
TransactionSchema.index({ type: 1, createdAt: -1 });

// Prevent model overwrite on hot reload
module.exports = mongoose.models.Transaction || mongoose.model('Transaction', TransactionSchema);
