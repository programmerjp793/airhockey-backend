// services/blockchainService.js
// Node.js → Polygon Amoy Testnet bridge using ethers.js v6

const { ethers } = require("ethers");

// ── Minimal ABIs (only functions we call) ────────────────────────────────────
const TOKEN_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function mint(address to, uint256 amount)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const REWARD_ENGINE_ABI = [
  "function distributeReward(address player, string matchId, string difficulty) external",
  "function isMatchRewarded(string matchId) view returns (bool)",
  "function getRewardForDifficulty(string difficulty) view returns (uint256)",
  "event RewardDistributed(address indexed player, string matchId, string difficulty, uint256 amount)",
];

const SMART_STORE_ABI = [
  "function getAllItems() view returns (tuple(string itemId, string name, string itemType, uint256 priceInTTK, bool active)[])",
  "function doesPlayerOwnItem(address player, string itemId) view returns (bool)",
  "function grantItemAfterFiatPayment(address player, string itemId, string paymentIntentId) external",
  "function purchaseWithToken(string itemId) external",
];

// ── Provider + Signer ─────────────────────────────────────────────────────────
let _provider = null;
let _signer   = null;

function getProvider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(
      process.env.POLYGON_AMOY_RPC_URL || "https://rpc-amoy.polygon.technology/",
      { chainId: 80002, name: "polygon-amoy" }
    );
  }
  return _provider;
}

function getSigner() {
  if (!_signer) {
    _signer = new ethers.Wallet(process.env.BACKEND_SIGNER_PRIVATE_KEY, getProvider());
  }
  return _signer;
}

// ── Contract Instances ────────────────────────────────────────────────────────
function getTokenContract(withSigner = false) {
  const runner = withSigner ? getSigner() : getProvider();
  return new ethers.Contract(process.env.TOKEN_CONTRACT_ADDRESS, TOKEN_ABI, runner);
}

function getRewardEngineContract() {
  return new ethers.Contract(process.env.REWARD_ENGINE_ADDRESS, REWARD_ENGINE_ABI, getSigner());
}

function getSmartStoreContract() {
  return new ethers.Contract(process.env.SMART_STORE_ADDRESS, SMART_STORE_ABI, getSigner());
}

// ── Exported Service Functions ────────────────────────────────────────────────

/**
 * Get TTK token balance for a wallet address.
 * @returns BigInt (wei)
 */
async function getTokenBalance(walletAddress) {
  const token   = getTokenContract();
  const balance = await token.balanceOf(walletAddress);
  return balance;
}

/**
 * Distribute TTK reward to a player after verified AI win.
 * Calls RewardEngine.distributeReward() on-chain.
 *
 * @param playerWallet  Player's MetaMask wallet address
 * @param matchId       Unique match ID from MongoDB
 * @param difficulty    "easy"|"medium"|"hard"|"expert"
 * @returns { txHash, rewardAmount }
 */
async function distributeReward(playerWallet, matchId, difficulty) {
  const rewardEngine = getRewardEngineContract();

  // Check not already rewarded (on-chain)
  const alreadyRewarded = await rewardEngine.isMatchRewarded(matchId);
  if (alreadyRewarded) {
    throw new Error(`Match ${matchId} already rewarded on-chain`);
  }

  const rewardAmount = await rewardEngine.getRewardForDifficulty(difficulty);

  console.log(`⛓  Minting ${ethers.formatEther(rewardAmount)} TTK → ${playerWallet}`);

  const tx      = await rewardEngine.distributeReward(playerWallet, matchId, difficulty);
  const receipt = await tx.wait(1); // Wait 1 confirmation

  console.log(`✅ Reward tx confirmed: ${receipt.hash}`);

  return {
    txHash:       receipt.hash,
    rewardAmount: rewardAmount.toString(),
  };
}

/**
 * Grant a store item to a player after PayMongo fiat payment confirmation.
 * Calls SmartStore.grantItemAfterFiatPayment() on-chain.
 *
 * @param playerWallet     Player's wallet address
 * @param itemId           Store item ID
 * @param paymentIntentId  PayMongo payment_intent ID (replay protection)
 * @returns { txHash }
 */
async function grantStoreItemAfterFiat(playerWallet, itemId, paymentIntentId) {
  const store = getSmartStoreContract();

  console.log(`⛓  Granting "${itemId}" to ${playerWallet} (PayMongo: ${paymentIntentId})`);

  const tx      = await store.grantItemAfterFiatPayment(playerWallet, itemId, paymentIntentId);
  const receipt = await tx.wait(1);

  console.log(`✅ Store grant tx confirmed: ${receipt.hash}`);
  return { txHash: receipt.hash };
}

/**
 * Fetch all active store items from the SmartStore contract.
 * @returns Array of item objects
 */
async function getStoreItems() {
  const store = getSmartStoreContract();
  const rawItems = await store.getAllItems();

  return rawItems
    .filter((item) => item.active)
    .map((item) => ({
      itemId:           item.itemId,
      name:             item.name,
      itemType:         item.itemType,
      priceInTTK:       item.priceInTTK.toString(),
      priceInTTKFormatted: parseFloat(ethers.formatEther(item.priceInTTK)).toFixed(2),
      active:           item.active,
    }));
}

/**
 * Check if a player owns a specific store item (on-chain).
 */
async function doesPlayerOwnItem(playerWallet, itemId) {
  const store = getSmartStoreContract();
  return await store.doesPlayerOwnItem(playerWallet, itemId);
}

module.exports = {
  getTokenBalance,
  distributeReward,
  grantStoreItemAfterFiat,
  getStoreItems,
  doesPlayerOwnItem,
};