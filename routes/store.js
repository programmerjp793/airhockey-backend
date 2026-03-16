// routes/store.js
// Native ETH only (Sepolia Testnet) - SmartStore Item Management
//
// Admin endpoints for store management:
//   POST /api/store/items - Create new item
//   PUT /api/store/items/:itemId/price - Set item price
//   PUT /api/store/items/:itemId/availability - Toggle availability
//   PUT /api/store/items/:itemId - Update item
//   POST /api/store/treasury - Set treasury address
//
// Player store endpoints:
//   GET /api/store/items - Get all items
//   GET /api/store/items/available - Get available items
//   GET /api/store/items/:itemId - Get single item
//   GET /api/store/player/:playerAddress/items - Get player's owned items
//   GET /api/store/player/:playerAddress/items/:itemId/owns - Check if player owns item

const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');
const blockchainService = require('../services/blockchainService');

// ==================== ADMIN ENDPOINTS ====================
// All admin endpoints require authentication

// POST /api/store/items - Create new item
router.post('/items', authenticate, async (req, res, next) => {
  try {
    // Check if user is admin
    if (!req.player.isAdmin) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const { name, priceETH, isAvailable = true } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Item name is required' });
    }

    if (priceETH === undefined || priceETH === null) {
      return res.status(400).json({ success: false, message: 'Price in ETH is required' });
    }

    const result = await blockchainService.createItem(name, priceETH, isAvailable);

    return res.status(201).json({
      success: true,
      message: 'Item created successfully',
      ...result,
    });

  } catch (err) {
    console.error('[Store] POST /items error:', err.message);
    next(err);
  }
});

// PUT /api/store/items/:itemId/price - Set item price
router.put('/items/:itemId/price', authenticate, async (req, res, next) => {
  try {
    if (!req.player.isAdmin) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const { itemId } = req.params;
    const { priceETH } = req.body;

    if (priceETH === undefined || priceETH === null) {
      return res.status(400).json({ success: false, message: 'Price in ETH is required' });
    }

    const numericItemId = parseInt(itemId, 10);
    if (isNaN(numericItemId) || numericItemId < 1) {
      return res.status(400).json({ success: false, message: 'Invalid item ID' });
    }

    const result = await blockchainService.setItemPrice(numericItemId, priceETH);

    return res.json({
      success: true,
      message: 'Item price updated successfully',
      ...result,
    });

  } catch (err) {
    console.error('[Store] PUT /items/:itemId/price error:', err.message);
    next(err);
  }
});

// PUT /api/store/items/:itemId/availability - Toggle availability
router.put('/items/:itemId/availability', authenticate, async (req, res, next) => {
  try {
    if (!req.player.isAdmin) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const { itemId } = req.params;
    const numericItemId = parseInt(itemId, 10);

    if (isNaN(numericItemId) || numericItemId < 1) {
      return res.status(400).json({ success: false, message: 'Invalid item ID' });
    }

    const result = await blockchainService.toggleItemAvailability(numericItemId);

    return res.json({
      success: true,
      message: 'Item availability toggled successfully',
      ...result,
    });

  } catch (err) {
    console.error('[Store] PUT /items/:itemId/availability error:', err.message);
    next(err);
  }
});

// PUT /api/store/items/:itemId - Update item
router.put('/items/:itemId', authenticate, async (req, res, next) => {
  try {
    if (!req.player.isAdmin) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const { itemId } = req.params;
    const { name, priceETH, isAvailable } = req.body;

    const numericItemId = parseInt(itemId, 10);
    if (isNaN(numericItemId) || numericItemId < 1) {
      return res.status(400).json({ success: false, message: 'Invalid item ID' });
    }

    if (!name && priceETH === undefined && isAvailable === undefined) {
      return res.status(400).json({ success: false, message: 'At least one field to update is required' });
    }

    // Get current item to preserve values
    let currentItem;
    try {
      currentItem = await blockchainService.getItem(numericItemId);
    } catch (e) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    const result = await blockchainService.updateItem(
      numericItemId,
      name || currentItem.name,
      priceETH !== undefined ? priceETH : currentItem.price,
      isAvailable !== undefined ? isAvailable : currentItem.isAvailable
    );

    return res.json({
      success: true,
      message: 'Item updated successfully',
      ...result,
    });

  } catch (err) {
    console.error('[Store] PUT /items/:itemId error:', err.message);
    next(err);
  }
});

// POST /api/store/treasury - Set treasury address
router.post('/treasury', authenticate, async (req, res, next) => {
  try {
    if (!req.player.isAdmin) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const { treasuryAddress } = req.body;

    if (!treasuryAddress) {
      return res.status(400).json({ success: false, message: 'Treasury address is required' });
    }

    const result = await blockchainService.setTreasury(treasuryAddress);

    return res.json({
      success: true,
      message: 'Treasury address set successfully',
      ...result,
    });

  } catch (err) {
    console.error('[Store] POST /treasury error:', err.message);
    next(err);
  }
});

// ==================== PLAYER/PUBLIC ENDPOINTS ====================
// These endpoints are public (no auth required)

// GET /api/store/items - Get all items
router.get('/items', async (req, res, next) => {
  try {
    const items = await blockchainService.getStoreItems();

    return res.json({
      success: true,
      count: items.length,
      items,
    });

  } catch (err) {
    console.error('[Store] GET /items error:', err.message);
    next(err);
  }
});

// GET /api/store/items/available - Get available items only (must be BEFORE /items/:itemId)
router.get('/items/available', async (req, res, next) => {
  try {
    const items = await blockchainService.getAvailableStoreItems();

    return res.json({
      success: true,
      count: items.length,
      items,
    });

  } catch (err) {
    console.error('[Store] GET /items/available error:', err.message);
    next(err);
  }
});

// GET /api/store/items/:itemId - Get single item (must be AFTER /items/available)
router.get('/items/:itemId', async (req, res, next) => {
  try {
    const { itemId } = req.params;

    // Try to parse as numeric ID
    const numericId = parseInt(itemId, 10);
    
    let item;
    if (!isNaN(numericId) && numericId > 0) {
      try {
        item = await blockchainService.getItem(numericId);
      } catch (e) {
        // Item not found
      }
    }

    // If not found by numeric ID, try to find in all items
    if (!item) {
      const items = await blockchainService.getStoreItems();
      item = items.find(i => i.itemId === itemId || i.itemIdStr === itemId);
    }

    if (!item) {
      return res.status(404).json({ success: false, message: `Item '${itemId}' not found` });
    }

    return res.json({ success: true, item });

  } catch (err) {
    console.error('[Store] GET /items/:itemId error:', err.message);
    next(err);
  }
});

// GET /api/store/items/available - Get available items only (must be AFTER /items/:itemId to avoid conflict)

// GET /api/store/player/:playerAddress/items - Get player's owned items
router.get('/player/:playerAddress/items', async (req, res, next) => {
  try {
    const { playerAddress } = req.params;

    if (!playerAddress || !playerAddress.startsWith('0x')) {
      return res.status(400).json({ success: false, message: 'Invalid wallet address' });
    }

    const ownedItems = await blockchainService.getPlayerItems(playerAddress.toLowerCase());

    return res.json({
      success: true,
      playerAddress: playerAddress.toLowerCase(),
      ownedItems,
      count: ownedItems.length,
    });

  } catch (err) {
    console.error('[Store] GET /player/:playerAddress/items error:', err.message);
    next(err);
  }
});

// GET /api/store/player/:playerAddress/items/:itemId/owns - Check if player owns item
router.get('/player/:playerAddress/items/:itemId/owns', async (req, res, next) => {
  try {
    const { playerAddress, itemId } = req.params;

    if (!playerAddress || !playerAddress.startsWith('0x')) {
      return res.status(400).json({ success: false, message: 'Invalid wallet address' });
    }

    const numericItemId = parseInt(itemId, 10);
    if (isNaN(numericItemId) || numericItemId < 1) {
      return res.status(400).json({ success: false, message: 'Invalid item ID' });
    }

    const hasItem = await blockchainService.hasPlayerBoughtItem(
      playerAddress.toLowerCase(),
      numericItemId
    );

    return res.json({
      success: true,
      playerAddress: playerAddress.toLowerCase(),
      itemId: numericItemId,
      ownsItem: hasItem,
    });

  } catch (err) {
    console.error('[Store] GET /player/:playerAddress/items/:itemId/owns error:', err.message);
    next(err);
  }
});

module.exports = router;
