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

/**
 * POST /api/payment/create-intent
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
      if (!pricePhp) {
        return res.status(400).json({ success: false, message: `Unknown item ID: ${itemId}` });
      }

      // ── Create PayMongo PaymentIntent ─────────────────────────────────────
      const response = await axios.post(
        `${PAYMONGO_BASE}/payment_intents`,
        {
          data: {
            attributes: {
              amount:   pricePhp,
              // ← FIXED: only gcash + card — paymaya/dob may not be enabled on test account
              payment_method_allowed: ["gcash", "card"],
              payment_method_options: {
                card: { request_three_d_secure: "any" },
              },
              currency:             "PHP",
              capture_type:         "automatic",
              description:          `Puck Sense AI Store: ${itemId}`,
              statement_descriptor: "PUCK SENSE AI",
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

      const intent    = response.data.data;
      const clientKey = intent.attributes.client_key;

      // Store pending transaction
      await Transaction.create({
        playerId:        player._id,
        txType:          "store_fiat_purchase",
        paymentIntentId: intent.id,
        paymentProvider: "paymongo",
        fiatAmount:      pricePhp,
        fiatCurrency:    "PHP",
        itemId,
        status:          "pending",
      });

      console.log(`[Payment] Intent created: ${intent.id} for item ${itemId}`);

      return res.status(201).json({
        success:         true,
        paymentIntentId: intent.id,
        clientKey,
        amount:          pricePhp,
        currency:        "PHP",
        checkoutUrl: `https://checkout.paymongo.com/${clientKey}`,
      });

    } catch (err) {
      // ← Better error logging — shows exact PayMongo rejection reason
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
 */
router.post("/webhook", async (req, res) => {
  try {
    const sigHeader = req.headers["paymongo-signature"];

    // ← Allow skipping signature check in development
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

    // ← FIXED: handle both event types PayMongo may send
    const isSuccess = eventType === "payment_intent.succeeded"
                   || eventType === "payment.paid";

    if (isSuccess) {
      const attrs           = event.data.attributes;
      const paymentIntentId = attrs.data?.id || attrs.payment_intent_id;
      const metadata        = attrs.data?.attributes?.metadata || attrs.metadata || {};

      const { playerId, itemId, walletAddress } = metadata;

      if (!playerId || !itemId) {
        console.error("[Payment] Missing metadata:", metadata);
        return res.status(422).json({ message: "Missing metadata" });
      }

      const txRecord = await Transaction.findOne({ paymentIntentId, status: "pending" });
      if (!txRecord) {
        console.warn("[Payment] No pending transaction for intent:", paymentIntentId);
        return res.sendStatus(200); // Idempotent
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
 */
router.get("/status/:paymentIntentId", authenticate, async (req, res) => {
  try {
    const { paymentIntentId } = req.params;

    const response = await axios.get(
      `${PAYMONGO_BASE}/payment_intents/${paymentIntentId}`,
      { headers: { Authorization: `Basic ${PAYMONGO_AUTH}` } }
    );

    const intent = response.data.data;
    const status = intent.attributes.status;

    const txRecord = await Transaction.findOne({
      paymentIntentId,
      playerId: req.player._id,
    });

    return res.json({
      success:     true,
      status,
      txHash:      txRecord?.txHash      || null,
      itemId:      txRecord?.itemId      || null,
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

module.exports = router;