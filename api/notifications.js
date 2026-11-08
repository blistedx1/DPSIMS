const db = require('../db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

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
      return res.status(200).json({ ok: true, notifications: r.rows || [] });
    } catch (e) {
      console.error('[API/NOTIFICATIONS] Query error:', e.message);
    }
  }

  return res.status(200).json({ ok: true, notifications: [] });
};
