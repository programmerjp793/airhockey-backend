// services/blockchainService.js — Native ETH only, for new SmartStore.sol
const { ethers } = require("ethers");
require("dotenv").config();

// FIX: Hardhat artifacts store the ABI nested under a .abi property.
// Extract it — ethers.Contract() needs a plain array, not the full artifact object.
const SmartStoreArtifact = require("../abis/SmartStore.json");

const SmartStoreABI = SmartStoreArtifact.abi ?? SmartStoreArtifact;

const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);

// Use provider for read-only operations, wallet only when private key is available
let signer = provider;
if (process.env.BACKEND_SIGNER_PRIVATE_KEY) {
  signer = new ethers.Wallet(process.env.BACKEND_SIGNER_PRIVATE_KEY, provider);
}

const smartStore = new ethers.Contract(process.env.SMART_STORE_ADDRESS, SmartStoreABI, signer);

// Wei conversion functions
const toWei = (eth) => ethers.parseEther(String(eth));
const fromWei = (wei) => parseFloat(ethers.formatEther(wei));

// Maps numeric contract ID → string itemId used by Unity/backend
const ITEM_ID_MAP = {
  1: "wallet_upgrade_1",
  2: "wallet_upgrade_2",
  3: "ai_replay",
  4: "custom_skin",
};

async function waitForTx(tx, label) {
  console.log(`⏳ ${label}: ${tx.hash}`);
  const receipt = await tx.wait(1);
  console.log(`✅ ${label} confirmed — block ${receipt.blockNumber}`);
  return receipt;
}

// ==================== ADMIN FUNCTIONS ====================

// Create a new item in the store
async function createItem(name, priceETH, isAvailable) {
  const priceWei = toWei(priceETH);
  const tx = await smartStore.createItem(name, priceWei, isAvailable);
  const receipt = await waitForTx(tx, "CreateItem");
  return {
    txHash: receipt.hash,
    name,
    priceETH,
    isAvailable,
    explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.hash}`,
  };
}

// Set item price
async function setItemPrice(itemId, priceETH) {
  const priceWei = toWei(priceETH);
  const tx = await smartStore.setItemPrice(itemId, priceWei);
  const receipt = await waitForTx(tx, "SetItemPrice");
  return {
    txHash: receipt.hash,
    itemId,
    priceETH,
    explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.hash}`,
  };
}

// Toggle item availability
async function toggleItemAvailability(itemId) {
  const tx = await smartStore.toggleItemAvailability(itemId);
  const receipt = await waitForTx(tx, "ToggleItemAvailability");
  return {
    txHash: receipt.hash,
    itemId,
    explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.hash}`,
  };
}

// Update multiple item properties at once
async function updateItem(itemId, name, priceETH, isAvailable) {
  const priceWei = priceETH > 0 ? toWei(priceETH) : 0;
  const tx = await smartStore.updateItem(itemId, name, priceWei, isAvailable);
  const receipt = await waitForTx(tx, "UpdateItem");
  return {
    txHash: receipt.hash,
    itemId,
    name,
    priceETH,
    isAvailable,
    explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.hash}`,
  };
}

// Set treasury address
async function setTreasury(treasuryAddress) {
  if (!ethers.isAddress(treasuryAddress)) throw new Error("Invalid treasury address");
  const tx = await smartStore.setTreasury(treasuryAddress);
  const receipt = await waitForTx(tx, "SetTreasury");
  return {
    txHash: receipt.hash,
    treasuryAddress,
    explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.hash}`,
  };
}

// ==================== PLAYER FUNCTIONS ====================

// Prepare store purchase TX data for MetaMask Mobile deep link
async function prepareStorePurchaseTx(playerAddress, itemId) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid player address");

  // Get item details
  const item = await smartStore.getItem(itemId);
  if (!item || item.id === 0) throw new Error("Item not found");
  if (!item.isAvailable) throw new Error("Item not available");

  // Check if player already owns the item
  const hasItem = await smartStore.hasPlayerBoughtItem(playerAddress, itemId);
  if (hasItem) throw new Error("Item already owned");

  // Check player balance
  const playerBal = await provider.getBalance(playerAddress);
  if (playerBal < item.price) {
    throw new Error(`Insufficient ETH. Need ${fromWei(item.price)}, have ${fromWei(playerBal)}`);
  }

  const feeData = await provider.getFeeData();
  const gasEst = await smartStore.buyItem.estimateGas(itemId, { from: playerAddress, value: item.price }).catch(() => BigInt(120000));

  // buyItem(uint256) 4-byte selector + encoded itemId
  const selector = "0xe7fb74c7"; // FIX: was 0xd38ea5bf which is incorrect
  const encodedId = BigInt(itemId).toString(16).padStart(64, "0");
  const callData = selector + encodedId;

  const storeAddress = process.env.SMART_STORE_ADDRESS;
  const valueWei = item.price.toString();
  const gasLimit = ((gasEst * 120n) / 100n).toString();

  // FIX: MetaMask Mobile deep link format with redirectUrl so MetaMask returns to the app
  // after the user signs the transaction. The redirect carries the txHash back via
  // airhockey://tx-callback?hash=<txHash> which is handled in WalletManager.OnDeepLinkActivated.
  const redirectUrl = encodeURIComponent("airhockey://tx-callback");
  const deepLink = `metamask://send/${storeAddress}@11155111?value=${valueWei}&data=${callData}&gasLimit=${gasLimit}&redirectUrl=${redirectUrl}`;

  return {
    needsApproval: false,
    step: "purchase",
    storeAddress,
    chainId: 11155111,
    chainIdHex: "0xaa36a7",
    itemId: Number(item.id),
    itemName: item.name,
    priceETH: fromWei(item.price),
    priceETHWei: valueWei,
    // expectedPrice / expectedPriceWei are the canonical fields used by Unity
    // to verify the amount before signing (matches the full-flow spec).
    expectedPrice: fromWei(item.price),
    expectedPriceWei: valueWei,
    isAvailable: item.isAvailable,
    deepLink,
    gasLimit,
    maxFeePerGas: feeData.maxFeePerGas?.toString(),
    explorerBase: "https://sepolia.etherscan.io",
    message: `Sign to purchase: ${item.name} (${fromWei(item.price)} ETH)`,
  };
}

// Get player info
async function getPlayerInfo(playerAddress) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid address");

  const ethBalance = await provider.getBalance(playerAddress);

  // Get player's owned items
  const ownedItemIds = await smartStore.getPlayerItems(playerAddress);

  // Build ownedItemIds as string array
  const ownedItems = ownedItemIds.map((id) => ({
    itemId: Number(id),
    itemIdStr: ITEM_ID_MAP[Number(id)] || `item_${id}`,
  }));

  return {
    address: playerAddress,
    ethBalance: ethers.formatEther(ethBalance),
    ownedItemIds: ownedItems.map((i) => i.itemIdStr),
    ownedItems,
    network: "Sepolia",
    explorerUrl: `https://sepolia.etherscan.io/address/${playerAddress}`,
  };
}

// Get single item details
async function getItem(itemId) {
  const item = await smartStore.getItem(itemId);
  if (!item || item.id === 0) throw new Error("Item not found");
  
  return {
    itemId: Number(item.id),
    itemIdStr: ITEM_ID_MAP[Number(item.id)] || `item_${item.id}`,
    name: item.name,
    price: fromWei(item.price),
    priceWei: item.price.toString(),
    isAvailable: item.isAvailable,
  };
}

// Get all store items
async function getStoreItems() {
  const items = await smartStore.getAllItems();
  return items.map((item) => {
    const numericId = Number(item.id);
    return {
      itemId: ITEM_ID_MAP[numericId] || `item_${numericId}`,
      numericId,
      name: item.name,
      price: fromWei(item.price),
      priceWei: item.price.toString(),
      isAvailable: item.isAvailable,
    };
  });
}

// Get available store items only
async function getAvailableStoreItems() {
  const items = await smartStore.getAvailableItems();
  return items.map((item) => {
    const numericId = Number(item.id);
    return {
      itemId: ITEM_ID_MAP[numericId] || `item_${numericId}`,
      numericId,
      name: item.name,
      price: fromWei(item.price),
      priceWei: item.price.toString(),
      isAvailable: item.isAvailable,
    };
  });
}

// Get player's owned items
async function getPlayerItems(playerAddress) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid player address");
  
  const ownedItemIds = await smartStore.getPlayerItems(playerAddress);
  
  // Get full item details for each owned item
  const ownedItems = [];
  for (const itemId of ownedItemIds) {
    const item = await smartStore.getItem(itemId);
    ownedItems.push({
      itemId: Number(item.id),
      itemIdStr: ITEM_ID_MAP[Number(item.id)] || `item_${item.id}`,
      name: item.name,
      price: fromWei(item.price),
      priceWei: item.price.toString(),
      isAvailable: item.isAvailable,
    });
  }
  
  return ownedItems;
}

// Check if player owns a specific item
async function hasPlayerBoughtItem(playerAddress, itemId) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid player address");
  return await smartStore.hasPlayerBoughtItem(playerAddress, itemId);
}

// ==================== TRANSACTION HELPERS ====================

// Wait for transaction receipt with configurable confirmations and timeout
async function waitForTransaction(txHash, confirmations = 1, timeoutMs = 60000) {
  try {
    const receipt = await provider.waitForTransaction(txHash, confirmations, timeoutMs);
    return {
      txHash: receipt.hash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed?.toString(),
      confirmations: receipt.confirmations,
      from: receipt.from,
      to: receipt.to,
      logs: receipt.logs,
    };
  } catch (error) {
    console.error(`Error waiting for transaction ${txHash}:`, error.message);
    throw error;
  }
}

// Get transaction receipt without waiting (returns null if pending/not found)
async function getTransactionReceipt(txHash) {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return null;
    }
    return {
      txHash: receipt.hash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed?.toString(),
      confirmations: receipt.confirmations,
      from: receipt.from,
      to: receipt.to,
    };
  } catch (error) {
    console.error(`Error getting transaction receipt for ${txHash}:`, error.message);
    throw error;
  }
}

// Get raw transaction data for verification
async function getTransaction(txHash) {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      return null;
    }
    return {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      value: tx.value?.toString(),
      gasLimit: tx.gasLimit?.toString(),
      gasPrice: tx.gasPrice?.toString(),
      nonce: tx.nonce,
      chainId: tx.chainId,
      data: tx.data,
    };
  } catch (error) {
    console.error(`Error getting transaction ${txHash}:`, error.message);
    throw error;
  }
}

// Get current block number for confirmation counting
async function getCurrentBlockNumber() {
  try {
    return await provider.getBlockNumber();
  } catch (error) {
    console.error("Error getting current block number:", error.message);
    throw error;
  }
}

// ==================== EVENT LISTENERS ====================

function startEventListeners(io) {
  smartStore.on("ItemCreated", (itemId, name, price, event) => {
    console.log(`🆕 Item Created: ID ${itemId} - ${name} (${fromWei(price)} ETH)`);
    if (io) io.emit("itemCreated", { itemId: Number(itemId), name, priceETH: fromWei(price), txHash: event.log.transactionHash });
  });

  smartStore.on("ItemPriceUpdated", (itemId, newPrice, event) => {
    console.log(`💰 Price Updated: Item ${itemId} - ${fromWei(newPrice)} ETH`);
    if (io) io.emit("itemPriceUpdated", { itemId: Number(itemId), priceETH: fromWei(newPrice), txHash: event.log.transactionHash });
  });

  smartStore.on("ItemAvailabilityToggled", (itemId, isAvailable, event) => {
    console.log(`🔄 Availability Toggled: Item ${itemId} - ${isAvailable ? "Available" : "Unavailable"}`);
    if (io) io.emit("itemAvailabilityToggled", { itemId: Number(itemId), isAvailable, txHash: event.log.transactionHash });
  });

  smartStore.on("ItemPurchased", (player, itemId, price, timestamp, event) => {
    console.log(`🛒 Purchase: ${player} item ${itemId} — ${fromWei(price)} ETH`);
    if (io) io.to(player.toLowerCase()).emit("itemPurchased", { itemId: Number(itemId), priceETH: fromWei(price), txHash: event.log.transactionHash });
  });

  console.log("📡 Blockchain event listeners active on Sepolia");
}

module.exports = {
  // Admin functions
  createItem,
  setItemPrice,
  toggleItemAvailability,
  updateItem,
  setTreasury,
  // Player functions
  prepareStorePurchaseTx,
  getPlayerInfo,
  getItem,
  getStoreItems,
  getAvailableStoreItems,
  getPlayerItems,
  hasPlayerBoughtItem,
  // Utilities
  startEventListeners,
  // Transaction helpers
  waitForTransaction,
  getTransactionReceipt,
  getTransaction,
  getCurrentBlockNumber,
  // Provider & conversion
  provider,
  toWei,
  fromWei,
};