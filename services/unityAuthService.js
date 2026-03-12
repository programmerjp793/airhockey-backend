// services/unityAuthService.js
// Unity Authentication Service
//
// Verifies Unity Gaming Services (UGS) player tokens.
// Used by POST /api/auth/unity-login
//
// In development/testing: accepts any token and returns the unityPlayerId as-is.
// In production: verifies against Unity's public key via UGS API.

const https = require("https");

/**
 * Verifies a Unity player token.
 *
 * Development mode (NODE_ENV !== "production"):
 *   Skips real verification — accepts any token.
 *   Returns { sub: unityPlayerId } so auth flow continues.
 *
 * Production mode:
 *   Calls Unity's token verification endpoint using
 *   UNITY_PROJECT_ID + UNITY_SERVICE_ACCOUNT_KEY_ID + UNITY_SERVICE_ACCOUNT_SECRET
 *   from your .env
 *
 * @param {string} unityToken     - JWT token from Unity SDK on the client
 * @param {string} unityPlayerId  - Player ID from Unity SDK on the client
 * @returns {Promise<{ sub: string }|null>}
 */
async function verifyUnityToken(unityToken, unityPlayerId) {
  // ── Development / test mode ───────────────────────────────────────────────
  // Skip real Unity verification so you can test without a live UGS project.
  if (process.env.NODE_ENV !== "production") {
    console.log(`[UnityAuth] DEV mode — skipping token verification for: ${unityPlayerId}`);
    return { sub: unityPlayerId };
  }

  // ── Production mode ───────────────────────────────────────────────────────
  const projectId  = process.env.UNITY_PROJECT_ID;
  const keyId      = process.env.UNITY_SERVICE_ACCOUNT_KEY_ID;
  const secret     = process.env.UNITY_SERVICE_ACCOUNT_SECRET;

  if (!projectId || !keyId || !secret) {
    console.warn("[UnityAuth] Missing UNITY_PROJECT_ID / KEY_ID / SECRET in .env");
    // Fallback: trust the client-provided ID (less secure, use only if UGS not set up)
    return { sub: unityPlayerId };
  }

  try {
    // Unity token introspection endpoint
    const url = `https://services.api.unity.com/auth/v1/token-exchange` +
                `?projectId=${projectId}&unityInstallationId=${unityPlayerId}`;

    const credentials = Buffer.from(`${keyId}:${secret}`).toString("base64");

    const result = await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method:  "POST",
        headers: {
          "Authorization": `Basic ${credentials}`,
          "Content-Type":  "application/json",
        },
      }, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try   { resolve(JSON.parse(data)); }
          catch { reject(new Error("Invalid JSON from Unity auth")); }
        });
      });

      req.on("error", reject);

      req.write(JSON.stringify({ token: unityToken }));
      req.end();
    });

    if (result?.userId) {
      return { sub: result.userId };
    }

    console.warn("[UnityAuth] Unity token verification failed:", result);
    return null;

  } catch (err) {
    console.error("[UnityAuth] Token verification error:", err.message);
    // In production, a failed verification should return null (deny access)
    return null;
  }
}

module.exports = { verifyUnityToken };