// routes/transactions.js
// Blockchain transaction history and tracking endpoints

const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');
const transactionService = require('../services/transactionService');

// ==================== PLAYER ENDPOINTS ====================

/**
 * GET /api/transactions/history
 * Get authenticated player's transaction history
 * Query params: limit, skip, status, type
 */
router.get('/history', authenticate, async (req, res, next) => {
  try {
    const { limit = 50, skip = 0, status, type } = req.query;

    const transactions = await transactionService.getPlayerTransactions(
      req.player._id,
      {
        limit: Math.min(parseInt(limit, 10) || 50, 100),
        skip: Math.max(parseInt(skip, 10) || 0, 0),
        status: status || null,
        type: type || null,
      }
    );

    const count = await transactionService.getPlayerTransactionCount(
      req.player._id,
      { status: status || null, type: type || null }
    );

    return res.json({
      success: true,
      data: {
        transactions,
        pagination: {
          total: count,
          limit: parseInt(limit, 10) || 50,
          skip: parseInt(skip, 10) || 0,
        },
      },
    });
  } catch (err) {
    console.error('[Transactions] GET /history error:', err.message);
    next(err);
  }
});

/**
 * GET /api/transactions/stats
 * Get player's purchase statistics
 */
router.get('/stats', authenticate, async (req, res, next) => {
  try {
    const stats = await transactionService.getPlayerPurchaseStats(req.player._id);

    return res.json({
      success: true,
      data: {
        purchaseStats: stats,
        totalItems: stats.length,
      },
    });
  } catch (err) {
    console.error('[Transactions] GET /stats error:', err.message);
    next(err);
  }
});

/**
 * GET /api/transactions/:txHash
 * Get transaction details by hash
 * Available to authenticated users for their own transactions
 */
router.get('/:txHash', authenticate, async (req, res, next) => {
  try {
    const { txHash } = req.params;

    if (!txHash || txHash.length < 66) {
      return res.status(400).json({
        success: false,
        message: 'Invalid transaction hash format',
      });
    }

    const transaction = await transactionService.getTransactionByHash(txHash);

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found',
      });
    }

    // Verify ownership: user can only view their own transactions
    if (transaction.playerId.toString() !== req.player._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
      });
    }

    return res.json({
      success: true,
      data: transaction,
    });
  } catch (err) {
    console.error('[Transactions] GET /:txHash error:', err.message);
    next(err);
  }
});

/**
 * GET /api/transactions/status/:txHash
 * Get transaction status (lightweight endpoint)
 * Does not require authentication - useful for checking status via public hash
 */
router.get('/status/:txHash', async (req, res, next) => {
  try {
    const { txHash } = req.params;

    if (!txHash || txHash.length < 66) {
      return res.status(400).json({
        success: false,
        message: 'Invalid transaction hash format',
      });
    }

    const status = await transactionService.getTransactionStatus(txHash);

    if (!status) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found',
      });
    }

    return res.json({
      success: true,
      data: status,
    });
  } catch (err) {
    console.error('[Transactions] GET /status/:txHash error:', err.message);
    next(err);
  }
});

/**
 * GET /api/transactions/address/:walletAddress
 * Get all transactions for a wallet address
 * Query params: limit, skip, status
 */
router.get('/address/:walletAddress', async (req, res, next) => {
  try {
    const { walletAddress } = req.params;
    const { limit = 50, skip = 0, status } = req.query;

    if (!walletAddress || walletAddress.length !== 42) {
      return res.status(400).json({
        success: false,
        message: 'Invalid wallet address format',
      });
    }

    const transactions = await transactionService.getTransactionsByAddress(
      walletAddress,
      {
        limit: Math.min(parseInt(limit, 10) || 50, 100),
        skip: Math.max(parseInt(skip, 10) || 0, 0),
        status: status || null,
      }
    );

    return res.json({
      success: true,
      data: {
        walletAddress,
        transactions,
        count: transactions.length,
      },
    });
  } catch (err) {
    console.error('[Transactions] GET /address/:walletAddress error:', err.message);
    next(err);
  }
});

module.exports = router;
