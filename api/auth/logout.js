const db = require('../../db');
const { parseCookies, verifyToken, formatCookie, setCorsHeaders } = require('../../lib/auth');

module.exports = async (req, res) => {
  setCorsHeaders(req, res, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const cookies = parseCookies(req.headers.cookie);
    const session = verifyToken(cookies.dps_session);

    if (session && session.userId) {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      await db.query(`
        INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent)
        VALUES ($1, $2, 'logout', $3, $4, $5);
      `, [session.userId, session.username, {}, clientIp, req.headers['user-agent'] || '']).catch(() => {});
    }

    const clearFull = formatCookie('dps_session', '', 0, true);
    const clearLimited = formatCookie('dps_limited_sess', '', 0, true);
    const clearLegacy = formatCookie('dps_portal_token', '', 0, true);
    res.setHeader('Set-Cookie', [clearFull, clearLimited, clearLegacy]);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[API/AUTH/LOGOUT] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};

