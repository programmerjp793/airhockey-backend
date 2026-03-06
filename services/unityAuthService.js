// services/unityAuthService.js
// Verifies Unity Authentication tokens via Unity Gaming Services (UGS) public key.
// Dev mode: accepts "dev_" prefixed mock tokens for local testing without UGS.

const https = require('https');

// ─── Configuration ────────────────────────────────────────────────────────────

// Unity Gaming Services JWKS endpoint
// Used to fetch public keys for JWT verification
const UGS_JWKS_URL = 'https://player-auth.services.api.unity.com/.well-known/jwks.json';

// Cache the JWKS to avoid fetching on every request
let cachedJwks       = null;
let jwksCachedAt     = 0;
const JWKS_TTL_MS    = 60 * 60 * 1000; // 1 hour

// ─── Main Verification Function ───────────────────────────────────────────────

/**
 * Verifies a Unity Authentication access token.
 *
 * In production: verifies the JWT signature using UGS public keys.
 * In dev mode:   accepts "dev_{playerId}" mock tokens without network call.
 *
 * @param {string} token - The Unity access token from AuthenticationService.Instance.AccessToken
 * @returns {Promise<{ playerId: string, isValid: boolean }>}
 * @throws {Error} if token is invalid or expired
 */
async function verifyUnityToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Unity token is missing or not a string.');
  }

  // ── Dev Mode: mock tokens starting with "dev_" ─────────────────────────────
  if (token.startsWith('dev_')) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Dev tokens are not allowed in production.');
    }

    const playerId = token.replace('dev_', '').trim();

    if (!playerId) {
      throw new Error('Dev token must include a playerId: dev_{playerId}');
    }

    console.log(`[UnityAuth] DEV MODE: Accepted mock token for playerId: ${playerId}`);
    return { playerId, isValid: true };
  }

  // ── Production Mode: verify Unity JWT ─────────────────────────────────────
  try {
    const payload = await verifyUnityJWT(token);

    const playerId = payload.sub || payload.playerId || payload.player_id;

    if (!playerId) {
      throw new Error('Unity token payload missing player ID (sub field).');
    }

    return { playerId, isValid: true };

  } catch (err) {
    throw new Error(`Unity token verification failed: ${err.message}`);
  }
}

// ─── JWT Verification ─────────────────────────────────────────────────────────

/**
 * Verifies the Unity JWT signature using UGS public JWKS keys.
 * Falls back to a lightweight manual decode if jsonwebtoken is not installed.
 */
async function verifyUnityJWT(token) {
  // Try to use jsonwebtoken if available
  try {
    const jwt  = require('jsonwebtoken');
    const jwks = require('jwks-rsa');

    const client = jwks({
      jwksUri: UGS_JWKS_URL,
      cache:   true,
      rateLimit: true,
    });

    return new Promise((resolve, reject) => {
      jwt.verify(
        token,
        (header, callback) => {
          client.getSigningKey(header.kid, (err, key) => {
            if (err) return callback(err);
            callback(null, key.getPublicKey());
          });
        },
        { algorithms: ['RS256'] },
        (err, decoded) => {
          if (err) return reject(err);
          resolve(decoded);
        }
      );
    });

  } catch (requireErr) {
    // jsonwebtoken or jwks-rsa not installed — use manual decode (no signature check)
    console.warn('[UnityAuth] jsonwebtoken/jwks-rsa not installed. Using unsafe decode.');
    console.warn('[UnityAuth] Run: npm install jsonwebtoken jwks-rsa');
    return unsafeDecode(token);
  }
}

/**
 * Decodes a JWT without verifying signature.
 * ⚠️ Only used as a fallback — do NOT use in production without signature check.
 */
function unsafeDecode(token) {
  try {
    const parts   = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT format.');

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    );

    // Basic expiry check
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      throw new Error('Unity token has expired.');
    }

    console.warn('[UnityAuth] ⚠️  Token decoded WITHOUT signature verification!');
    return payload;

  } catch (err) {
    throw new Error(`Failed to decode Unity token: ${err.message}`);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  verifyUnityToken,
};