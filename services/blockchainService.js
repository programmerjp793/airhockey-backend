// services/blockchainService.js — Native ETH only, for new SmartStore.sol

const { ethers } = require("ethers");
require("dotenv").config();

const SmartStoreArtifact = require("../abis/SmartStore.json");
const SmartStoreABI = SmartStoreArtifact.abi ?? SmartStoreArtifact;

const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);

let signer = provider;
if (process.env.BACKEND_SIGNER_PRIVATE_KEY) {
  signer = new ethers.Wallet(process.env.BACKEND_SIGNER_PRIVATE_KEY, provider);
}

const smartStore = new ethers.Contract(process.env.SMART_STORE_ADDRESS, SmartStoreABI, signer);

const toWei  = (eth) => ethers.parseEther(String(eth));
const fromWei = (wei) => parseFloat(ethers.formatEther(wei));

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

async function toggleItemAvailability(itemId) {
  const tx = await smartStore.toggleItemAvailability(itemId);
  const receipt = await waitForTx(tx, "ToggleItemAvailability");
  return {
    txHash: receipt.hash,
    itemId,
    explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.hash}`,
  };
}

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

async function prepareStorePurchaseTx(playerAddress, itemId) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid player address");

  // Get item details
  const item = await smartStore.getItem(itemId);
  if (!item || item.id === 0n) throw new Error("Item not found");
  if (!item.isAvailable) throw new Error("Item not available");

  // Check if player already owns the item
  const hasItem = await smartStore.hasPlayerBoughtItem(playerAddress, itemId);
  if (hasItem) throw new Error("Item already owned");

  // Check player balance
  const playerBal = await provider.getBalance(playerAddress);
  if (playerBal < item.price) {
    throw new Error(`Insufficient ETH. Need ${fromWei(item.price)} ETH, have ${fromWei(playerBal)} ETH`);
  }

  // FIX: Validate treasury address before building deep link
  // If treasury is address(0) the contract will always revert on ETH transfer
  const treasuryAddress = await smartStore.treasury();
  if (!treasuryAddress || treasuryAddress === ethers.ZeroAddress) {
    throw new Error("Treasury address not set on contract. Contact admin.");
  }
  console.log(`[blockchain] Treasury: ${treasuryAddress}`);

  // Estimate gas — fall back to 150000 if estimation fails
  let gasEst;
  try {
    gasEst = await smartStore.buyItem.estimateGas(itemId, {
      from:  playerAddress,
      value: item.price,
    });
    console.log(`[blockchain] Gas estimate: ${gasEst}`);
  } catch (gasErr) {
    console.warn(`[blockchain] Gas estimation failed (${gasErr.message}), using fallback 150000`);
    gasEst = BigInt(150000);
  }

  // FIX: Correct selector — confirmed from ABI and deployed bytecode
  // keccak256("buyItem(uint256)") = 0xe7fb74c7
  const selector  = "0xe7fb74c7";
  const encodedId = BigInt(itemId).toString(16).padStart(64, "0");
  const callData  = selector + encodedId;

  const storeAddress = process.env.SMART_STORE_ADDRESS;
  const valueWei     = item.price.toString();
  const gasLimit     = ((gasEst * 130n) / 100n).toString(); // 30% buffer

  // FIX: Use https://metamask.app.link/send/ format instead of metamask://send/
  //
  // metamask://send/ is a legacy scheme that does NOT reliably support:
  //   - contract call data (the `data` param)
  //   - redirectUrl callbacks
  //
  // https://metamask.app.link/send/ is the officially supported universal link
  // that correctly handles contract interactions and works on both iOS and Android.
  //
  // The redirectUrl is embedded so MetaMask returns to the app after signing
  // via airhockey://tx-callback?hash=<txHash>
  const redirectUrl = encodeURIComponent("airhockey://tx-callback");
  const deepLink = `https://metamask.app.link/send/${storeAddress}@11155111?value=${valueWei}&data=${callData}&gasLimit=${gasLimit}&redirectUrl=${redirectUrl}`;

  console.log(`[blockchain] Deep link: ${deepLink}`);

  return {
    success:          true,
    needsApproval:    false,
    step:             "purchase",
    storeAddress,
    chainId:          11155111,
    chainIdHex:       "0xaa36a7",
    itemId:           Number(item.id),
    itemName:         item.name,
    priceETH:         fromWei(item.price),
    priceETHWei:      valueWei,
    expectedPrice:    fromWei(item.price),
    expectedPriceWei: valueWei,
    isAvailable:      item.isAvailable,
    deepLink,
    gasLimit,
    explorerBase:     "https://sepolia.etherscan.io",
    message:          `Sign to purchase: ${item.name} (${fromWei(item.price)} ETH)`,
  };
}

async function getPlayerInfo(playerAddress) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid address");

  const ethBalance  = await provider.getBalance(playerAddress);
  const ownedItemIds = await smartStore.getPlayerItems(playerAddress);

  const ownedItems = ownedItemIds.map((id) => ({
    itemId:    Number(id),
    itemIdStr: ITEM_ID_MAP[Number(id)] || `item_${id}`,
  }));

  return {
    address:      playerAddress,
    ethBalance:   ethers.formatEther(ethBalance),
    ownedItemIds: ownedItems.map((i) => i.itemIdStr),
    ownedItems,
    network:      "Sepolia",
    explorerUrl:  `https://sepolia.etherscan.io/address/${playerAddress}`,
  };
}

async function getItem(itemId) {
  const item = await smartStore.getItem(itemId);
  if (!item || item.id === 0n) throw new Error("Item not found");

  return {
    itemId:      Number(item.id),
    itemIdStr:   ITEM_ID_MAP[Number(item.id)] || `item_${item.id}`,
    name:        item.name,
    price:       fromWei(item.price),
    priceWei:    item.price.toString(),
    isAvailable: item.isAvailable,
  };
}

async function getStoreItems() {
  const items = await smartStore.getAllItems();
  return items.map((item) => {
    const numericId = Number(item.id);
    return {
      itemId:      ITEM_ID_MAP[numericId] || `item_${numericId}`,
      numericId,
      name:        item.name,
      price:       fromWei(item.price),
      priceWei:    item.price.toString(),
      isAvailable: item.isAvailable,
    };
  });
}

async function getAvailableStoreItems() {
  const items = await smartStore.getAvailableItems();
  return items.map((item) => {
    const numericId = Number(item.id);
    return {
      itemId:      ITEM_ID_MAP[numericId] || `item_${numericId}`,
      numericId,
      name:        item.name,
      price:       fromWei(item.price),
      priceWei:    item.price.toString(),
      isAvailable: item.isAvailable,
    };
  });
}

async function getPlayerItems(playerAddress) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid player address");

  const ownedItemIds = await smartStore.getPlayerItems(playerAddress);
  const ownedItems   = [];

  for (const itemId of ownedItemIds) {
    const item = await smartStore.getItem(itemId);
    ownedItems.push({
      itemId:      Number(item.id),
      itemIdStr:   ITEM_ID_MAP[Number(item.id)] || `item_${item.id}`,
      name:        item.name,
      price:       fromWei(item.price),
      priceWei:    item.price.toString(),
      isAvailable: item.isAvailable,
    });
  }

  return ownedItems;
}

async function hasPlayerBoughtItem(playerAddress, itemId) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid player address");
  return await smartStore.hasPlayerBoughtItem(playerAddress, itemId);
}

// ==================== TRANSACTION HELPERS ====================

async function waitForTransaction(txHash, confirmations = 1, timeoutMs = 60000) {
  try {
    const receipt = await provider.waitForTransaction(txHash, confirmations, timeoutMs);
    return {
      txHash:       receipt.hash,
      status:       receipt.status,
      blockNumber:  receipt.blockNumber,
      blockHash:    receipt.blockHash,
      gasUsed:      receipt.gasUsed?.toString(),
      confirmations: receipt.confirmations,
      from:         receipt.from,
      to:           receipt.to,
      logs:         receipt.logs,
    };
  } catch (error) {
    console.error(`Error waiting for transaction ${txHash}:`, error.message);
    throw error;
  }
}

async function getTransactionReceipt(txHash) {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return null;
    return {
      txHash:       receipt.hash,
      status:       receipt.status,
      blockNumber:  receipt.blockNumber,
      blockHash:    receipt.blockHash,
      gasUsed:      receipt.gasUsed?.toString(),
      confirmations: receipt.confirmations,
      from:         receipt.from,
      to:           receipt.to,
    };
  } catch (error) {
    console.error(`Error getting transaction receipt for ${txHash}:`, error.message);
    throw error;
  }
}

async function getTransaction(txHash) {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) return null;
    return {
      hash:     tx.hash,
      from:     tx.from,
      to:       tx.to,
      value:    tx.value?.toString(),
      gasLimit: tx.gasLimit?.toString(),
      gasPrice: tx.gasPrice?.toString(),
      nonce:    tx.nonce,
      chainId:  tx.chainId,
      data:     tx.data,
    };
  } catch (error) {
    console.error(`Error getting transaction ${txHash}:`, error.message);
    throw error;
  }
}

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
  createItem,
  setItemPrice,
  toggleItemAvailability,
  updateItem,
  setTreasury,
  prepareStorePurchaseTx,
  getPlayerInfo,
  getItem,
  getStoreItems,
  getAvailableStoreItems,
  getPlayerItems,
  hasPlayerBoughtItem,
  startEventListeners,
  waitForTransaction,
  getTransactionReceipt,
  getTransaction,
  getCurrentBlockNumber,
  provider,
  toWei,
  fromWei,
};