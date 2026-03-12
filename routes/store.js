// routes/store.js
// Native ETH only (Sepolia Testnet)
//
// Changes from existing:
//   • doesPlayerOwnItem()  → check via getPlayerInfo().ownedItemIds (single call)
//   • Items from getStoreItems() now include numericId, priceETH, priceETHFormatted, pricePHP, tier
//   • /owned: uses getPlayerInfo() instead of per-item doesPlayerOwnItem() loop
//   • Kept: /items, /owned, /item/:itemId structure exactly

const express           = require('express');
const router            = express.Router();
const authenticate      = require('../middleware/authenticate');
const blockchainService = require('../services/blockchainService');
const Player            = require('../models/Player');

// ─── GET /store/items ─────────────────────────────────────────────────────────
// Public — no auth required.
// Returns all active items from SmartStore contract via blockchainService.
// Item shape: { itemId, numericId, name, itemType, priceETH, priceETHFormatted, pricePHP, tier, active }

router.get('/items', async (req, res, next) => {
  try {
    const items = await blockchainService.getStoreItems();

    // Optional: filter by itemType query param e.g. ?type=wallet_upgrade
    const { type } = req.query;
    const filtered = type
      ? items.filter(i => i.active && i.itemType === type)
      : items.filter(i => i.active);

    return res.json({
      success: true,
      count:   filtered.length,
      items:   filtered,
    });

  } catch (err) {
    console.error('[Store] /items error:', err.message);
    next(err);
  }
});

// ─── GET /store/owned ─────────────────────────────────────────────────────────
// Protected — requires JWT.
// FIX: was a per-item doesPlayerOwnItem() loop (N on-chain calls).
// Now uses getPlayerInfo() which returns ownedItemIds in a single call.

router.get('/owned', authenticate, async (req, res, next) => {
  try {
    const player = await Player.findById(req.player.id);

    if (!player) {
      return res.status(404).json({ success: false, message: 'Player not found.' });
    }

    // No wallet → return MongoDB cached list
    if (!player.walletAddress) {
      return res.json({
        success:    true,
        ownedItems: player.ownedItems || [],
        source:     'cache',
        note:       'Connect a wallet to see on-chain ownership.',
      });
    }

    // Single call to getPlayerInfo() returns ownedItemIds from SmartStore
    const info       = await blockchainService.getPlayerInfo(player.walletAddress);
    const ownedItems = info.ownedItemIds || [];

    // Sync to MongoDB for offline use
    player.ownedItems = ownedItems;
    await player.save();

    return res.json({
      success:    true,
      ownedItems,
      source:     'blockchain',
      wallet:     player.walletAddress,
    });

  } catch (err) {
    console.error('[Store] /owned error:', err.message);
    next(err);
  }
});

// ─── GET /store/player/:address ───────────────────────────────────────────────
// NEW — returns owned item IDs + tier for a wallet address.
// StoreManager.RefreshOwnedItems() can call this endpoint directly.

router.get('/player/:address', async (req, res, next) => {
  try {
    const { address } = req.params;

    if (!address || !address.startsWith('0x')) {
      return res.status(400).json({ success: false, message: 'Invalid wallet address' });
    }

    const info = await blockchainService.getPlayerInfo(address.toLowerCase());

    return res.json({
      success:      true,
      address:      info.address,
      tier:         info.tier,
      ownedItemIds: info.ownedItemIds || [],
    });

  } catch (err) {
    console.error('[Store] /player/:address error:', err.message);
    next(err);
  }
});

// ─── GET /store/item/:itemId ──────────────────────────────────────────────────
// Returns details for a single item by string itemId.

router.get('/item/:itemId', async (req, res, next) => {
  try {
    const { itemId } = req.params;

    if (!itemId || itemId.trim() === '') {
      return res.status(400).json({ success: false, message: 'itemId is required.' });
    }

    const items = await blockchainService.getStoreItems();
    const item  = items.find(i => i.itemId === itemId);

    if (!item) {
      return res.status(404).json({ success: false, message: `Item '${itemId}' not found.` });
    }

    return res.json({ success: true, item });

  } catch (err) {
    console.error('[Store] /item/:itemId error:', err.message);
    next(err);
  }
});

module.exports = router;