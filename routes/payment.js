// routes/payment.js
// PayMongo (PHP) payment processing for SmartStore fiat purchases

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

// Item prices in PHP centavos (100 = PHP 1.00)
// These MUST match what PayMongo charges to prevent underpayment
const ITEM_PRICES_PHP = {
  wallet_upgrade_1:   15000,  // PHP 150.00
  wallet_upgrade_2:   45000,  // PHP 450.00
  feature_ai_replay:   9900,  // PHP 99.00
  feature_custom_skin: 5900,  // PHP 59.00
};

/**
 * POST /api/payment/create-intent
 *
 * Creates a PayMongo PaymentIntent for a store item purchase.
 * Unity opens the payment URL for the player to complete.
 *
 * Body: { itemId: string }
 */
router.post(
  "/create-intent",
  authenticate,
  [body("itemId").isString().notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const { itemId } = req.body;
      const player     = req.player;

      const pricePhp = ITEM_PRICES_PHP[itemId];
      if (!pricePhp) {
        return res.status(400).json({ success: false, message: "Unknown item ID" });
      }

      // ── Create PayMongo PaymentIntent ─────────────────────────────────────
      const response = await axios.post(
        `${PAYMONGO_BASE}/payment_intents`,
        {
          data: {
            attributes: {
              amount:                pricePhp,
              payment_method_allowed: ["gcash", "paymaya", "card", "dob"],
              payment_method_options: { card: { request_three_d_secure: "any" } },
              currency:              "PHP",
              capture_type:          "automatic",
              description:           `Game Store: ${itemId}`,
              statement_descriptor:  "AIRHOCKEY STORE",
              metadata: {
                playerId:      player._id.toString(),
                unityPlayerId: player.unityPlayerId,
                itemId,
              },
            },
          },
        },
        { headers: { Authorization: `Basic ${PAYMONGO_AUTH}`, "Content-Type": "application/json" } }
      );

      const intent   = response.data.data;
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

      return res.status(201).json({
        success:         true,
        paymentIntentId: intent.id,
        clientKey,
        amount:          pricePhp,
        currency:        "PHP",
        // Unity WebView opens this URL for GCash/Maya/Card
        checkoutUrl:     `https://checkout.paymongo.com/payment_intents/${intent.id}?client_key=${clientKey}`,
      });
    } catch (err) {
      console.error("PayMongo create-intent error:", err.response?.data || err.message);
      return res.status(500).json({ success: false, message: "Failed to create payment" });
    }
  }
);

/**
 * POST /api/payment/webhook
 *
 * Receives PayMongo webhook events.
 * ⚠ Must use raw body (configured in server.js before express.json())
 *
 * Handles: payment_intent.succeeded → grants item on-chain
 */
router.post("/webhook", async (req, res) => {
  try {
    // ── Verify webhook signature ───────────────────────────────────────────
    const sigHeader = req.headers["paymongo-signature"];
    if (!sigHeader) {
      return res.status(400).json({ message: "Missing signature" });
    }

    const [, timestamp, testSig, liveSig] = sigHeader.match(
      /t=(\d+),te=([a-f0-9]+),li=([a-f0-9]+)/
    ) || [];

    const payload   = `${timestamp}.${req.body.toString()}`;
    const secret    = process.env.PAYMONGO_WEBHOOK_SECRET;
    const hmac      = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const validSig  = process.env.NODE_ENV === "production" ? liveSig : testSig;

    if (hmac !== validSig) {
      console.warn("⚠️  PayMongo webhook signature mismatch");
      return res.status(400).json({ message: "Invalid signature" });
    }

    const event = JSON.parse(req.body.toString());
    console.log("📩 PayMongo webhook:", event.data?.attributes?.type);

    // ── Handle payment success ─────────────────────────────────────────────
    if (event.data?.attributes?.type === "payment_intent.succeeded") {
      const paymentIntentId = event.data.attributes.data.id;
      const metadata        = event.data.attributes.data.attributes.metadata;

      const { playerId, itemId } = metadata || {};
      if (!playerId || !itemId) {
        console.error("Missing metadata in PayMongo event:", event.data.id);
        return res.status(422).json({ message: "Missing metadata" });
      }

      // Find pending transaction
      const txRecord = await Transaction.findOne({ paymentIntentId, status: "pending" });
      if (!txRecord) {
        console.warn("No pending transaction found for intent:", paymentIntentId);
        return res.sendStatus(200); // Idempotent
      }

      // Fetch player wallet
      const player = await Player.findById(playerId);
      if (!player || !player.walletAddress) {
        txRecord.status = "failed";
        await txRecord.save();
        return res.status(422).json({ message: "Player has no wallet" });
      }

      // ── Grant item on-chain via SmartStore ────────────────────────────────
      const { txHash } = await blockchainService.grantStoreItemAfterFiat(
        player.walletAddress,
        itemId,
        paymentIntentId
      );

      // Update MongoDB
      txRecord.status  = "confirmed";
      txRecord.txHash  = txHash;
      await txRecord.save();

      // Cache ownership in player record
      if (!player.ownedItems.includes(itemId)) {
        player.ownedItems.push(itemId);
        await player.save();
      }

      console.log(`✅ Item "${itemId}" granted to player ${playerId} | tx: ${txHash}`);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(500).json({ message: "Webhook processing failed" });
  }
});

/**
 * GET /api/payment/status/:paymentIntentId
 * Poll payment status from PayMongo (Unity polls this after redirect).
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

    // Check local DB too
    const txRecord = await Transaction.findOne({
      paymentIntentId,
      playerId: req.player._id,
    });

    return res.json({
      success:  true,
      status,                               // "awaiting_payment_method"|"processing"|"succeeded"|"cancelled"
      txHash:   txRecord?.txHash || null,
      itemId:   txRecord?.itemId || null,
      explorerUrl: txRecord?.txHash
        ? `https://amoy.polygonscan.com/tx/${txRecord.txHash}`
        : null,
    });
  } catch (err) {
    console.error("Payment status error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Failed to check payment status" });
  }
});

module.exports = router;