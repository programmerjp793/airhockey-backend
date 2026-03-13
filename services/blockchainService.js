// services/blockchainService.js — Native ETH only
const { ethers } = require("ethers");
require("dotenv").config();

// FIX: Hardhat artifacts store the ABI nested under a .abi property.
// Extract it — ethers.Contract() needs a plain array, not the full artifact object.
const RewardEngineArtifact = require("../abis/RewardEngine.json");
const SmartStoreArtifact   = require("../abis/SmartStore.json");

const RewardEngineABI = RewardEngineArtifact.abi ?? RewardEngineArtifact;
const SmartStoreABI   = SmartStoreArtifact.abi   ?? SmartStoreArtifact;

const provider     = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
const backendWallet = new ethers.Wallet(process.env.BACKEND_SIGNER_PRIVATE_KEY, provider);

const rewardEngine = new ethers.Contract(process.env.REWARD_ENGINE_ADDRESS, RewardEngineABI, backendWallet);
const smartStore   = new ethers.Contract(process.env.SMART_STORE_ADDRESS, SmartStoreABI, backendWallet);

const toWei   = (eth) => ethers.parseEther(String(eth));
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

// A. Reward player with native ETH
async function rewardPlayer(playerAddress, amountETH, reason = "match_win") {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid player address");
  const poolBal = await rewardEngine.getRewardPoolBalance();
  if (poolBal < toWei(amountETH))
    throw new Error(`Reward pool low. Has ${fromWei(poolBal)} ETH, need ${amountETH} ETH`);

  const tx      = await rewardEngine.rewardPlayer(playerAddress, toWei(amountETH), reason);
  const receipt = await waitForTx(tx, "RewardPlayer");
  return { txHash: receipt.hash, player: playerAddress, amountETH, reason,
    explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.hash}` };
}

// B. Record fiat purchase on-chain (no ETH burn)
async function processFiatPurchase(playerAddress, fiatCentavos, providerName, referenceId) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid player address");
  if (await rewardEngine.isRefProcessed(referenceId))
    throw new Error(`Reference ${referenceId} already processed`);

  const tx      = await rewardEngine.processFiatPurchase(playerAddress, fiatCentavos, providerName, referenceId);
  const receipt = await waitForTx(tx, "FiatPurchase");
  return { txHash: receipt.hash, player: playerAddress, fiatCentavos, provider: providerName, referenceId,
    explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.hash}` };
}

// C. Prepare store purchase TX data for MetaMask Mobile deep link
async function prepareStorePurchaseTx(playerAddress, itemId) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid player address");

  const items = await smartStore.getAllItems();
  const item  = items.find(i => Number(i.id) === Number(itemId));
  if (!item || !item.active) throw new Error("Item not found or inactive");

  const playerTier = await smartStore.playerTier(playerAddress);
  if (item.tier > 0 && Number(playerTier) !== Number(item.tier) - 1)
    throw new Error(`Must own Tier ${item.tier - 1} upgrade first`);

  const playerBal = await provider.getBalance(playerAddress);
  if (playerBal < item.priceETH)
    throw new Error(`Insufficient ETH. Need ${fromWei(item.priceETH)}, have ${fromWei(playerBal)}`);

  if (await smartStore.playerOwns(playerAddress, itemId))
    throw new Error("Item already owned");

  const feeData = await provider.getFeeData();
  const gasEst  = await smartStore.purchaseItem.estimateGas(itemId,
    { from: playerAddress, value: item.priceETH }).catch(() => BigInt(120000));

  // purchaseItem(uint256) 4-byte selector + encoded itemId
  const selector  = "0x4b0e280e";
  const encodedId = BigInt(itemId).toString(16).padStart(64, "0");
  const callData  = selector + encodedId;

  const params  = new URLSearchParams({
    to: process.env.SMART_STORE_ADDRESS, data: callData,
    value: item.priceETH.toString(), chainId: "0xaa36a7",
    gasLimit: ((gasEst * 120n) / 100n).toString(),
  });
  const deepLink = `metamask://send?${params.toString()}`;

  return {
    needsApproval: false,
    step:          "purchase",
    storeAddress:  process.env.SMART_STORE_ADDRESS,
    chainId:       11155111,
    chainIdHex:    "0xaa36a7",
    itemId:        Number(item.id),
    itemName:      item.name,
    itemType:      item.itemType,
    priceETH:      fromWei(item.priceETH),
    priceETHWei:   item.priceETH.toString(),
    pricePHP:      Number(item.pricePHP) / 100,
    tier:          Number(item.tier),
    deepLink,
    gasLimit:      ((gasEst * 120n) / 100n).toString(),
    maxFeePerGas:  feeData.maxFeePerGas?.toString(),
    explorerBase:  "https://sepolia.etherscan.io",
    message:       `Sign to purchase: ${item.name} (${fromWei(item.priceETH)} ETH)`,
  };
}

// D. Get player info
async function getPlayerInfo(playerAddress) {
  if (!ethers.isAddress(playerAddress)) throw new Error("Invalid address");

  const ethBalance           = await provider.getBalance(playerAddress);
  const [, tier, ownedFlags] = await smartStore.getPlayerInfo(playerAddress);
  const storeItems           = await smartStore.getActiveItems();
  const rewardPool           = await rewardEngine.getRewardPoolBalance();

  // Build ownedItemIds — list of string itemIds the player owns
  const ownedItemIds = ownedFlags
    .map((owned, i) => owned ? (ITEM_ID_MAP[Number(storeItems[i]?.id)] || `item_${i + 1}`) : null)
    .filter(Boolean);

  return {
    address:       playerAddress,
    ethBalance:    ethers.formatEther(ethBalance),
    tier:          Number(tier),
    ownedItemIds,
    ownedItems:    ownedFlags.map((owned, i) => ({
      itemId: Number(storeItems[i]?.id || i + 1),
      owned,
    })),
    rewardPoolETH: fromWei(rewardPool),
    network:       "Sepolia",
    explorerUrl:   `https://sepolia.etherscan.io/address/${playerAddress}`,
  };
}

// E. Get store items
// FIX: added itemId (string), numericId, priceETHFormatted, active fields
async function getStoreItems() {
  const items = await smartStore.getActiveItems();
  return items.map(item => {
    const numericId = Number(item.id);
    return {
      itemId:            ITEM_ID_MAP[numericId] || `item_${numericId}`,
      numericId,
      name:              item.name,
      itemType:          item.itemType,
      priceETH:          fromWei(item.priceETH),
      priceETHFormatted: fromWei(item.priceETH).toFixed(4),
      pricePHP:          Number(item.pricePHP) / 100,
      tier:              Number(item.tier),
      active:            true,   // getActiveItems() only returns active items
    };
  });
}

// F. Deposit to reward pool
async function depositRewardPool(amountETH) {
  const tx = await rewardEngine.depositRewardPool({ value: toWei(amountETH) });
  const receipt = await waitForTx(tx, "DepositRewardPool");
  return { txHash: receipt.hash, amountETH,
    explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.hash}` };
}

// G. Event listeners
function startEventListeners(io) {
  rewardEngine.on("RewardSent", (player, amount, reason, ts, event) => {
    console.log(`🏆 Reward: ${player} +${fromWei(amount)} ETH | ${reason}`);
    if (io) io.to(player.toLowerCase()).emit("reward",
      { amountETH: fromWei(amount), reason, txHash: event.log.transactionHash });
  });
  rewardEngine.on("FiatPurchaseProcessed", (player, fiatAmt, prov, refId, ts, event) => {
    console.log(`💳 Fiat: ${player} | ₱${fiatAmt / 100} | ${prov}`);
    if (io) io.to(player.toLowerCase()).emit("fiatProcessed",
      { provider: prov, referenceId: refId, txHash: event.log.transactionHash });
  });
  smartStore.on("ItemPurchased", (player, itemId, itemType, price, ts, event) => {
    console.log(`🛒 Purchase: ${player} item ${itemId} — ${fromWei(price)} ETH`);
    if (io) io.to(player.toLowerCase()).emit("itemPurchased",
      { itemId: Number(itemId), itemType, priceETH: fromWei(price), txHash: event.log.transactionHash });
  });
  console.log("📡 Blockchain event listeners active on Sepolia");
}

module.exports = { rewardPlayer, processFiatPurchase, prepareStorePurchaseTx,
  getPlayerInfo, getStoreItems, depositRewardPool, startEventListeners, provider, toWei, fromWei };