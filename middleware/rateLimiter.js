// middleware/rateLimiter.js
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// ─── Helper: Standard JSON response for rate limit hits ──────────────────────
const rateLimitHandler = (req, res) => {
  res.status(429).json({
    success: false,
    message: 'Too many requests. Please slow down and try again.',
    retryAfter: Math.ceil(res.getHeader('Retry-After') || 60),
  });
};

// ─── Global Limiter ───────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             200,
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         rateLimitHandler,
  skip: (req) => req.path === '/health',
});

// ─── Auth Limiter ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             20,
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         rateLimitHandler,
});

// ─── Reward Limiter ───────────────────────────────────────────────────────────
const rewardLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         rateLimitHandler,
  keyGenerator: (req) => {
    const ip       = ipKeyGenerator(req);
    const playerId = req.player?.id || 'anonymous';
    return `${ip}_${playerId}`;
  },
});

// ─── Payment Limiter ──────────────────────────────────────────────────────────
const paymentLimiter = rateLimit({
  windowMs:        5 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         rateLimitHandler,
});

// ─── Match Limiter ────────────────────────────────────────────────────────────
const matchLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         rateLimitHandler,
});

module.exports = {
  globalLimiter,
  authLimiter,
  rewardLimiter,
  paymentLimiter,
  matchLimiter,
};