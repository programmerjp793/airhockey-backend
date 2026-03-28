// routes/wallet.js
// Native ETH only (Sepolia Testnet)
//
// Balance sync strategy:
//   1. Every call to /balance or /info fetches the live on-chain ETH balance via
//      blockchainService.getPlayerInfo() and immediately writes it to Player.cachedEthBalance.
//   2. The cached value is returned alongside the live value so Unity can display
//      something meaningful even if the next call is made while offline.
//   3. On wallet-login (routes/auth.js) the same cached value is included in the
//      login response, so the UI shows the last-known balance instantly on app start.
//   4. After every successful purchase (routes/payment.js submit-tx / confirm-web-tx)
//      the same refreshAndCacheBalance() helper is called so the post-purchase balance
//      is persisted before Unity polls /wallet/balance.
//
// Cross-wallet owned-items strategy:
//   A player account has a single ownedItems array in MongoDB that is the
//   union of everything purchased by ANY wallet ever linked to that account.
//   When /info syncs on-chain items for the current wallet, it MERGES them
//   into ownedItems rather than replacing — so items bought by a previous
//   wallet are never lost from the account's inventory.

const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');
const blockchainService = require('../services/blockchainService');
const transactionService = require('../services/transactionService');
const Player = require('../models/Player');

const EXPLORER = process.env.BLOCK_EXPLORER_URL || 'https://sepolia.etherscan.io';

// ─── Shared helper ────────────────────────────────────────────────────────────
/**
 * Fetches the live ETH balance for `walletAddress` from the Sepolia node,
 * persists it to the Player document, and returns the result object.
 *
 * Exported so payment.js can call it after a confirmed purchase without
 * duplicating the try/catch boilerplate.
 *
 * @param {string} walletAddress  lowercase hex address
 * @param {object} player         Mongoose Player document (will be saved)
 * @returns {{ ethBalance: string, ethBalanceWei: string, tier: number, ownedItemIds: string[], fromCache: boolean }}
 */
async function refreshAndCacheBalance(walletAddress, player) {
  const info = await blockchainService.getPlayerInfo(walletAddress);

  // Persist to MongoDB so it survives a server restart / re-login
  await player.cacheEthBalance(info.ethBalance, info.ethBalanceWei);

  return { ...info, fromCache: false };
}

// Export so payment.js can import it
module.exports.refreshAndCacheBalance = refreshAndCacheBalance;

// ─── Owned-items merge helper ─────────────────────────────────────────────────
/**
 * Merges `newItemIds` (string item IDs from on-chain) into the player's
 * existing ownedItems array using a Set union.
 *
 * Items already in player.ownedItems (bought by any previous wallet on this
 * account) are KEPT. New items from the current wallet are ADDED.
 * The document is only saved when something actually changed.
 *
 * @param {object}   player      Mongoose Player document
 * @param {string[]} newItemIds  String item IDs to merge in
 * @returns {string[]} The merged array
 */
async function mergeOwnedItems(player, newItemIds = []) {
  const existing = new Set(player.ownedItems || []);
  let changed = false;

  for (const id of newItemIds) {
    if (!existing.has(id)) {
      existing.add(id);
      changed = true;
    }
  }

  if (changed) {
    player.ownedItems = Array.from(existing);
    await player.save();
  }

  return Array.from(existing);
}

// Export so store.js can reuse it
module.exports.mergeOwnedItems = mergeOwnedItems;

// ─── GET /wallet/balance ──────────────────────────────────────────────────────
// Returns the native ETH balance for the authenticated player's linked wallet.
// Unity WalletManager.RefreshBalanceAsync() calls: GET /wallet/balance
// Flow:
//   1. Try live on-chain fetch → cache result in MongoDB.
//   2. On failure fall back to the last cached value stored in the document.
router.get('/balance', authenticate, async (req, res, next) => {
  try {
    const player = await Player.findById(req.player.id);

    if (!player || !player.walletAddress) {
      return res.json({
        success: true,
        walletAddress: null,
        balance: '0',
        balanceFormatted: '0.0000',
        fromCache: false,
        note: 'No wallet linked. Connect MetaMask to see your balance.',
      });
    }

    let balanceFormatted = player.cachedEthBalance || '0.0000';
    let balanceWei = player.cachedEthBalanceWei || '0';
    let fromCache = true;
    let warning = null;

    try {
      const info = await refreshAndCacheBalance(player.walletAddress, player);
      balanceFormatted = info.ethBalance;
      balanceWei = info.ethBalanceWei;
      fromCache = false;
    } catch (chainErr) {
      console.warn('[Wallet] /balance live fetch failed, returning cache:', chainErr.message);
      warning = 'Live balance unavailable. Showing last cached value.';
    }

    return res.json({
      success: true,
      walletAddress: player.walletAddress,
      balance: balanceWei,
      balanceFormatted,
      fromCache,
      fetchedAt: player.ethBalanceFetchedAt,
      ...(warning && { warning }),
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /wallet/info ─────────────────────────────────────────────────────────
// Returns full player profile: identity + live ETH balance + tier + owned items.
// Same caching strategy as /balance — live fetch → persist → fallback to cache.
//
// FIX: On-chain ownedItemIds are now MERGED into player.ownedItems instead of
// replacing them. This preserves items bought by any previous wallet on this
// account when the player connects a different wallet.
router.get('/info', authenticate, async (req, res, next) => {
  try {
    const player = await Player.findById(req.player.id);

    if (!player) {
      return res.status(404).json({ success: false, message: 'Player not found.' });
    }

    let ethBalance = player.cachedEthBalance || '0.0000';
    let ethBalanceWei = player.cachedEthBalanceWei || '0';
    let tier = 0;
    let ownedItems = player.ownedItems || [];
    let fromCache = true;
    let onChainError = null;

    if (player.walletAddress) {
      try {
        const info = await refreshAndCacheBalance(player.walletAddress, player);
        ethBalance = info.ethBalance;
        ethBalanceWei = info.ethBalanceWei;
        tier = info.tier || 0;
        fromCache = false;

        // FIX: MERGE on-chain items into ownedItems — never replace.
        // Previously this was: ownedItems = info.ownedItemIds (replace)
        // which wiped items bought by a previous wallet when a new wallet connected.
        if (info.ownedItemIds && info.ownedItemIds.length > 0) {
          ownedItems = await mergeOwnedItems(player, info.ownedItemIds);
        }
      } catch (chainErr) {
        console.warn('[Wallet] /info live fetch failed, returning cache:', chainErr.message);
        onChainError = 'Could not fetch live blockchain data. Showing cached values.';
      }
    }

    return res.json({
      success: true,
      player: {
        id: player._id.toString(),
        unityPlayerId: player.unityPlayerId,
        username: player.username,
        email: player.email,
        walletAddress: player.walletAddress,
        stats: player.stats,
        ownedItems,
        createdAt: player.createdAt,
        lastSeenAt: player.lastSeenAt,
      },
      wallet: {
        address: player.walletAddress,
        balance: ethBalanceWei,
        balanceFormatted: ethBalance,
        symbol: 'ETH',
        tier,
        fromCache,
        fetchedAt: player.ethBalanceFetchedAt,
      },
      ...(onChainError && { warning: onChainError }),
    });

  } catch (err) {
    console.error('[Wallet] /info error:', err.message);
    next(err);
  }
});

// ─── GET /wallet/transactions ─────────────────────────────────────────────────
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