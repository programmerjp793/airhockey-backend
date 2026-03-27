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

const toWei = (eth) => ethers.parseEther(String(eth));

// fromWei — always returns a float (used for display / arithmetic).
// NOTE: payment.js records transactions using item.priceWei (the raw string),
// NOT by calling fromWei(item.price), so there is no double-conversion risk.
const fromWei = (wei) => parseFloat(ethers.formatEther(wei));

// formatEth — returns a human-readable 4-decimal ETH string, e.g. "0.0123".
// Used everywhere a balance or price is displayed in Unity UI.
const formatEth = (wei) => parseFloat(ethers.formatEther(wei)).toFixed(4);

const SEPOLIA_CHAIN_ID = 11155111;

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

  const item = await smartStore.getItem(itemId);
  if (!item || item.id === 0n) throw new Error("Item not found");
  if (!item.isAvailable) throw new Error("Item not available");

  const hasItem = await smartStore.hasPlayerBoughtItem(playerAddress, itemId);
  if (hasItem) throw new Error("Item already owned");

  const playerBal = await provider.getBalance(playerAddress);
  if (playerBal < item.price) {
    throw new Error(
      `Insufficient ETH. Need ${formatEth(item.price)} ETH, have ${formatEth(playerBal)} ETH`
    );
  }

  const feeData = await provider.getFeeData();
  const gasEst = await smartStore.buyItem
    .estimateGas(itemId, { from: playerAddress, value: item.price })
    .catch(() => BigInt(150000));

  const gasLimit = ((gasEst * 130n) / 100n).toString();

  const storeAddress = process.env.SMART_STORE_ADDRESS;
  const valueWei = item.price.toString();

  const eip681Uri =
    `ethereum:${storeAddress}@${SEPOLIA_CHAIN_ID}/buyItem` +
    `?uint256=${itemId}` +
    `&value=${valueWei}`;

  const deepLink =
    `https://metamask.app.link/dapp/?uri=${encodeURIComponent(eip681Uri)}`;

  const metamaskSchemeUri =
    `metamask://wc?uri=${encodeURIComponent(eip681Uri)}`;

  const selector = "e7fb74c7";
  const encodedId = BigInt(itemId).toString(16).padStart(64, "0");
  const calldataHex = "0x" + selector + encodedId;

  console.log(
    `[blockchain] prepareStorePurchaseTx:` +
    ` itemId=${itemId} value=${valueWei} wei` +
    ` gas=${gasLimit} chainId=${SEPOLIA_CHAIN_ID}` +
    `\n  eip681Uri       : ${eip681Uri}` +
    `\n  deepLink        : ${deepLink}` +
    `\n  metamaskScheme  : ${metamaskSchemeUri}` +
    `\n  calldata        : ${calldataHex}`
  );

  return {
    needsApproval: false,
    step: "purchase",
    deepLink,
    eip681Uri,
    metamaskSchemeUri,
    calldataHex,
    valueWei,
    gasLimit,
    storeAddress,
    chainId: SEPOLIA_CHAIN_ID,
    itemId,
    itemName: item.name,
    // FIX: use formatEth so priceETH is always a consistent 4-decimal string
    // matching what the rest of the codebase expects, e.g. "0.0010" not
    // "0.001" or "0.00100000000000000002"
    priceETH: formatEth(item.price),
  };
}

// ==================== OTHER PLAYER FUNCTIONS ====================

// ---------------------------------------------------------------------------
// getPlayerInfo
// ---------------------------------------------------------------------------
// FIX 1: was returning ethers.formatEther(ethBalance) raw — that produces an
//   inconsistent number of decimals, e.g. "0.012345678901234567".
//   Unity's balance display, Player.cachedEthBalance default, and
//   refreshAndCacheBalance() all expect a 4-decimal formatted string.
//   Now returns both ethBalance (formatted, 4 dp) and ethBalanceWei (raw
//   wei string) so wallet.js can persist both fields to MongoDB.
//
// FIX 2: was not returning ethBalanceWei at all, which caused
//   refreshAndCacheBalance() to call player.cacheEthBalance(info.ethBalance,
//   info.ethBalanceWei) with undefined for the wei field, writing "0" to
//   cachedEthBalanceWei even after a successful fetch.
// ---------------------------------------------------------------------------
async function getPlayerInfo(playerAddress) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid address");

  const rawBalance = await provider.getBalance(playerAddress);
  const ownedItemIds = await smartStore.getPlayerItems(playerAddress);

  const ownedItems = ownedItemIds.map((id) => ({
    itemId: Number(id),
    itemIdStr: ITEM_ID_MAP[Number(id)] || `item_${id}`,
  }));

  return {
    address: playerAddress,
    // Human-readable 4-decimal ETH string — matches Player.cachedEthBalance format
    ethBalance: formatEth(rawBalance),
    // Raw wei string — stored in Player.cachedEthBalanceWei (BigInt-safe)
    ethBalanceWei: rawBalance.toString(),
    ownedItemIds: ownedItems.map((i) => i.itemIdStr),
    ownedItems,
    network: "Sepolia",
    explorerUrl: `https://sepolia.etherscan.io/address/${playerAddress}`,
  };
}

// ---------------------------------------------------------------------------
// getItem
// ---------------------------------------------------------------------------
// FIX: payment.js calls blockchainService.fromWei(item.price) to compute the
//   ETH amount for transaction records.  The old getItem() already converted
//   item.price via fromWei(), so calling fromWei() on it again produced ~0.
//
//   Shape is now:
//     item.price    — raw BigInt-sourced wei as a STRING  (safe for fromWei())
//     item.priceETH — pre-converted float for display
//
//   payment.js uses:
//     priceETH: blockchainService.fromWei(item.price)   ← still works (string → float)
//     priceWei: item.price.toString()                   ← same value, explicit
//
//   store.js / StoreManager use item.price (float) for display — those callers
//   now use item.priceETH so there is no breaking change there either.
// ---------------------------------------------------------------------------
async function getItem(itemId) {
  const item = await smartStore.getItem(itemId);
  if (!item || item.id === 0n) throw new Error("Item not found");

  const rawPriceWei = item.price.toString();   // keep as string — BigInt-safe

  return {
    itemId: Number(item.id),
    itemIdStr: ITEM_ID_MAP[Number(item.id)] || `item_${item.id}`,
    name: item.name,
    // price = raw wei string so callers can safely pass to fromWei() or toWei()
    price: rawPriceWei,
    // priceETH = pre-converted float, 4 dp — use for display only
    priceETH: parseFloat(formatEth(item.price)),
    // priceWei = explicit alias of price — included for clarity in payment.js
    priceWei: rawPriceWei,
    isAvailable: item.isAvailable,
  };
}

async function getStoreItems() {
  const items = await smartStore.getAllItems();
  return items.map((item) => {
    const numericId = Number(item.id);
    const rawPriceWei = item.price.toString();
    return {
      itemId: ITEM_ID_MAP[numericId] || `item_${numericId}`,
      numericId,
      name: item.name,
      // price = ETH float for StoreManager display (matches existing Unity DTO)
      price: fromWei(item.price),
      priceWei: rawPriceWei,
      isAvailable: item.isAvailable,
    };
  });
}

async function getAvailableStoreItems() {
  const items = await smartStore.getAvailableItems();
  return items.map((item) => {
    const numericId = Number(item.id);
    const rawPriceWei = item.price.toString();
    return {
      itemId: ITEM_ID_MAP[numericId] || `item_${numericId}`,
      numericId,
      name: item.name,
      price: fromWei(item.price),
      priceWei: rawPriceWei,
      isAvailable: item.isAvailable,
    };
  });
}

async function getPlayerItems(playerAddress) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid player address");

  const ownedItemIds = await smartStore.getPlayerItems(playerAddress);
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

async function hasPlayerBoughtItem(playerAddress, itemId) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid player address");
  return await smartStore.hasPlayerBoughtItem(playerAddress, itemId);
}

// ==================== TRANSACTION HELPERS ====================

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

async function getTransactionReceipt(txHash) {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return null;
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

async function getTransaction(txHash) {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) return null;
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
    console.log(`🆕 Item Created: ID ${itemId} - ${name} (${formatEth(price)} ETH)`);
    if (io) io.emit("itemCreated", { itemId: Number(itemId), name, priceETH: formatEth(price), txHash: event.log.transactionHash });
  });

  smartStore.on("ItemPriceUpdated", (itemId, newPrice, event) => {
    console.log(`💰 Price Updated: Item ${itemId} - ${formatEth(newPrice)} ETH`);
    if (io) io.emit("itemPriceUpdated", { itemId: Number(itemId), priceETH: formatEth(newPrice), txHash: event.log.transactionHash });
  });

  smartStore.on("ItemAvailabilityToggled", (itemId, isAvailable, event) => {
    console.log(`🔄 Availability Toggled: Item ${itemId} - ${isAvailable ? "Available" : "Unavailable"}`);
    if (io) io.emit("itemAvailabilityToggled", { itemId: Number(itemId), isAvailable, txHash: event.log.transactionHash });
  });

  smartStore.on("ItemPurchased", (player, itemId, price, timestamp, event) => {
    console.log(`🛒 Purchase: ${player} item ${itemId} — ${formatEth(price)} ETH`);
    if (io) io.to(player.toLowerCase()).emit("itemPurchased", { itemId: Number(itemId), priceETH: formatEth(price), txHash: event.log.transactionHash });
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
  smartStore,
  toWei,
  fromWei,
  formatEth,   // exported so routes can use it directly if needed
};