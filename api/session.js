const crypto = require('crypto');
const db = require('../db');
const { signToken, verifyToken, parseCookies } = require('../lib/auth');

const SESSION_COOKIE = 'dps_portal_token';
const MAX_AGE_SECONDS = 315360000; // 10 years: stays signed in until explicit logout

let tableReadyPromise = null;
async function ensureTable() {
  if (!db.isConnected()) return false;
  if (!tableReadyPromise) {
    tableReadyPromise = db.query(`
      CREATE TABLE IF NOT EXISTS dps_portal_sessions (
        sid TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen TIMESTAMPTZ DEFAULT NOW()
      );
    `).catch(err => {
      tableReadyPromise = null;
      throw err;
    });
  }
  await tableReadyPromise;
  return true;
}

function makeSessionCookie(req, value, maxAgeSeconds) {
  const isHttps = !!(process.env.VERCEL || req.headers['x-forwarded-proto'] === 'https');
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'SameSite=Lax',
    'HttpOnly'
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const cookies = parseCookies(req.headers.cookie);
    const existingToken = cookies[SESSION_COOKIE];

    if (req.method === 'GET') {
      const payload = verifyToken(existingToken);
      if (!payload || !payload.role || !payload.name) {
        return res.status(200).json({ ok: false, session: null });
      }
      if (db.isConnected() && payload.sid) {
        try {
          await ensureTable();
          const r = await db.query(
            'SELECT role, name FROM dps_portal_sessions WHERE sid = $1 LIMIT 1;',
            [payload.sid]
          );
          if (!r.rows || !r.rows.length) {
            return res.status(200).json({ ok: false, session: null });
          }
          db.query('UPDATE dps_portal_sessions SET last_seen = NOW() WHERE sid = $1;', [payload.sid]).catch(() => {});
          return res.status(200).json({
            ok: true,
            session: { role: r.rows[0].role, name: r.rows[0].name, t: payload.iat || Date.now() }
          });
        } catch (err) {
          console.warn('[API/SESSION] GET DB lookup warning:', err.message);
        }
      }
      return res.status(200).json({
        ok: true,
        session: { role: payload.role, name: payload.name, t: payload.iat || Date.now() }
      });
    }

    if (req.method === 'POST') {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
      const body = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
      const role = String(body.role || '').trim();
      const name = String(body.name || '').trim();
      if (!['admin', 'principal', 'teacher'].includes(role) || !name) {
        return res.status(400).json({ ok: false, error: 'Valid role and name are required' });
      }

      const sid = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      if (db.isConnected()) {
        await ensureTable();
        await db.query(
          'INSERT INTO dps_portal_sessions (sid, role, name, created_at, last_seen) VALUES ($1, $2, $3, NOW(), NOW());',
          [sid, role, name]
        );
      }

      const token = signToken({ sid, role, name }, MAX_AGE_SECONDS * 1000);
      res.setHeader('Set-Cookie', makeSessionCookie(req, token, MAX_AGE_SECONDS));
      return res.status(200).json({ ok: true, session: { role, name, t: Date.now() } });
    }

    if (req.method === 'DELETE') {
      const payload = verifyToken(existingToken);
      if (db.isConnected() && payload && payload.sid) {
        try {
          await ensureTable();
          await db.query('DELETE FROM dps_portal_sessions WHERE sid = $1;', [payload.sid]);
        } catch (err) {
          console.warn('[API/SESSION] DELETE DB warning:', err.message);
        }
      }
      res.setHeader('Set-Cookie', makeSessionCookie(req, '', 0));
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  } catch (err) {
    console.error('[API/SESSION] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'Internal server error' });
  }
};
