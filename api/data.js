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
            let r = await client.query("SELECT payload FROM dps_app_state WHERE key = 'current' FOR UPDATE;");
            if (!r.rows || !r.rows.length) {
              await client.query(
                "INSERT INTO dps_app_state (key, payload, updated_at) VALUES ('current', '{}'::jsonb, NOW()) ON CONFLICT (key) DO NOTHING;"
              );
              r = await client.query("SELECT payload FROM dps_app_state WHERE key = 'current' FOR UPDATE;");
            }
            const cur = (r.rows && r.rows.length && r.rows[0].payload)
              ? (typeof r.rows[0].payload === 'string' ? JSON.parse(r.rows[0].payload) : r.rows[0].payload)
              : { items: [], reqs: [] };
            const m = mergeAppState(cur, parsed);
            const str = JSON.stringify(m.state);
            await client.query(
              "UPDATE dps_app_state SET payload = $1, updated_at = NOW() WHERE key = 'current';",
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
          if (notifs.length > 0) {
            const vals = [];
            const placeholders = notifs.map((n, idx) => {
              const b = idx * 9;
              vals.push(n.id, n.type, n.title, n.body, n.targetRole, n.targetTeacher, n.tag, n.slipId, n.timestamp);
              return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7}, $${b+8}, $${b+9})`;
            }).join(', ');
            const insertJob = db.query(`
              INSERT INTO dps_notifications (id, type, title, body, target_role, target_teacher, tag, slip_id, created_at)
              VALUES ${placeholders}
              ON CONFLICT (id) DO NOTHING;
            `, vals).catch(err => console.error('[API/DATA] Notif insert error:', err.message));
            const pushJobs = notifs.map(n => push.sendPushToSubscribers(n).catch(() => {}));
            // Bound background notification wait so Vercel Hobby never hits its 10s function timeout
            await Promise.race([
              Promise.allSettled([insertJob, ...pushJobs]),
              new Promise(r => setTimeout(r, 1500))
            ]);
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

