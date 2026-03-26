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

const toWei   = (eth) => ethers.parseEther(String(eth));
const fromWei = (wei) => parseFloat(ethers.formatEther(wei));

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

// ---------------------------------------------------------------------------
// prepareStorePurchaseTx
// ---------------------------------------------------------------------------
// ROOT CAUSE OF "Transfer request" + wrong network bug (from screenshots):
//
// ❌ OLD (broken):
//   metamask.app.link/send/<address>?value=...&data=...
//   • /send/ scheme = plain ETH transfer only, strips &data= silently
//   • No chainId support → defaults to whatever network MetaMask has active
//   • Result: ETH sent but buyItem() never called, ownership never recorded
//
// ✅ NEW (fixed): EIP-681 URI scheme
//   ethereum:<address>@<chainId>/buyItem?uint256=<itemId>&value=<valueWei>
//   • MetaMask Mobile natively parses EIP-681
//   • @11155111 forces Sepolia — MetaMask prompts to switch if needed
//   • Function name + params shown as "Contract Interaction" in MetaMask UI
//   • MetaMask auto-encodes the calldata from the function name + params
//
// Three URI variants are returned so Unity can try fallbacks:
//   1. eip681Uri          — pure ethereum: scheme (most correct)
//   2. deepLink           — https://metamask.app.link/dapp/?uri=<eip681>
//   3. metamaskSchemeUri  — metamask://wc?uri=<eip681>
//
// Unity should try them in order: deepLink → metamaskSchemeUri → eip681Uri
// ---------------------------------------------------------------------------
async function prepareStorePurchaseTx(playerAddress, itemId) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid player address");

  // ── On-chain validation ─────────────────────────────────────────────────
  const item = await smartStore.getItem(itemId);
  if (!item || item.id === 0n) throw new Error("Item not found");
  if (!item.isAvailable)       throw new Error("Item not available");

  const hasItem = await smartStore.hasPlayerBoughtItem(playerAddress, itemId);
  if (hasItem) throw new Error("Item already owned");

  const playerBal = await provider.getBalance(playerAddress);
  if (playerBal < item.price) {
    throw new Error(
      `Insufficient ETH. Need ${fromWei(item.price)} ETH, have ${fromWei(playerBal)} ETH`
    );
  }

  // ── Gas estimation ──────────────────────────────────────────────────────
  const feeData = await provider.getFeeData();
  const gasEst  = await smartStore.buyItem
    .estimateGas(itemId, { from: playerAddress, value: item.price })
    .catch(() => BigInt(150000));             // safe fallback if estimation fails

  const gasLimit = ((gasEst * 130n) / 100n).toString();  // +30% buffer

  const storeAddress = process.env.SMART_STORE_ADDRESS;
  const valueWei     = item.price.toString();

  // ── EIP-681 URI ─────────────────────────────────────────────────────────
  // Standard: ethereum:<address>@<chainId>/<functionName>?<type>=<value>&value=<wei>
  //
  // MetaMask Mobile parses this and:
  //   • Routes to Sepolia (chainId=11155111), prompts switch if on wrong network
  //   • Encodes calldata as buyItem(uint256) automatically from the params
  //   • Shows "Contract Interaction" with the function name in its UI
  //   • Attaches `value` (ETH) to the transaction
  const eip681Uri =
    `ethereum:${storeAddress}@${SEPOLIA_CHAIN_ID}/buyItem` +
    `?uint256=${itemId}` +         // the uint256 argument to buyItem
    `&value=${valueWei}`;          // ETH value in wei (payable)

  // ── Deep link variants ──────────────────────────────────────────────────

  // Option A: HTTPS universal link — opens MetaMask app then passes the URI
  // Use this as primary in Unity Application.OpenURL()
  const deepLink =
    `https://metamask.app.link/dapp/?uri=${encodeURIComponent(eip681Uri)}`;

  // Option B: metamask:// custom scheme — direct app open on Android/iOS
  const metamaskSchemeUri =
    `metamask://wc?uri=${encodeURIComponent(eip681Uri)}`;

  // ── Verification calldata (for logging / submit-tx verification) ────────
  // ABI-encode manually to log for debugging:
  //   selector = keccak256("buyItem(uint256)")[0..3] = 0xe7fb74c7
  //   arg      = itemId as uint256 (32 bytes)
  const selector    = "e7fb74c7";
  const encodedId   = BigInt(itemId).toString(16).padStart(64, "0");
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
    step:          "purchase",

    // Primary deep link — use this in Unity Application.OpenURL()
    deepLink,

    // Fallback URIs — try these if deepLink fails to open MetaMask
    eip681Uri,
    metamaskSchemeUri,

    // Debug / downstream verification
    calldataHex,
    valueWei,
    gasLimit,
    storeAddress,
    chainId:   SEPOLIA_CHAIN_ID,
    itemId,
    itemName:  item.name,
    priceETH:  fromWei(item.price),
  };
}

// ==================== OTHER PLAYER FUNCTIONS ====================

async function getPlayerInfo(playerAddress) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid address");

  const ethBalance   = await provider.getBalance(playerAddress);
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
      txHash:        receipt.hash,
      status:        receipt.status,
      blockNumber:   receipt.blockNumber,
      blockHash:     receipt.blockHash,
      gasUsed:       receipt.gasUsed?.toString(),
      confirmations: receipt.confirmations,
      from:          receipt.from,
      to:            receipt.to,
      logs:          receipt.logs,
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
      txHash:        receipt.hash,
      status:        receipt.status,
      blockNumber:   receipt.blockNumber,
      blockHash:     receipt.blockHash,
      gasUsed:       receipt.gasUsed?.toString(),
      confirmations: receipt.confirmations,
      from:          receipt.from,
      to:            receipt.to,
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
  smartStore,
  toWei,
  fromWei,
};