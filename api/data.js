const db = require('../db');
const push = require('../lib/push');
const fs = require('fs');
const path = require('path');
const { parseCookies, verifyToken, setCorsHeaders } = require('../lib/auth');
const { mergeAppState, detectReqNotifications, sanitizeStateForClient, authorizeDataOp } = require('../lib/sync');

module.exports = async (req, res) => {
  setCorsHeaders(req, res, 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const cookies = parseCookies(req.headers.cookie);
  const fullSession = verifyToken(cookies.dps_session);
  if (!fullSession || !fullSession.userId || fullSession.scope !== 'full') {
    if (cookies.dps_limited_sess) {
      const limited = verifyToken(cookies.dps_limited_sess);
      if (limited && limited.scope === 'register_only') {
        return res.status(403).json({
          ok: false,
          error: 'Forbidden: Full session required. Please complete device screen lock registration.'
        });
      }
    }
    return res.status(401).json({ ok: false, error: 'Unauthorized. Please sign in first.' });
  }

  const readExisting = async (client) => {
    if (db.isConnected()) {
      const qFn = client ? client.query.bind(client) : db.query.bind(db);
      const r = await qFn(client
        ? "SELECT payload FROM dps_app_state WHERE key = 'current' FOR UPDATE;"
        : "SELECT payload FROM dps_app_state WHERE key = 'current' LIMIT 1;");
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
      const state = sanitizeStateForClient(await readExisting());
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(JSON.stringify(state));
    } catch (err) {
      return res.status(503).json({ ok: false, error: 'Neon DB read failed: ' + err.message });
    }
  }

  // POST: Merge & save atomically inside Neon transaction
  if (req.method === 'POST') {
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
      const parsed = typeof rawBody === 'string' ? JSON.parse(rawBody || '{}') : rawBody;
      const authz = authorizeDataOp(fullSession, parsed);
      if (!authz.ok) {
        return res.status(authz.status || 403).json({ ok: false, error: authz.error });
      }
      let existing, merged, assignedId, mergedStr;

      if (db.isConnected()) {
        try {
          const txRes = await db.withTransaction(async (client) => {
            await client.query(
              "INSERT INTO dps_app_state (key, payload, updated_at) VALUES ('current', '{}'::jsonb, NOW()) ON CONFLICT (key) DO NOTHING;"
            );
            const cur = await readExisting(client);
            const m = mergeAppState(cur, parsed);
            const str = JSON.stringify(m.state);
            await client.query(
              "INSERT INTO dps_app_state (key, payload, updated_at) VALUES ('current', $1, NOW()) ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW();",
              [str]
            );
            return { existing: cur, merged: m.state, assignedId: m.assignedId, mergedStr: str };
          });
          existing = txRes.existing;
          merged = txRes.merged;
          assignedId = txRes.assignedId;
          mergedStr = txRes.mergedStr;
        } catch (dbErr) {
          console.error('[API/DATA] DB write error:', dbErr.message);
          return res.status(503).json({ ok: false, error: 'Neon DB write failed: ' + dbErr.message });
        }

        try {
          const notifs = detectReqNotifications(existing ? existing.reqs : [], merged.reqs);
          const pushJobs = [];
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
            pushJobs.push(push.sendPushToSubscribers(notifData).catch(() => {}));
          }
          if (pushJobs.length > 0) {
            await Promise.race([Promise.allSettled(pushJobs), new Promise(r => setTimeout(r, 2500))]);
          }
        } catch (e) {
          console.error('[API/DATA] Notification diff error:', e.message);
        }
      } else {
        existing = await readExisting();
        const m = mergeAppState(existing, parsed);
        merged = m.state;
        assignedId = m.assignedId;
        mergedStr = JSON.stringify(merged);
      }

      if (!process.env.VERCEL && !db.isConnected()) {
        try {
          fs.writeFileSync(path.join(process.cwd(), 'data.json'), mergedStr, 'utf8');
        } catch (e) {}
      }

      return res.status(200).json({
        ok: true,
        source: db.isConnected() ? 'postgres' : 'local',
        state: sanitizeStateForClient(merged),
        assignedId: assignedId || null
      });
    } catch (err) {
      console.error('[API/DATA] POST error:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  return res.status(405).send('Method Not Allowed');
};

