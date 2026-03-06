// routes/store.js
// GET /store/items  → reads active items from SmartStore contract
// GET /store/owned  → checks which items the authenticated player owns on-chain

const express            = require('express');
const router             = express.Router();
const authenticate       = require('../middleware/authenticate');
const blockchainService  = require('../services/blockchainService');
const Player             = require('../models/Player');

// ─── GET /store/items ─────────────────────────────────────────────────────────
// Public endpoint — no auth required to browse the store.
// Reads the SmartStore contract for all active items.

router.get('/items', async (req, res, next) => {
  try {
    const items = await blockchainService.getStoreItems();

    // Filter to only active items
    const activeItems = items.filter(item => item.active);

    return res.json({
      success: true,
      count:   activeItems.length,
      items:   activeItems,
    });

  } catch (err) {
    console.error('[Store] /items error:', err.message);
    next(err);
  }
});

// ─── GET /store/owned ─────────────────────────────────────────────────────────
// Protected — requires JWT.
// Returns list of itemIds owned by the authenticated player's wallet.
// Also syncs ownedItems in MongoDB for offline reference.

router.get('/owned', authenticate, async (req, res, next) => {
  try {
    const player = await Player.findById(req.player.id);

    if (!player) {
      return res.status(404).json({ success: false, message: 'Player not found.' });
    }

    // If player has no wallet linked, return MongoDB cached list
    if (!player.walletAddress) {
      return res.json({
        success:    true,
        ownedItems: player.ownedItems || [],
        source:     'cache',
        note:       'Connect a wallet to see on-chain ownership.',
      });
    }

    // Query on-chain ownership for each known item
    const allItems   = await blockchainService.getStoreItems();
    const ownedItems = [];

    for (const item of allItems) {
      const owns = await blockchainService.doesPlayerOwnItem(
        player.walletAddress,
        item.itemId
      );
      if (owns) ownedItems.push(item.itemId);
    }

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

// ─── GET /store/item/:itemId ──────────────────────────────────────────────────
// Returns details for a single item by ID.

router.get('/item/:itemId', async (req, res, next) => {
  try {
    const { itemId } = req.params;

    if (!itemId || itemId.trim() === '') {
      return res.status(400).json({ success: false, message: 'itemId is required.' });
    }

    const items  = await blockchainService.getStoreItems();
    const item   = items.find(i => i.itemId === itemId);

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