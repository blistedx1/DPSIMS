const db = require('../db');
const { parseCookies, verifyToken, setCorsHeaders } = require('../lib/auth');
const { filterNotificationsForSession } = require('../lib/sync');

module.exports = async (req, res) => {
  setCorsHeaders(req, res, 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const cookies = parseCookies(req.headers.cookie);
  const session = verifyToken(cookies.dps_session);
  if (!session || !session.userId || session.scope !== 'full') {
    return res.status(401).json({ ok: false, error: 'Unauthorized. Sign in first.' });
  }

  const since = parseInt((req.query && req.query.since) || '0', 10);

  if (db.isConnected()) {
    try {
      const r = await db.query(`
        SELECT id, type, title, body, target_role as "targetRole", target_teacher as "targetTeacher", tag, slip_id as "slipId", created_at as "timestamp"
        FROM dps_notifications
        WHERE created_at > $1
        ORDER BY created_at ASC
        LIMIT 50;
      `, [since]);
      const notifications = filterNotificationsForSession(r.rows || [], session);
      return res.status(200).json({ ok: true, notifications });
    } catch (e) {
      console.error('[API/NOTIFICATIONS] Query error:', e.message);
    }
  }

  return res.status(200).json({ ok: true, notifications: [] });
};

