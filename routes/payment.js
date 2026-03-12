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
  wallet_upgrade_1:    15000,  // PHP 150.00
  wallet_upgrade_2:    45000,  // PHP 450.00
  feature_ai_replay:    9900,  // PHP 99.00
  feature_custom_skin:  5900,  // PHP 59.00
};

// SmartStore.sol item IDs (match constructor seed order)
const ITEM_STORE_IDS = {
  wallet_upgrade_1:    1,
  wallet_upgrade_2:    2,
  feature_ai_replay:   3,
  feature_custom_skin: 4,
};

const ITEM_NAMES = {
  wallet_upgrade_1:    "Wallet Slot Upgrade I",
  wallet_upgrade_2:    "Wallet Slot Upgrade II",
  feature_ai_replay:   "AI Replay Viewer",
  feature_custom_skin: "Custom Puck Skin",
};

// ── POST /api/payment/prepare-store-tx ───────────────────────────────────────
// Returns MetaMask Mobile deep link for payable ETH purchaseItem() tx.
// No approve() step — pure native ETH.
router.post(
  "/prepare-store-tx",
  authenticate,
  [body("itemId").isInt({ min: 1 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const txData = await blockchainService.prepareStorePurchaseTx(
        req.player.walletAddress,
        req.body.itemId
      );
      return res.json({ success: true, ...txData });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  }
);

// ── POST /api/payment/create-intent ──────────────────────────────────────────
// Creates a PayMongo Checkout Session (fiat path — GCash / card).
// ETH balance is NOT affected by fiat purchases.
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

      // ── Create PayMongo Checkout Session ──────────────────────────────────
      const response = await axios.post(
        `${PAYMONGO_BASE}/checkout_sessions`,
        {
          data: {
            attributes: {
              billing: { name: player.username || "Player" },
              line_items: [
                {
                  currency: "PHP",
                  amount:   pricePhp,
                  name:     ITEM_NAMES[itemId] || itemId,
                  quantity: 1,
                },
              ],
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

      // Store pending transaction in DB
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

      console.log(`[Payment] Checkout session created: ${session.id} for ${itemId}`);

      return res.status(201).json({
        success:         true,
        paymentIntentId: session.id,
        checkoutUrl,
        amount:          pricePhp,
        currency:        "PHP",
        // ETH balance is unaffected — fiat purchase is separate from on-chain ETH
        note: "Your ETH balance is not affected by fiat purchases",
      });

    } catch (err) {
      const paymongoError = err.response?.data?.errors?.[0]?.detail
                         || err.response?.data?.message
                         || err.message;
      console.error("[Payment] create-intent error:", paymongoError);
      return res.status(500).json({
        success: false,
        message: "Failed to create payment",
        detail:  paymongoError,
      });
    }
  }
);

// ── POST /api/payment/webhook ─────────────────────────────────────────────────
// Handles PayMongo webhook — on payment success, records fiat purchase on Sepolia.
// No ETH burn — player ETH balance stays intact.
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    // ── Verify HMAC signature ─────────────────────────────────────────────
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
    console.log(`[Payment] Webhook received: ${eventType}`);

    const isSuccess = eventType === "payment_intent.succeeded"
                   || eventType === "payment.paid"
                   || eventType === "checkout_session.payment.paid";

    if (!isSuccess) return res.sendStatus(200);

    // ── Extract metadata ──────────────────────────────────────────────────
    const attrs = event.data.attributes;

    const paymentIntentId = attrs.data?.id
                         || attrs.payment_intent_id
                         || event.data.id;

    const metadata = attrs.data?.attributes?.metadata
                  || attrs.metadata
                  || {};

    const { playerId, walletAddress, itemId } = metadata;

    if (!playerId || !itemId) {
      console.error("[Payment] Missing metadata:", metadata);
      return res.status(422).json({ message: "Missing metadata" });
    }

    // ── Find pending transaction ──────────────────────────────────────────
    const txRecord = await Transaction.findOne({ paymentIntentId, status: "pending" });
    if (!txRecord) {
      console.warn("[Payment] No pending transaction for:", paymentIntentId);
      return res.sendStatus(200);
    }

    // ── Resolve player wallet address ─────────────────────────────────────
    const player       = await Player.findById(playerId);
    const playerWallet = walletAddress || player?.walletAddress;

    if (!playerWallet) {
      txRecord.status = "failed";
      await txRecord.save();
      return res.status(422).json({ message: "Player has no wallet address" });
    }

    // ── Record fiat purchase on Sepolia (native ETH — no burn) ────────────
    // Uses paymentIntentId as unique on-chain reference (replay guard)
    const fiatAmount = attrs.data?.attributes?.amount || txRecord.fiatAmount;
    const result = await blockchainService.processFiatPurchase(
      playerWallet,
      fiatAmount,
      "paymongo",
      paymentIntentId
    );

    // ── Update DB ─────────────────────────────────────────────────────────
    txRecord.status = "confirmed";
    txRecord.txHash = result.txHash;
    await txRecord.save();

    if (!player.ownedItems.includes(itemId)) {
      player.ownedItems.push(itemId);
      await player.save();
    }

    console.log(`[Payment] ✅ Item "${itemId}" granted | tx: ${result.txHash}`);
    console.log(`[Payment] 🔗 ${result.explorerUrl}`);

    return res.sendStatus(200);

  } catch (err) {
    console.error("[Payment] Webhook error:", err);
    return res.status(500).json({ message: "Webhook processing failed" });
  }
});

// ── GET /api/payment/status/:paymentIntentId ──────────────────────────────────
// Unity polls this after checkout to check if payment succeeded.
router.get("/status/:paymentIntentId", authenticate, async (req, res) => {
  try {
    const { paymentIntentId } = req.params;

    // Try checkout_session first, fallback to payment_intent
    let pmStatus;
    try {
      const response = await axios.get(
        `${PAYMONGO_BASE}/checkout_sessions/${paymentIntentId}`,
        { headers: { Authorization: `Basic ${PAYMONGO_AUTH}` } }
      );
      pmStatus = response.data.data.attributes.payment_intent?.attributes?.status
              || response.data.data.attributes.status
              || "unknown";
    } catch {
      const response = await axios.get(
        `${PAYMONGO_BASE}/payment_intents/${paymentIntentId}`,
        { headers: { Authorization: `Basic ${PAYMONGO_AUTH}` } }
      );
      pmStatus = response.data.data.attributes.status;
    }

    const txRecord = await Transaction.findOne({
      paymentIntentId,
      playerId: req.player._id,
    });

    return res.json({
      success:     true,
      status:      txRecord?.status || pmStatus,
      txHash:      txRecord?.txHash || null,
      itemId:      txRecord?.itemId || null,
      // Updated: Sepolia explorer (was amoy.polygonscan.com)
      explorerUrl: txRecord?.txHash
        ? `https://sepolia.etherscan.io/tx/${txRecord.txHash}`
        : null,
    });

  } catch (err) {
    const detail = err.response?.data?.errors?.[0]?.detail || err.message;
    console.error("[Payment] status check error:", detail);
    return res.status(500).json({ success: false, message: "Failed to check payment status" });
  }
});

// ── GET /api/payment/success ──────────────────────────────────────────────────
router.get("/success", (req, res) => {
  res.send("<h2>✅ Payment successful! Return to the game.</h2>");
});

// ── GET /api/payment/cancel ───────────────────────────────────────────────────
router.get("/cancel", (req, res) => {
  res.send("<h2>❌ Payment cancelled. Return to the game.</h2>");
});

module.exports = router;