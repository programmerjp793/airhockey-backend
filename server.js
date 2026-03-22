// server.js — Main Express entry point
require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const helmet   = require("helmet");
const morgan   = require("morgan");
const mongoose = require("mongoose");

const authRoutes       = require("./routes/auth");
const matchRoutes      = require("./routes/match");
const storeRoutes      = require("./routes/store");
const paymentRoutes    = require("./routes/payment");
const walletRoutes     = require("./routes/wallet");
const transactionRoutes = require("./routes/transactions");

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
app.use(express.json({ limit: "10kb" }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/auth",         authRoutes);      // Unity Auth → Player login / register
app.use("/api/match",        matchRoutes);     // Create AI match, submit result
app.use("/api/store",        storeRoutes);     // SmartStore item listing + admin management
app.use("/api/purchase",     paymentRoutes);   // Item purchase flow (prepare, confirm)
app.use("/api/wallet",       walletRoutes);    // Player wallet info + token balance
app.use("/api/transactions", transactionRoutes); // Blockchain transaction history

// ─── Root Route ───────────────────────────────────────────────────────────────
// Root route - handles GET / and HEAD /
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Air Hockey Backend API is running",
    version: "1.0.0",
    endpoints: [
      "/api/auth/unity-login",
      "/api/auth/wallet-login",
      "/api/store/items",
      "/api/store/owned",
      "/api/purchase/prepare",
      "/api/purchase/prepare-store-tx",
      "/api/purchase/create-intent",
      "/api/purchase/submit-tx",
      "/api/purchase/status",
      "/api/purchase/status/:intentId",
      "/api/purchase/confirm",
      "/api/purchase/check-ownership",
      "/api/wallet/balance",
      "/api/wallet/info",
      "/api/transactions/history",
      "/api/transactions/stats",
      "/api/transactions/:txHash",
      "/api/transactions/status/:txHash",
      "/api/transactions/address/:walletAddress",
      "/health"
    ]
  });
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Database + Server Start ─────────────────────────────────────────────────
// Support explicit override to new Atlas cluster and target DB.
const mongoUri = process.env.MONGODB_URI_NEW || process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB_NAME || "pucksense";

if (!mongoUri || !mongoUri.trim()) {
  console.error("❌ MongoDB connection string is missing. Set MONGODB_URI_NEW or MONGODB_URI.");
  process.exit(1);
}

if (!mongoUri.startsWith("mongodb://") && !mongoUri.startsWith("mongodb+srv://")) {
  console.error(
    "❌ MongoDB connection string has invalid scheme. It must start with mongodb:// or mongodb+srv://",
    mongoUri
  );
  process.exit(1);
}

console.log(`⚙️  Using MongoDB URI: ${mongoUri.startsWith("mongodb+srv://") ? "mongodb+srv://..." : "mongodb://..."}`);
console.log(`⚙️  Using DB Name: ${mongoDbName}`);

mongoose
  .connect(mongoUri, {
    dbName: mongoDbName,
    autoIndex: true,
  })
  .then(() => {
    console.log(`✅ MongoDB connected to ${mongoDbName}`);
    app.listen(PORT, () =>
      console.log(`🚀 Backend running on port ${PORT} [${process.env.NODE_ENV}]`)
    );
  })
  .catch((err) => {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  });

module.exports = app;
