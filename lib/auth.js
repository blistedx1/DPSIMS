require('dotenv').config();
const crypto = require('crypto');

const DEVICE_LOCK_POLICY = (process.env.DEVICE_LOCK || 'required').toLowerCase();
const PERSISTENT_MAX_AGE = 315360000; // 10 years: persistent until explicit logout

function getSessionSecret() {
  const sec = (process.env.SESSION_SECRET || '').trim();
  if (!sec) {
    throw new Error('SESSION_SECRET environment variable is required');
  }
  return sec;
}

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
 * Compute legacy browser djb2-variant hash used before scrypt migration.
 */
function legacyDjb2Hash(secret) {
  let h = 5381;
  const s = 'dps-amrapali|' + String(secret);
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return 'f' + h;
}

function legacyFnvHash(secret) {
  let h = 2166136261;
  const s = 'dps-amrapali|' + String(secret);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'djb2:' + (h >>> 0).toString(16);
}

/**
 * Verify password or PIN against hash with constant-time comparison.
 */
function verifySecret(secret, storedHash) {
  if (!storedHash || !secret) return false;
  const stored = String(storedHash);
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    try {
      if (stored.startsWith('djb2:') || /^f-?\d+$/.test(stored)) {
        const djb = legacyDjb2Hash(secret);
        const raw = stored.startsWith('djb2:') ? stored.slice(5) : stored;
        if (djb.length === raw.length && crypto.timingSafeEqual(Buffer.from(djb), Buffer.from(raw))) return true;
        const fnv = legacyFnvHash(secret);
        return fnv.length === stored.length && crypto.timingSafeEqual(Buffer.from(fnv), Buffer.from(stored));
      }
      const hex = crypto.createHash('sha256').update('dps-amrapali|' + String(secret)).digest('hex');
      const expected = stored.startsWith('sha:') ? 'sha:' + hex : hex;
      return expected.length === stored.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(stored));
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

function needsRehash(storedHash) {
  return !String(storedHash || '').startsWith('scrypt:');
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
  const hmac = crypto.createHmac('sha256', getSessionSecret()).update(dataB64).digest('base64url');
  return `${dataB64}.${hmac}`;
}

/**
 * Verify and unpack HMAC token with expiry check.
 */
function verifyToken(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') return null;
  const parts = tokenStr.split('.');
  if (parts.length !== 2) return null;
  let secret;
  try { secret = getSessionSecret(); } catch (e) { return null; }
  const [dataB64, providedHmac] = parts;
  const expectedHmac = crypto.createHmac('sha256', secret).update(dataB64).digest('base64url');
  
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

function setCorsHeaders(req, res, methods = 'GET, POST, OPTIONS') {
  const origin = req.headers.origin;
  if (origin) {
    const { currentOrigin, expectedOrigins } = getRpContext(req);
    const allowed = origin === currentOrigin
      || expectedOrigins.includes(origin)
      || /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)
      || /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?$/i.test(origin);
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
}

module.exports = {
  hashSecret,
  verifySecret,
  needsRehash,
  signToken,
  verifyToken,
  parseCookies,
  formatCookie,
  getRpContext,
  setCorsHeaders,
  checkRateLimit,
  DEVICE_LOCK_POLICY,
  PERSISTENT_MAX_AGE
};

