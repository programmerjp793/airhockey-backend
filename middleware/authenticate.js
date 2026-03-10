// middleware/authenticate.js
const jwt    = require('jsonwebtoken');
const Player = require('../models/Player');

async function authenticate(req, res, next) {
  try {
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

    // ── Support both old (decoded.id) and new (decoded.playerId) JWT formats ─
    const playerId = decoded.playerId || decoded.id;

    const player = await Player.findById(playerId).select(
      '_id unityPlayerId username walletAddress isBanned lastSeenAt rewardsClaimedToday rewardResetDate stats'
    );

    if (!player) {
      return res.status(401).json({ success: false, message: 'Player account not found.' });
    }

    if (player.isBanned) {
      return res.status(403).json({ success: false, message: 'Account is banned.' });
    }

    Player.findByIdAndUpdate(player._id, { lastSeenAt: new Date() }).exec();

    req.player = {
      id:                   player._id.toString(),
      _id:                  player._id,
      unityPlayerId:        player.unityPlayerId,
      username:             player.username,
      walletAddress:        player.walletAddress,
      rewardsClaimedToday:  player.rewardsClaimedToday,
      rewardResetDate:      player.rewardResetDate,
      stats:                player.stats,
    };

    next();

  } catch (err) {
    console.error('[Authenticate] Unexpected error:', err.message);
    return res.status(500).json({ success: false, message: 'Authentication error.' });
  }
}

module.exports = authenticate;