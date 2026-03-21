// routes/wallet.js
// Native ETH only (Sepolia Testnet)
//
// Changes from existing:
//   • getTokenBalance()  → getPlayerInfo() — ETH balance lives in getPlayerInfo()
//   • symbol: 'TTK'      → symbol: 'ETH'
//   • amoy.polygonscan   → sepolia.etherscan (via BLOCK_EXPLORER_URL env)
//   • /balance response: balanceFormatted now shows ETH, tier added
//   • /info response:    wallet.symbol now 'ETH', tier added
//   • Removed: doesPlayerOwnItem loop in /info (now handled by getPlayerInfo)
//   • Kept: /balance, /info, /transactions structure exactly

const express           = require('express');
const router            = express.Router();
const authenticate      = require('../middleware/authenticate');
const blockchainService = require('../services/blockchainService');
const transactionService = require('../services/transactionService');
const Player            = require('../models/Player');

const EXPLORER = process.env.BLOCK_EXPLORER_URL || 'https://sepolia.etherscan.io';

// ─── GET /wallet/balance ──────────────────────────────────────────────────────
// Returns the native ETH balance for the authenticated player's linked wallet.
// Unity WalletManager.RefreshBalanceAsync() calls: GET /wallet/balance?address=0x...

router.get('/balance', authenticate, async (req, res, next) => {
  try {
    const player = await Player.findById(req.player.id);

    if (!player) {
      return res.status(404).json({ success: false, message: 'Player not found.' });
    }

    if (!player.walletAddress) {
      return res.json({
        success:          true,
        walletAddress:    null,
        balance:          '0',
        balanceFormatted: '0.0000',
        symbol:           'ETH',       // was 'TTK'
        tier:             0,
        note:             'No wallet linked. Connect MetaMask to see your balance.',
      });
    }

    // FIX: was blockchainService.getTokenBalance() — no longer exists.
    // getPlayerInfo() returns { address, ethBalance, ethBalanceWei, tier, ownedItemIds }
    const info = await blockchainService.getPlayerInfo(player.walletAddress);

    return res.json({
      success:          true,
      walletAddress:    player.walletAddress,
      balance:          info.ethBalanceWei,   // raw wei string
      balanceFormatted: info.ethBalance,      // e.g. "0.0250" ETH
      symbol:           'ETH',                // was 'TTK'
      tier:             info.tier,
    });

  } catch (err) {
    console.error('[Wallet] /balance error:', err.message);
    next(err);
  }
});

// ─── GET /wallet/info ─────────────────────────────────────────────────────────
// Returns full player profile: identity + ETH balance + tier + owned items.
// ETH balance is fetched via getPlayerInfo() which reads SmartStore + RewardEngine.

router.get('/info', authenticate, async (req, res, next) => {
  try {
    const player = await Player.findById(req.player.id);

    if (!player) {
      return res.status(404).json({ success: false, message: 'Player not found.' });
    }

    // FIX: was getTokenBalance() then separate doesPlayerOwnItem() loop.
    // Now getPlayerInfo() returns everything in one call.
    let ethBalance    = '0.0000';
    let ethBalanceWei = '0';
    let tier          = 0;
    let ownedItems    = player.ownedItems || [];
    let onChainError  = null;

    if (player.walletAddress) {
      try {
        const info = await blockchainService.getPlayerInfo(player.walletAddress);
        ethBalance    = info.ethBalance;       // formatted ETH string
        ethBalanceWei = info.ethBalanceWei;
        tier          = info.tier;
        ownedItems    = info.ownedItemIds || ownedItems;

        // Sync owned items to MongoDB for offline reference
        player.ownedItems = ownedItems;
        await player.save();

      } catch (chainErr) {
        console.warn('[Wallet] On-chain data fetch failed:', chainErr.message);
        onChainError = 'Could not fetch live blockchain data. Showing cached values.';
      }
    }

    return res.json({
      success: true,
      player: {
        id:            player._id.toString(),
        unityPlayerId: player.unityPlayerId,
        username:      player.username,
        email:         player.email,
        walletAddress: player.walletAddress,
        stats:         player.stats,
        ownedItems,
        createdAt:     player.createdAt,
        lastSeenAt:    player.lastSeenAt,
      },
      wallet: {
        address:          player.walletAddress,
        balance:          ethBalanceWei,
        balanceFormatted: ethBalance,
        symbol:           'ETH',   // was 'TTK'
        tier,
      },
      ...(onChainError && { warning: onChainError }),
    });

  } catch (err) {
    console.error('[Wallet] /info error:', err.message);
    next(err);
  }
});

// ─── GET /wallet/transactions ─────────────────────────────────────────────────
// Returns recent reward transactions for the player.
// explorerUrl now points to sepolia.etherscan.io (was amoy.polygonscan.com).

router.get('/transactions', authenticate, async (req, res, next) => {
  try {
    let blockchainTransactions = [];

    try {
      const player = await Player.findById(req.player.id);
      if (player) {
        blockchainTransactions = await transactionService.getPlayerTransactions(player._id, {
          limit: 50,
          skip: 0,
          status: null,
          type: null,
        });
      }
    } catch (errTx) {
      console.warn('[Wallet] Could not fetch transaction history:', errTx.message);
    }

    return res.json({
      success: true,
      count: blockchainTransactions.length,
      transactions: blockchainTransactions,
    });

  } catch (err) {
    console.error('[Wallet] /transactions error:', err.message);
    next(err);
  }
});

module.exports = router;