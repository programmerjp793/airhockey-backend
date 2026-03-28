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
//   GET /api/store/owned - Get authenticated player's owned items (merged across all wallets)
//   GET /api/store/player/:playerAddress/items - Get player's owned items
//   GET /api/store/player/:playerAddress/items/:itemId/owns - Check if player owns item
//
// Cross-wallet owned-items:
//   GET /store/owned returns the UNION of player.ownedItems (MongoDB, all wallets)
//   and on-chain items for the current wallet, merged so items from previous
//   wallets on the same account are never lost.

const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');
const blockchainService = require('../services/blockchainService');
const transactionService = require('../services/transactionService');
const Player = require('../models/Player');
const { mergeOwnedItems } = require('./wallet');

// ==================== ADMIN ENDPOINTS ====================

// POST /api/store/items - Create new item
router.post('/items', authenticate, async (req, res, next) => {
  try {
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

    try {
      await transactionService.recordTransaction({
        transactionHash: result.txHash,
        playerId: req.player._id,
        playerAddress: req.player.walletAddress,
        itemId: 0,
        itemName: name,
        priceETH: String(priceETH),
        priceWei: blockchainService.toWei(priceETH).toString(),
        status: 'confirmed',
        chainId: 11155111,
        contractAddress: process.env.SMART_STORE_ADDRESS,
        methodName: 'createItem',
        type: 'admin_action',
        metadata: { isAvailable, name },
      });
    } catch (txErr) {
      console.warn('[Store] Admin action transaction record failed:', txErr.message);
    }

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

    try {
      await transactionService.recordTransaction({
        transactionHash: result.txHash,
        playerId: req.player._id,
        playerAddress: req.player.walletAddress,
        itemId: numericItemId,
        itemName: `item_${numericItemId}`,
        priceETH: String(priceETH),
        priceWei: blockchainService.toWei(priceETH).toString(),
        status: 'confirmed',
        chainId: 11155111,
        contractAddress: process.env.SMART_STORE_ADDRESS,
        methodName: 'setItemPrice',
        type: 'admin_action',
        metadata: { itemId: numericItemId, priceETH },
      });
    } catch (txErr) {
      console.warn('[Store] Admin action transaction record failed:', txErr.message);
    }

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

    try {
      await transactionService.recordTransaction({
        transactionHash: result.txHash,
        playerId: req.player._id,
        playerAddress: req.player.walletAddress,
        itemId: numericItemId,
        itemName: `item_${numericItemId}`,
        priceETH: '0',
        priceWei: '0',
        status: 'confirmed',
        chainId: 11155111,
        contractAddress: process.env.SMART_STORE_ADDRESS,
        methodName: 'toggleItemAvailability',
        type: 'admin_action',
        metadata: { itemId: numericItemId, available: result.isAvailable },
      });
    } catch (txErr) {
      console.warn('[Store] Admin action transaction record failed:', txErr.message);
    }

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

    try {
      await transactionService.recordTransaction({
        transactionHash: result.txHash,
        playerId: req.player._id,
        playerAddress: req.player.walletAddress,
        itemId: numericItemId,
        itemName: name || currentItem.name,
        priceETH: priceETH !== undefined ? String(priceETH) : String(currentItem.price),
        priceWei: priceETH !== undefined ? blockchainService.toWei(priceETH).toString() : currentItem.priceWei || '0',
        status: 'confirmed',
        chainId: 11155111,
        contractAddress: process.env.SMART_STORE_ADDRESS,
        methodName: 'updateItem',
        type: 'admin_action',
        metadata: { isAvailable: isAvailable !== undefined ? isAvailable : currentItem.isAvailable },
      });
    } catch (txErr) {
      console.warn('[Store] Admin action transaction record failed:', txErr.message);
    }

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

    try {
      await transactionService.recordTransaction({
        transactionHash: result.txHash,
        playerId: req.player._id,
        playerAddress: req.player.walletAddress,
        itemId: 0,
        itemName: 'treasury_update',
        priceETH: '0',
        priceWei: '0',
        status: 'confirmed',
        chainId: 11155111,
        contractAddress: process.env.SMART_STORE_ADDRESS,
        methodName: 'setTreasury',
        type: 'admin_action',
        metadata: { treasuryAddress },
      });
    } catch (txErr) {
      console.warn('[Store] Admin action transaction record failed:', txErr.message);
    }

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

// GET /api/store/items - Get all items
router.get('/items', async (req, res, next) => {
  try {
    const items = await blockchainService.getStoreItems();
    return res.json({ success: true, count: items.length, items });
  } catch (err) {
    console.error('[Store] GET /items error:', err.message);
    next(err);
  }
});

// GET /api/store/items/available - Get available items only (must be BEFORE /items/:itemId)
router.get('/items/available', async (req, res, next) => {
  try {
    const items = await blockchainService.getAvailableStoreItems();
    return res.json({ success: true, count: items.length, items });
  } catch (err) {
    console.error('[Store] GET /items/available error:', err.message);
    next(err);
  }
});

// GET /api/store/items/:itemId - Get single item (must be AFTER /items/available)
router.get('/items/:itemId', async (req, res, next) => {
  try {
    const { itemId } = req.params;
    const numericId = parseInt(itemId, 10);

    let item;
    if (!isNaN(numericId) && numericId > 0) {
      try {
        item = await blockchainService.getItem(numericId);
      } catch (e) { /* not found by numeric id */ }
    }

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

// GET /api/store/owned
// Returns the MERGED list of items owned by the player across ALL wallets.
//
// FIX: Previously this called blockchainService.getPlayerItems(walletAddress)
// directly and returned only what the current wallet owns on-chain. That caused
// items purchased by a previous wallet to disappear when the player switched
// wallets.
//
// Now:
//   1. Load player.ownedItems from MongoDB (account-level truth, all wallets).
//   2. Fetch on-chain items for the current wallet.
//   3. MERGE the two sets — never replace — and persist the result.
//   4. Return the merged list.
router.get('/owned', async (req, res, next) => {
  try {
    let playerAddress = null;
    let playerDoc = null;

    // Try to resolve the authenticated player document
    if (req.headers.authorization) {
      try {
        const authService = require('../services/unityAuthService');
        const player = await authService.verifyToken(
          req.headers.authorization.replace('Bearer ', '')
        );
        if (player) {
          playerDoc = await Player.findById(player._id || player.id);
          playerAddress = playerDoc?.walletAddress;
        }
      } catch (e) { /* auth failed — continue to query param fallback */ }
    }

    // Fallback: wallet address from query param or header
    const queryWallet = (
      req.query.walletAddress ||
      req.headers['x-wallet-address']
    )?.toLowerCase();

    if (queryWallet && !playerDoc) {
      // Try to find the player document by this wallet address so we can
      // read and merge ownedItems from MongoDB
      playerDoc = await Player.findOne({ walletAddress: queryWallet });
    }

    playerAddress = playerAddress || queryWallet;

    if (!playerAddress) {
      return res.status(400).json({
        success: false,
        message: 'Wallet address is required. Provide via auth token, query param (walletAddress), or header (x-wallet-address)',
      });
    }

    playerAddress = playerAddress.toLowerCase();
    console.log(`[Store] GET /owned for wallet: ${playerAddress}`);

    // Start with MongoDB ownedItems — preserves all previous wallet purchases
    let ownedItemIds = playerDoc?.ownedItems || [];

    // Fetch what this wallet currently owns on-chain and merge in
    try {
      const onChainItems = await blockchainService.getPlayerItems(playerAddress);
      const onChainIds = onChainItems.map(item => item.itemIdStr || item.itemId?.toString());

      if (playerDoc) {
        // Persist the merge so future requests have the full list in MongoDB
        ownedItemIds = await mergeOwnedItems(playerDoc, onChainIds);
      } else {
        // No player document found — return union without persisting
        const merged = new Set([...ownedItemIds, ...onChainIds]);
        ownedItemIds = Array.from(merged);
      }

      console.log(`[Store] /owned onChain=${onChainIds.length} merged total=${ownedItemIds.length}`);
    } catch (chainErr) {
      // Non-fatal — return MongoDB snapshot if on-chain call fails
      console.warn('[Store] /owned on-chain fetch failed, returning MongoDB snapshot:', chainErr.message);
    }

    return res.json({
      success: true,
      ownedItems: ownedItemIds,
      count: ownedItemIds.length,
      walletAddress: playerAddress,
    });

  } catch (err) {
    console.error('[Store] GET /owned error:', err.message);
    next(err);
  }
});

// GET /api/store/player/:playerAddress/items - Get player's owned items (on-chain only)
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

// GET /api/store/player/:playerAddress/items/:itemId/owns - Check if player owns item (on-chain)
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