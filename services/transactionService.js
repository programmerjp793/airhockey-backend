// services/transactionService.js
// Service for managing blockchain transaction records in MongoDB

const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const { ethers } = require('ethers');

/**
 * Record a new blockchain transaction
 * @param {Object} txData - Transaction data to store
 * @returns {Promise<Object>} - Created transaction document
 */
async function recordTransaction(txData) {
  try {
    const {
      transactionHash,
      playerId,
      playerAddress,
      itemId,
      itemName,
      priceETH,
      priceWei,
      chainId = 11155111,
      contractAddress,
      methodName = 'buyItem',
      type = 'purchase',
      metadata = {},
    } = txData;

    // Validate required fields
    if (!transactionHash || !playerId || !playerAddress || itemId === undefined) {
      throw new Error('Missing required transaction fields');
    }

    const transaction = new Transaction({
      transactionHash: transactionHash.toLowerCase(),
      playerId,
      playerAddress: playerAddress.toLowerCase(),
      itemId,
      itemName: itemName || null,
      priceETH,
      priceWei,
      status: 'pending',
      chainId,
      contractAddress: contractAddress.toLowerCase(),
      methodName,
      type,
      metadata,
      createdAt: new Date(),
    });

    const savedTransaction = await transaction.save();
    console.log(`[TransactionService] Recorded TX: ${transactionHash} for player ${playerAddress}`);
    
    return savedTransaction;
  } catch (err) {
    console.error('[TransactionService] recordTransaction error:', err.message);
    throw err;
  }
}

/**
 * Update transaction with confirmed status and block details
 * @param {string} transactionHash - Transaction hash to update
 * @param {Object} blockData - Block details (blockNumber, gasUsed, gasPrice)
 * @returns {Promise<Object>} - Updated transaction
 */
async function confirmTransaction(transactionHash, blockData) {
  try {
    const {
      blockNumber,
      gasUsed,
      gasPrice,
    } = blockData;

    let transactionFeeETH = null;
    if (gasUsed && gasPrice) {
      try {
        const feeWei = BigInt(gasUsed) * BigInt(gasPrice);
        transactionFeeETH = ethers.formatEther(feeWei);
      } catch (e) {
        console.warn('[TransactionService] Could not calculate fee:', e.message);
      }
    }

    const updated = await Transaction.findOneAndUpdate(
      { transactionHash: transactionHash.toLowerCase() },
      {
        status: 'confirmed',
        blockNumber: blockNumber || null,
        gasUsed: gasUsed ? gasUsed.toString() : null,
        gasPrice: gasPrice ? gasPrice.toString() : null,
        transactionFeeETH,
        confirmedAt: new Date(),
      },
      { new: true }
    );

    if (!updated) {
      console.warn(`[TransactionService] Transaction not found: ${transactionHash}`);
      return null;
    }

    console.log(`[TransactionService] Confirmed TX: ${transactionHash} at block ${blockNumber}`);
    return updated;
  } catch (err) {
    console.error('[TransactionService] confirmTransaction error:', err.message);
    throw err;
  }
}

/**
 * Mark transaction as failed
 * @param {string} transactionHash - Transaction hash
 * @param {string} failureReason - Reason for failure
 * @returns {Promise<Object>} - Updated transaction
 */
async function failTransaction(transactionHash, failureReason) {
  try {
    const updated = await Transaction.findOneAndUpdate(
      { transactionHash: transactionHash.toLowerCase() },
      {
        status: 'failed',
        failureReason: failureReason || 'Unknown error',
        confirmedAt: new Date(),
      },
      { new: true }
    );

    if (!updated) {
      console.warn(`[TransactionService] Transaction not found: ${transactionHash}`);
      return null;
    }

    console.log(`[TransactionService] Failed TX: ${transactionHash} - Reason: ${failureReason}`);
    return updated;
  } catch (err) {
    console.error('[TransactionService] failTransaction error:', err.message);
    throw err;
  }
}

/**
 * Get transaction by hash
 * @param {string} transactionHash - Transaction hash
 * @returns {Promise<Object>} - Transaction document
 */
async function getTransactionByHash(transactionHash) {
  try {
    const transaction = await Transaction.findOne({
      transactionHash: transactionHash.toLowerCase(),
    }).populate('playerId', 'username walletAddress');

    return transaction;
  } catch (err) {
    console.error('[TransactionService] getTransactionByHash error:', err.message);
    throw err;
  }
}

/**
 * Get transaction status
 * @param {string} transactionHash - Transaction hash
 * @returns {Promise<string>} - Transaction status (pending, confirmed, failed)
 */
async function getTransactionStatus(transactionHash) {
  try {
    const transaction = await Transaction.findOne(
      { transactionHash: transactionHash.toLowerCase() },
      { status: 1, blockNumber: 1, failureReason: 1 }
    );

    if (!transaction) {
      return null;
    }

    return {
      hash: transactionHash,
      status: transaction.status,
      blockNumber: transaction.blockNumber,
      failureReason: transaction.failureReason,
      confirmedAt: transaction.confirmedAt,
    };
  } catch (err) {
    console.error('[TransactionService] getTransactionStatus error:', err.message);
    throw err;
  }
}

/**
 * Get player's transaction history
 * @param {string} playerId - Player MongoDB ObjectId
 * @param {Object} options - Query options (limit, skip, status)
 * @returns {Promise<Array>} - Array of transactions
 */
async function getPlayerTransactions(playerId, options = {}) {
  try {
    const {
      limit = 50,
      skip = 0,
      status = null,
      type = null,
      sort = -1,  // -1 for descending (newest first)
    } = options;

    let query = { playerId };

    if (status) {
      query.status = status;
    }

    if (type) {
      query.type = type;
    }

    const transactions = await Transaction.find(query)
      .sort({ createdAt: sort })
      .limit(limit)
      .skip(skip)
      .lean();

    return transactions;
  } catch (err) {
    console.error('[TransactionService] getPlayerTransactions error:', err.message);
    throw err;
  }
}

/**
 * Get transaction count for player
 * @param {string} playerId - Player MongoDB ObjectId
 * @param {Object} filters - Filter options (status, type)
 * @returns {Promise<number>} - Total count
 */
async function getPlayerTransactionCount(playerId, filters = {}) {
  try {
    let query = { playerId };

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.type) {
      query.type = filters.type;
    }

    const count = await Transaction.countDocuments(query);
    return count;
  } catch (err) {
    console.error('[TransactionService] getPlayerTransactionCount error:', err.message);
    throw err;
  }
}

/**
 * Get transactions by player wallet address
 * @param {string} playerAddress - Wallet address
 * @param {Object} options - Query options
 * @returns {Promise<Array>} - Transactions
 */
async function getTransactionsByAddress(playerAddress, options = {}) {
  try {
    const {
      limit = 50,
      skip = 0,
      status = null,
    } = options;

    let query = { playerAddress: playerAddress.toLowerCase() };

    if (status) {
      query.status = status;
    }

    const transactions = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .lean();

    return transactions;
  } catch (err) {
    console.error('[TransactionService] getTransactionsByAddress error:', err.message);
    throw err;
  }
}

/**
 * Get purchase statistics for a player
 * @param {string} playerId - Player ID
 * @returns {Promise<Object>} - Purchase stats
 */
async function getPlayerPurchaseStats(playerId) {
  try {
    const stats = await Transaction.aggregate([
      { $match: { playerId: mongoose.Types.ObjectId(playerId), type: 'purchase' } },
      {
        $group: {
          _id: '$itemId',
          itemId: { $first: '$itemId' },
          itemName: { $first: '$itemName' },
          count: { $sum: 1 },
          totalSpentETH: { $sum: '$priceETH' },
          totalSpentWei: { $sum: '$priceWei' },
          confirmed: {
            $sum: {
              $cond: [{ $eq: ['$status', 'confirmed'] }, 1, 0],
            },
          },
        },
      },
      { $sort: { count: -1 } },
    ]);

    return stats;
  } catch (err) {
    console.error('[TransactionService] getPlayerPurchaseStats error:', err.message);
    throw err;
  }
}

/**
 * Get pending transactions (for monitoring/retry logic)
 * @param {Object} options - Query options
 * @returns {Promise<Array>} - Pending transactions
 */
async function getPendingTransactions(options = {}) {
  try {
    const {
      limit = 100,
      minAgeMinutes = 0,  // Only get transactions older than this
    } = options;

    let query = { status: 'pending' };

    if (minAgeMinutes > 0) {
      const cutoffTime = new Date(Date.now() - minAgeMinutes * 60 * 1000);
      query.createdAt = { $lt: cutoffTime };
    }

    const transactions = await Transaction.find(query)
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    return transactions;
  } catch (err) {
    console.error('[TransactionService] getPendingTransactions error:', err.message);
    throw err;
  }
}

module.exports = {
  recordTransaction,
  confirmTransaction,
  failTransaction,
  getTransactionByHash,
  getTransactionStatus,
  getPlayerTransactions,
  getPlayerTransactionCount,
  getTransactionsByAddress,
  getPlayerPurchaseStats,
  getPendingTransactions,
};
