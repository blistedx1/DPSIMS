const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET || 'dps-amrapali-auth-session-secret-key-super-secure-2026!';
const DEVICE_LOCK_POLICY = (process.env.DEVICE_LOCK || 'required').toLowerCase();

/**
 * Hash password or PIN using scrypt with random salt.
 * Format: "scrypt:saltHex:keyHex"
 */
function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(String(secret), salt, 64);
  return `scrypt:${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verify password or PIN against hash with constant-time comparison.
 */
function verifySecret(secret, storedHash) {
  if (!storedHash || !secret) return false;
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    // Legacy fallback check (SHA-256 with SALT="dps-amrapali|")
    try {
      const legacy = crypto.createHash('sha256').update('dps-amrapali|' + secret).digest('hex');
      return crypto.timingSafeEqual(Buffer.from(legacy), Buffer.from(storedHash));
    } catch (e) {
      return false;
    }
  }
  const [, salt, originalKeyHex] = parts;
  const originalKey = Buffer.from(originalKeyHex, 'hex');
  const derivedKey = crypto.scryptSync(String(secret), salt, 64);
  if (originalKey.length !== derivedKey.length) return false;
  return crypto.timingSafeEqual(originalKey, derivedKey);
}

/**
 * Sign an arbitrary payload with HMAC-SHA256 (Base64URL encoded).
 */
function signToken(payloadObj, expiresInMs) {
  const payload = {
    ...payloadObj,
    exp: Date.now() + expiresInMs,
    iat: Date.now()
  };
  const jsonStr = JSON.stringify(payload);
  const dataB64 = Buffer.from(jsonStr).toString('base64url');
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(dataB64).digest('base64url');
  return `${dataB64}.${hmac}`;
}

/**
 * Verify and unpack HMAC token with expiry check.
 */
function verifyToken(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') return null;
  const parts = tokenStr.split('.');
  if (parts.length !== 2) return null;
  const [dataB64, providedHmac] = parts;
  const expectedHmac = crypto.createHmac('sha256', SESSION_SECRET).update(dataB64).digest('base64url');
  
  if (providedHmac.length !== expectedHmac.length) return null;
  const validSig = crypto.timingSafeEqual(Buffer.from(providedHmac), Buffer.from(expectedHmac));
  if (!validSig) return null;

  try {
    const payload = JSON.parse(Buffer.from(dataB64, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) {
      return null; // Expired
    }
    return payload;
  } catch (e) {
    return null;
  }
}

/**
 * Parse Cookie header into key-value map.
 */
function parseCookies(cookieHeader) {
  const map = {};
  if (!cookieHeader) return map;
  const pairs = cookieHeader.split(';');
  for (const p of pairs) {
    const idx = p.indexOf('=');
    if (idx > -1) {
      const key = p.slice(0, idx).trim();
      const val = p.slice(idx + 1).trim();
      map[key] = decodeURIComponent(val);
    }
  }
  return map;
}

/**
 * Format a Set-Cookie header string.
 */
function formatCookie(name, value, maxAgeSeconds, isHttpOnly = true) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'SameSite=Lax'
  ];
  if (isHttpOnly) parts.push('HttpOnly');
  // Only add Secure if not on plain localhost HTTP
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Extract origin and RP ID dynamically from request, supporting preview and production URLs.
 */
function getRpContext(req) {
  const hostHeader = (req.headers['x-forwarded-host'] || req.headers['host'] || '').split(':')[0].trim();
  const protoHeader = (req.headers['x-forwarded-proto'] || (hostHeader.includes('localhost') ? 'http' : 'https')).trim();
  
  const currentOrigin = `${protoHeader}://${req.headers['host'] || hostHeader}`;
  
  // RP_ID from env or host
  let rpID = process.env.RP_ID ? process.env.RP_ID.trim() : hostHeader || 'localhost';
  if (hostHeader && hostHeader !== 'localhost') {
    rpID = hostHeader;
  }

  const rpName = process.env.RP_NAME || 'Delhi Public School Amrapali';

  // Allowed origins list
  const configuredOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  const originsSet = new Set([
    currentOrigin,
    `https://${rpID}`,
    `http://localhost:3000`,
    `http://127.0.0.1:3000`,
    'https://dpsims.vercel.app',
    ...configuredOrigins
  ]);

  return {
    rpID,
    rpName,
    currentOrigin,
    expectedOrigins: Array.from(originsSet)
  };
}

/**
 * In-memory rate limiter per IP / identifier.
 */
const rateLimitMap = new Map();

function checkRateLimit(key, maxTries, windowSec) {
  const now = Date.now();
  let record = rateLimitMap.get(key);
  if (!record || now > record.resetTime) {
    record = { count: 1, resetTime: now + windowSec * 1000 };
    rateLimitMap.set(key, record);
    return { ok: true, remaining: maxTries - 1 };
  }
  record.count++;
  if (record.count > maxTries) {
    const retrySec = Math.ceil((record.resetTime - now) / 1000);
    return { ok: false, retrySec };
  }
  return { ok: true, remaining: maxTries - record.count };
}

// Clean up old rate limit records periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap.entries()) {
    if (now > v.resetTime) rateLimitMap.delete(k);
  }
}, 60000).unref();

module.exports = {
  hashSecret,
  verifySecret,
  signToken,
  verifyToken,
  parseCookies,
  formatCookie,
  getRpContext,
  checkRateLimit,
  DEVICE_LOCK_POLICY
};

