const db = require('../db');
const push = require('../lib/push');
const fs = require('fs');
const path = require('path');
const { parseCookies, verifyToken } = require('../lib/auth');
const { mergeAppState, detectReqNotifications } = require('../lib/sync');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Block calls made with only a limited session
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.dps_limited_sess && !cookies.dps_session) {
    const limited = verifyToken(cookies.dps_limited_sess);
    if (limited && limited.scope === 'register_only') {
      return res.status(403).json({
        ok: false,
        error: 'Forbidden: Full session required. Please complete device screen lock registration.'
      });
    }
  }

  const readExisting = async () => {
    if (db.isConnected()) {
      const r = await db.query("SELECT payload FROM dps_app_state WHERE key = 'current' LIMIT 1;");
      if (r.rows && r.rows.length && r.rows[0].payload) {
        return typeof r.rows[0].payload === 'string' ? JSON.parse(r.rows[0].payload) : r.rows[0].payload;
      }
      return { items: [], reqs: [] };
    }
    let localObj = null;
    try {
      const dataFile = path.join(process.cwd(), 'data.json');
      if (fs.existsSync(dataFile)) {
        localObj = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      }
    } catch (e) {}
    return localObj || { items: [], reqs: [] };
  };

  // GET: Read strictly from Neon DB (fallback to data.json only when DB is unconfigured)
  if (req.method === 'GET') {
    try {
      const state = await readExisting();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(JSON.stringify(state));
    } catch (err) {
      return res.status(503).json({ ok: false, error: 'Neon DB read failed: ' + err.message });
    }
  }

  // POST: Merge & save strictly to Neon DB first
  if (req.method === 'POST') {
    try {
      const parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const existing = await readExisting();
      const { state: merged, assignedId } = mergeAppState(existing, parsed);
      const mergedStr = JSON.stringify(merged);

      if (db.isConnected()) {
        try {
          await db.query(
            "INSERT INTO dps_app_state (key, payload, updated_at) VALUES ('current', $1, NOW()) ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW();",
            [mergedStr]
          );
        } catch (dbErr) {
          console.error('[API/DATA] DB write error:', dbErr.message);
          return res.status(503).json({ ok: false, error: 'Neon DB write failed: ' + dbErr.message });
        }

        try {
          const notifs = detectReqNotifications(existing ? existing.reqs : [], merged.reqs);
          for (const notifData of notifs) {
            await db.query(`
              INSERT INTO dps_notifications (id, type, title, body, target_role, target_teacher, tag, slip_id, created_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
              ON CONFLICT (id) DO NOTHING;
            `, [
              notifData.id,
              notifData.type,
              notifData.title,
              notifData.body,
              notifData.targetRole,
              notifData.targetTeacher,
              notifData.tag,
              notifData.slipId,
              notifData.timestamp
            ]);
            push.sendPushToSubscribers(notifData).catch(() => {});
          }
        } catch (e) {
          console.error('[API/DATA] Notification diff error:', e.message);
        }
      }

      try {
        fs.writeFileSync(path.join(process.cwd(), 'data.json'), mergedStr, 'utf8');
      } catch (e) {}

      return res.status(200).json({
        ok: true,
        source: db.isConnected() ? 'postgres' : 'local',
        state: merged,
        assignedId: assignedId || null
      });
    } catch (err) {
      console.error('[API/DATA] POST error:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  return res.status(405).send('Method Not Allowed');
};

