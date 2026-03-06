// middleware/authenticate.js
// JWT Bearer token verification middleware.
// Attaches req.player = { id, unityPlayerId, username } on success.
// Usage: router.get('/protected', authenticate, handler)

const jwt    = require('jsonwebtoken');
const Player = require('../models/Player');

/**
 * Verifies the Authorization: Bearer <token> header.
 * On success: attaches req.player and calls next().
 * On failure: returns 401.
 */
async function authenticate(req, res, next) {
  try {
    // ── Extract token from header ────────────────────────────────────────────
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authorization header missing or malformed. Expected: Bearer <token>',
      });
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ success: false, message: 'Token is empty.' });
    }

    // ── Verify JWT ──────────────────────────────────────────────────────────
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtErr) {
      if (jwtErr.name === 'TokenExpiredError') {
        return res.status(401).json({ success: false, message: 'Token expired. Please log in again.' });
      }
      if (jwtErr.name === 'JsonWebTokenError') {
        return res.status(401).json({ success: false, message: 'Invalid token.' });
      }
      throw jwtErr;
    }

    // ── Load player from DB ─────────────────────────────────────────────────
    const player = await Player.findById(decoded.id).select(
      '_id unityPlayerId username walletAddress isBanned lastSeenAt'
    );

    if (!player) {
      return res.status(401).json({ success: false, message: 'Player account not found.' });
    }

    if (player.isBanned) {
      return res.status(403).json({ success: false, message: 'Account is banned.' });
    }

    // ── Update last seen (non-blocking) ─────────────────────────────────────
    Player.findByIdAndUpdate(player._id, { lastSeenAt: new Date() }).exec();

    // ── Attach to request ────────────────────────────────────────────────────
    req.player = {
      id:            player._id.toString(),
      unityPlayerId: player.unityPlayerId,
      username:      player.username,
      walletAddress: player.walletAddress,
    };

    next();

  } catch (err) {
    console.error('[Authenticate] Unexpected error:', err.message);
    return res.status(500).json({ success: false, message: 'Authentication error.' });
  }
}

module.exports = authenticate;