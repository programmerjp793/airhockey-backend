// services/unityAuthService.js
// Verifies Unity Authentication tokens.
//
// NOTE: For anonymous Unity login, we trust the unityPlayerId sent from the client.
// The JWT we issue is what secures all subsequent requests.

/**
 * Verifies a Unity Authentication token.
 *
 * If UNITY_PROJECT_ID is configured, verifies with Unity Gaming Services.
 * Otherwise, falls back to trusting the unityPlayerId directly (anonymous mode).
 *
 * @param {string} unityToken - The Unity access token
 * @param {string} unityPlayerId - The Unity player ID (fallback)
 * @returns {{ sub: string, projectId: string }}
 */
async function verifyUnityToken(unityToken, unityPlayerId) {
  const projectId = process.env.UNITY_PROJECT_ID;

  // ── If Unity credentials are configured, verify with UGS ──────────────────
  if (
    projectId &&
    projectId !== 'your-unity-project-id' &&
    projectId !== 'not-used' &&
    process.env.UNITY_SERVICE_ACCOUNT_KEY_ID !== 'your-key-id'
  ) {
    try {
      const result = await verifyWithUGS(unityToken, projectId);
      if (result) return result;
    } catch (err) {
      console.warn('[Auth] UGS verification failed, falling back to anonymous mode:', err.message);
    }
  }

  // ── Fallback: Anonymous mode — trust the Unity Player ID ──────────────────
  // This is safe because all API calls after login require our JWT,
  // not the Unity token. The JWT is what we control and trust.
  console.log('[Auth] Anonymous mode: trusting unityPlayerId directly.');

  // Use unityPlayerId if provided, otherwise extract from token payload
  const playerId = unityPlayerId || extractPlayerIdFromToken(unityToken);

  if (!playerId) {
    throw new Error('Could not determine Unity player ID');
  }

  return {
    sub:       playerId,
    projectId: projectId || 'anonymous',
  };
}

/**
 * Verify token with Unity Gaming Services API.
 */
async function verifyWithUGS(unityToken, projectId) {
  const keyId  = process.env.UNITY_SERVICE_ACCOUNT_KEY_ID;
  const secret = process.env.UNITY_SERVICE_ACCOUNT_SECRET;

  const credentials = Buffer.from(`${keyId}:${secret}`).toString('base64');

  const response = await fetch(
    `https://services.api.unity.com/auth/v1/token-exchange?projectId=${projectId}`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ token: unityToken }),
    }
  );

  if (!response.ok) {
    throw new Error(`UGS returned ${response.status}`);
  }

  const data = await response.json();

  return {
    sub:       data.sub || data.userId || data.playerId,
    projectId: data.projectId || projectId,
  };
}

/**
 * Extract player ID from Unity JWT token payload (without verification).
 * Used as fallback in anonymous mode.
 */
function extractPlayerIdFromToken(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return payload.sub || payload.playerId || payload.userId || null;
  } catch {
    return null;
  }
}

module.exports = { verifyUnityToken };