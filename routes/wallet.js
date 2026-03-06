// routes/wallet.js
// GET /wallet/balance  → TTK token balance for authenticated player's wallet
// GET /wallet/info     → full profile: player data + TTK balance + owned items

const express           = require('express');
const router            = express.Router();
const authenticate      = require('../middleware/authenticate');
const blockchainService = require('../services/blockchainService');
const Player            = require('../models/Player');

// ─── GET /wallet/balance ──────────────────────────────────────────────────────
// Returns the TTK token balance for the authenticated player's linked wallet.

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
        balanceFormatted: '0.00',
        symbol:           'TTK',
        note:             'No wallet linked. Connect MetaMask to see your balance.',
      });
    }

    const balanceData = await blockchainService.getTokenBalance(player.walletAddress);

    return res.json({
      success:          true,
      walletAddress:    player.walletAddress,
      balance:          balanceData.raw,            // raw wei string
      balanceFormatted: balanceData.formatted,      // e.g. "12.50"
      symbol:           balanceData.symbol || 'TTK',
    });

  } catch (err) {
    console.error('[Wallet] /balance error:', err.message);
    next(err);
  }
});

// ─── GET /wallet/info ─────────────────────────────────────────────────────────
// Returns full player profile including:
//   - Unity identity
//   - Wallet address + TTK balance
//   - Game stats (wins, losses, rewards)
//   - Owned store items (synced from blockchain)

router.get('/info', authenticate, async (req, res, next) => {
  try {
    const player = await Player.findById(req.player.id);

    if (!player) {
      return res.status(404).json({ success: false, message: 'Player not found.' });
    }

    let balanceData  = { raw: '0', formatted: '0.00', symbol: 'TTK' };
    let ownedItems   = player.ownedItems || [];
    let onChainError = null;

    // If wallet is linked, fetch live blockchain data
    if (player.walletAddress) {
      try {
        balanceData = await blockchainService.getTokenBalance(player.walletAddress);

        // Refresh owned items from chain
        const allItems = await blockchainService.getStoreItems();
        const onChainOwned = [];

        for (const item of allItems) {
          const owns = await blockchainService.doesPlayerOwnItem(
            player.walletAddress,
            item.itemId
          );
          if (owns) onChainOwned.push(item.itemId);
        }

        ownedItems        = onChainOwned;
        player.ownedItems = onChainOwned;
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
        balance:          balanceData.raw,
        balanceFormatted: balanceData.formatted,
        symbol:           balanceData.symbol || 'TTK',
      },
      ...(onChainError && { warning: onChainError }),
    });

  } catch (err) {
    console.error('[Wallet] /info error:', err.message);
    next(err);
  }
});

// ─── GET /wallet/transactions ─────────────────────────────────────────────────
// Returns recent reward transactions for the player from MongoDB.

router.get('/transactions', authenticate, async (req, res, next) => {
  try {
    const Match = require('../models/Match');

    const matches = await Match.find({
      playerId: req.player.id,
      status:   'rewarded',
    })
      .sort({ rewardClaimedAt: -1 })
      .limit(20)
      .select('matchId rewardAmount rewardTxHash rewardClaimedAt difficulty winner');

    const transactions = matches.map(m => ({
      matchId:     m.matchId,
      amount:      m.rewardAmount,
      txHash:      m.rewardTxHash,
      explorerUrl: `${process.env.BLOCK_EXPLORER_URL}/tx/${m.rewardTxHash}`,
      claimedAt:   m.rewardClaimedAt,
      difficulty:  m.difficulty,
      winner:      m.winner,
    }));

    return res.json({
      success:      true,
      count:        transactions.length,
      transactions,
    });

  } catch (err) {
    console.error('[Wallet] /transactions error:', err.message);
    next(err);
  }
});

module.exports = router;