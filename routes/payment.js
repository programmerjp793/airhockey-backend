// routes/payment.js
const express = require("express");
const axios   = require("axios");
const crypto  = require("crypto");
const { body, validationResult } = require("express-validator");

const { Transaction } = require("../models/Match");
const Player          = require("../models/Player");
const authenticate    = require("../middleware/authenticate");
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

const ITEM_NAMES = {
  wallet_upgrade_1:    "Wallet Slot Upgrade I",
  wallet_upgrade_2:    "Wallet Slot Upgrade II",
  feature_ai_replay:   "AI Replay Viewer",
  feature_custom_skin: "Custom Puck Skin",
};

/**
 * POST /api/payment/create-intent
 * Creates a PayMongo Checkout Session and returns a hosted checkout URL.
 */
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

      // Store pending transaction
      await Transaction.create({
        playerId:        player._id,
        txType:          "store_fiat_purchase",
        paymentIntentId: session.id,
        paymentProvider: "paymongo",
        fiatAmount:      pricePhp,
        fiatCurrency:    "PHP",
        itemId,
        status:          "pending",
      });

      console.log(`[Payment] Checkout session created: ${session.id} for ${itemId}`);

      return res.status(201).json({
        success:         true,
        paymentIntentId: session.id,
        checkoutUrl,
        amount:          pricePhp,
        currency:        "PHP",
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

/**
 * POST /api/payment/webhook
 * Handles PayMongo webhook events.
 */
router.post("/webhook", async (req, res) => {
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
    console.log(`[Payment] Webhook received: ${eventType}`);

    const isSuccess = eventType === "payment_intent.succeeded"
                   || eventType === "payment.paid"
                   || eventType === "checkout_session.payment.paid";

    if (isSuccess) {
      const attrs = event.data.attributes;

      // Handle both checkout_session and payment_intent event shapes
      const paymentIntentId = attrs.data?.id
                           || attrs.payment_intent_id
                           || event.data.id;

      const metadata = attrs.data?.attributes?.metadata
                    || attrs.metadata
                    || {};

      const { playerId, itemId } = metadata;

      if (!playerId || !itemId) {
        console.error("[Payment] Missing metadata:", metadata);
        return res.status(422).json({ message: "Missing metadata" });
      }

      const txRecord = await Transaction.findOne({ paymentIntentId, status: "pending" });
      if (!txRecord) {
        console.warn("[Payment] No pending transaction for:", paymentIntentId);
        return res.sendStatus(200);
      }

      const player = await Player.findById(playerId);
      if (!player?.walletAddress) {
        txRecord.status = "failed";
        await txRecord.save();
        return res.status(422).json({ message: "Player has no wallet" });
      }

      const { txHash } = await blockchainService.grantStoreItemAfterFiat(
        player.walletAddress,
        itemId,
        paymentIntentId
      );

      txRecord.status = "confirmed";
      txRecord.txHash = txHash;
      await txRecord.save();

      if (!player.ownedItems.includes(itemId)) {
        player.ownedItems.push(itemId);
        await player.save();
      }

      console.log(`[Payment] ✅ Item "${itemId}" granted | tx: ${txHash}`);
    }

    return res.sendStatus(200);

  } catch (err) {
    console.error("[Payment] Webhook error:", err);
    return res.status(500).json({ message: "Webhook processing failed" });
  }
});

/**
 * GET /api/payment/status/:paymentIntentId
 * Unity polls this after checkout to check if payment succeeded.
 */
router.get("/status/:paymentIntentId", authenticate, async (req, res) => {
  try {
    const { paymentIntentId } = req.params;

    // Try checkout_session first, fallback to payment_intent
    let status;
    try {
      const response = await axios.get(
        `${PAYMONGO_BASE}/checkout_sessions/${paymentIntentId}`,
        { headers: { Authorization: `Basic ${PAYMONGO_AUTH}` } }
      );
      status = response.data.data.attributes.payment_intent?.attributes?.status
            || response.data.data.attributes.status
            || "unknown";
    } catch {
      const response = await axios.get(
        `${PAYMONGO_BASE}/payment_intents/${paymentIntentId}`,
        { headers: { Authorization: `Basic ${PAYMONGO_AUTH}` } }
      );
      status = response.data.data.attributes.status;
    }

    const txRecord = await Transaction.findOne({
      paymentIntentId,
      playerId: req.player._id,
    });

    return res.json({
      success:     true,
      status,
      txHash:      txRecord?.txHash || null,
      itemId:      txRecord?.itemId || null,
      explorerUrl: txRecord?.txHash
        ? `https://amoy.polygonscan.com/tx/${txRecord.txHash}`
        : null,
    });

  } catch (err) {
    const detail = err.response?.data?.errors?.[0]?.detail || err.message;
    console.error("[Payment] status check error:", detail);
    return res.status(500).json({ success: false, message: "Failed to check payment status" });
  }
});

/**
 * GET /api/payment/success
 * Redirect page after successful PayMongo checkout.
 */
router.get("/success", (req, res) => {
  res.send("<h2>✅ Payment successful! Return to the game.</h2>");
});

/**
 * GET /api/payment/cancel
 * Redirect page after cancelled PayMongo checkout.
 */
router.get("/cancel", (req, res) => {
  res.send("<h2>❌ Payment cancelled. Return to the game.</h2>");
});

module.exports = router;