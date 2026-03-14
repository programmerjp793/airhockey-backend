// server.js — Main Express entry point
require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const helmet   = require("helmet");
const morgan   = require("morgan");
const mongoose = require("mongoose");

const authRoutes    = require("./routes/auth");
const matchRoutes   = require("./routes/match");
const rewardRoutes  = require("./routes/reward");
const storeRoutes   = require("./routes/store");
const paymentRoutes = require("./routes/payment");
const walletRoutes  = require("./routes/wallet");

const { globalLimiter } = require("./middleware/rateLimiter");
const { errorHandler }  = require("./middleware/errorHandler");

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Security Middleware ─────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: "*",   // Unity mobile apps don't use browser origins
  methods: ["GET", "POST", "PUT"],
}));
app.use(morgan("dev"));
app.use(globalLimiter);

// ─── Body Parsers ─────────────────────────────────────────────────────────────
// NOTE: PayMongo webhooks need raw body — must come BEFORE express.json()
app.use("/api/payment/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "10kb" }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/auth",    authRoutes);    // Unity Auth → Player login / register
app.use("/api/match",   matchRoutes);   // Create AI match, submit result
app.use("/api/reward",  rewardRoutes);  // Win verification + blockchain reward
app.use("/api/store",   storeRoutes);   // SmartStore item listing
app.use("/api/payment", paymentRoutes); // PayMongo payment intents + webhooks
app.use("/api/wallet",  walletRoutes);  // Player wallet info + token balance

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Database + Server Start ──────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB connected");
    app.listen(PORT, "0.0.0.0", () =>
      console.log(`🚀 Backend running on port ${PORT} [${process.env.NODE_ENV}]`)
    );
  })
  .catch((err) => {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  });

module.exports = app;