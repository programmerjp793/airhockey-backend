// routes/payment.js
// Native ETH only (Sepolia) — no TTK, no ERC-20
const express = require("express");
const axios   = require("axios");
const crypto  = require("crypto");
const { body, validationResult } = require("express-validator");

const { Transaction }   = require("../models/Match");
const Player            = require("../models/Player");
const authenticate      = require("../middleware/authenticate");
const blockchainService = require("../services/blockchainService");

const router = express.Router();

const PAYMONGO_BASE = "https://api.paymongo.com/v1";
const PAYMONGO_AUTH = Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString("base64");

const ITEM_PRICES_PHP = {
  wallet_upgrade_1:    15000,
  wallet_upgrade_2:    45000,
  ai_replay:            9900,
  custom_skin:          5900,
  feature_ai_replay:    9900,
  feature_custom_skin:  5900,
};

// SmartStore.sol numeric item IDs
const ITEM_STORE_IDS = {
  wallet_upgrade_1:    1,
  wallet_upgrade_2:    2,
  ai_replay:           3,
  custom_skin:         4,
  feature_ai_replay:   3,
  feature_custom_skin: 4,
};

// Reverse map: numeric → string itemId
const NUMERIC_TO_ITEM_ID = {
  1: "wallet_upgrade_1",
  2: "wallet_upgrade_2",
  3: "ai_replay",
  4: "custom_skin",
};

const ITEM_NAMES = {
  wallet_upgrade_1:    "Wallet Slot Upgrade I",
  wallet_upgrade_2:    "Wallet Slot Upgrade II",
  ai_replay:           "AI Replay Viewer",
  custom_skin:         "Custom Puck Skin",
  feature_ai_replay:   "AI Replay Viewer",
  feature_custom_skin: "Custom Puck Skin",
};

// ── POST /api/payment/prepare-store-tx ───────────────────────────────────────
// FIX: Accept BOTH numeric itemId (int) AND string itemId.
// Unity WalletManager sends numericId as int.
// WalletUpgradePanel sends string itemId like "wallet_upgrade_1".
// Both are now handled.
router.post("/prepare-store-tx", authenticate, async (req, res) => {
  try {
    const rawItemId = req.body.itemId;

    if (rawItemId === undefined || rawItemId === null) {
      return res.status(400).json({ success: false, message: "itemId is required" });
    }

    // Resolve to numeric ID
    let numericId;
    if (typeof rawItemId === "number" || /^\d+$/.test(String(rawItemId))) {
      numericId = parseInt(rawItemId, 10);
    } else {
      numericId = ITEM_STORE_IDS[rawItemId];
      if (!numericId) {
        return res.status(400).json({ success: false, message: `Unknown itemId: ${rawItemId}` });
      }
    }

    if (numericId < 1 || numericId > 4) {
      return res.status(400).json({ success: false, message: `Invalid itemId: ${numericId}` });
    }

    // Get wallet address from DB (most reliable source)
    const player = await Player.findById(req.player.id || req.player._id);
    const walletAddress = player?.walletAddress || req.player.walletAddress;

    if (!walletAddress) {
      return res.status(400).json({
        success: false,
        message: "No wallet address linked. Connect your wallet first.",
      });
    }

    console.log(`[Payment] prepare-store-tx: wallet=${walletAddress} numericId=${numericId}`);

    const txData = await blockchainService.prepareStorePurchaseTx(walletAddress, numericId);

    return res.json({ success: true, ...txData });

  } catch (err) {
    console.error("[Payment] prepare-store-tx error:", err.message);
    return res.status(400).json({ success: false, message: err.message });
  }
});

// ── POST /api/payment/create-intent ──────────────────────────────────────────
router.post(
  "/create-intent",
  authenticate,
  [body("itemId").isString().notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const { itemId } = req.body;
      const player     = req.player;

      const pricePhp = ITEM_PRICES_PHP[itemId];
      if (!pricePhp)
        return res.status(400).json({ success: false, message: `Unknown item ID: ${itemId}` });

      const response = await axios.post(
        `${PAYMONGO_BASE}/checkout_sessions`,
        {
          data: {
            attributes: {
              billing: { name: player.username || "Player" },
              line_items: [{
                currency: "PHP",
                amount:   pricePhp,
                name:     ITEM_NAMES[itemId] || itemId,
                quantity: 1,
              }],
              payment_method_types: ["gcash", "card"],
              success_url: "https://airhockey-backend.onrender.com/api/payment/success",
              cancel_url:  "https://airhockey-backend.onrender.com/api/payment/cancel",
              metadata: {
                playerId:      player._id.toString(),
                walletAddress: player.walletAddress || "",
                itemId,
                storeItemId:   ITEM_STORE_IDS[itemId],
              },
            },
          },
        },
        {
          headers: {
            Authorization:  `Basic ${PAYMONGO_AUTH}`,
            "Content-Type": "application/json",
          },
        }
      );

      const session     = response.data.data;
      const checkoutUrl = session.attributes.checkout_url;

      await Transaction.create({
        playerId:        player._id,
        txType:          "store_fiat_purchase",
        paymentIntentId: session.id,
        paymentProvider: "paymongo",
        fiatAmount:      pricePhp,
        fiatCurrency:    "PHP",
        itemId,
        storeItemId:     ITEM_STORE_IDS[itemId],
        status:          "pending",
      });

      console.log(`[Payment] Checkout created: ${session.id} for ${itemId}`);

      return res.status(201).json({
        success:         true,
        paymentIntentId: session.id,
        checkoutUrl,
        amount:          pricePhp,
        currency:        "PHP",
        note: "ETH balance unaffected by fiat purchases",
      });

    } catch (err) {
      const paymongoError = err.response?.data?.errors?.[0]?.detail
                         || err.response?.data?.message
                         || err.message;
      console.error("[Payment] create-intent error:", paymongoError);
      return res.status(500).json({ success: false, message: "Failed to create payment", detail: paymongoError });
    }
  }
);

// ── POST /api/payment/webhook ─────────────────────────────────────────────────
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sigHeader = req.headers["paymongo-signature"];
    if (sigHeader) {
      const [, timestamp, testSig, liveSig] = sigHeader.match(
        /t=(\d+),te=([a-f0-9]+),li=([a-f0-9]+)/
      ) || [];
      if (timestamp) {
        const payload  = `${timestamp}.${req.body.toString()}`;
        const secret   = process.env.PAYMONGO_WEBHOOK_SECRET;
        const hmac     = crypto.createHmac("sha256", secret).update(payload).digest("hex");
        const validSig = process.env.NODE_ENV === "production" ? liveSig : testSig;
        if (hmac !== validSig) {
          console.warn("[Payment] Webhook signature mismatch");
          return res.status(400).json({ message: "Invalid signature" });
        }
      }
    }

    const event     = JSON.parse(req.body.toString());
    const eventType = event.data?.attributes?.type;
    console.log(`[Payment] Webhook: ${eventType}`);

    const isSuccess = eventType === "payment_intent.succeeded"
                   || eventType === "payment.paid"
                   || eventType === "checkout_session.payment.paid";

    if (!isSuccess) return res.sendStatus(200);

    const attrs           = event.data.attributes;
    const paymentIntentId = attrs.data?.id || attrs.payment_intent_id || event.data.id;
    const metadata        = attrs.data?.attributes?.metadata || attrs.metadata || {};
    const { playerId, walletAddress, itemId } = metadata;

    if (!playerId || !itemId) {
      console.error("[Payment] Missing metadata:", metadata);
      return res.status(422).json({ message: "Missing metadata" });
    }

    const txRecord = await Transaction.findOne({ paymentIntentId, status: "pending" });
    if (!txRecord) {
      console.warn("[Payment] No pending tx for:", paymentIntentId);
      return res.sendStatus(200);
    }

    const player       = await Player.findById(playerId);
    const playerWallet = walletAddress || player?.walletAddress;

    if (!playerWallet) {
      txRecord.status = "failed";
      await txRecord.save();
      return res.status(422).json({ message: "No wallet address" });
    }

    const fiatAmount = attrs.data?.attributes?.amount || txRecord.fiatAmount;
    const result = await blockchainService.processFiatPurchase(
      playerWallet, fiatAmount, "paymongo", paymentIntentId
    );

    txRecord.status = "confirmed";
    txRecord.txHash = result.txHash;
    await txRecord.save();

    if (!player.ownedItems.includes(itemId)) {
      player.ownedItems.push(itemId);
      await player.save();
    }

    console.log(`[Payment] ✅ "${itemId}" granted | tx: ${result.txHash}`);
    return res.sendStatus(200);

  } catch (err) {
    console.error("[Payment] Webhook error:", err);
    return res.status(500).json({ message: "Webhook processing failed" });
  }
});

// ── GET /api/payment/status/:paymentIntentId ──────────────────────────────────
router.get("/status/:paymentIntentId", authenticate, async (req, res) => {
  try {
    const { paymentIntentId } = req.params;
    let pmStatus;
    try {
      const r = await axios.get(`${PAYMONGO_BASE}/checkout_sessions/${paymentIntentId}`,
        { headers: { Authorization: `Basic ${PAYMONGO_AUTH}` } });
      pmStatus = r.data.data.attributes.payment_intent?.attributes?.status
              || r.data.data.attributes.status || "unknown";
    } catch {
      const r = await axios.get(`${PAYMONGO_BASE}/payment_intents/${paymentIntentId}`,
        { headers: { Authorization: `Basic ${PAYMONGO_AUTH}` } });
      pmStatus = r.data.data.attributes.status;
    }

    const txRecord = await Transaction.findOne({ paymentIntentId, playerId: req.player._id });

    return res.json({
      success:     true,
      status:      txRecord?.status || pmStatus,
      txHash:      txRecord?.txHash || null,
      itemId:      txRecord?.itemId || null,
      explorerUrl: txRecord?.txHash ? `https://sepolia.etherscan.io/tx/${txRecord.txHash}` : null,
    });

  } catch (err) {
    console.error("[Payment] status error:", err.response?.data?.errors?.[0]?.detail || err.message);
    return res.status(500).json({ success: false, message: "Failed to check payment status" });
  }
});

router.get("/success", (req, res) => res.send("<h2>✅ Payment successful! Return to the game.</h2>"));
router.get("/cancel",  (req, res) => res.send("<h2>❌ Payment cancelled. Return to the game.</h2>"));

module.exports = router;