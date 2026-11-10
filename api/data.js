const db = require('../db');
const push = require('../lib/push');
const fs = require('fs');
const path = require('path');
const { parseCookies, verifyToken } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

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

  // GET: Read data from Neon DB, fallback to data.json
  if (req.method === 'GET') {
    if (db.isConnected()) {
      try {
        const r = await db.query("SELECT payload FROM dps_app_state WHERE key = 'current' LIMIT 1;");
        if (r.rows && r.rows.length && r.rows[0].payload) {
          const payload = typeof r.rows[0].payload === 'string' ? r.rows[0].payload : JSON.stringify(r.rows[0].payload);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          return res.status(200).send(payload);
        }
      } catch (err) {
        console.error('[API/DATA] DB read error:', err.message);
      }
    }

    try {
      const dataFile = path.join(process.cwd(), 'data.json');
      if (fs.existsSync(dataFile)) {
        const local = fs.readFileSync(dataFile, 'utf8');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.status(200).send(local);
      }
    } catch (e) {}
    return res.status(200).json({ items: [], reqs: [] });
  }

  // POST: Save data to Neon DB, auto-detect requisition status changes and notify
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body !== 'string') {
        body = JSON.stringify(body);
      }
      const parsed = JSON.parse(body);

      if (db.isConnected() && Array.isArray(parsed.reqs)) {
        try {
          const prevRes = await db.query("SELECT payload FROM dps_app_state WHERE key = 'current' LIMIT 1;");
          let prevMap = {};
          if (prevRes.rows && prevRes.rows.length && prevRes.rows[0].payload) {
            const prevParsed = typeof prevRes.rows[0].payload === 'string' ? JSON.parse(prevRes.rows[0].payload) : prevRes.rows[0].payload;
            if (Array.isArray(prevParsed.reqs)) {
              prevParsed.reqs.forEach(r => { if (r && r.id != null) prevMap[r.id] = r.st; });
            }
          }

          for (const r of parsed.reqs) {
            if (!r || r.id == null) continue;
            const prevSt = prevMap[r.id];
            const slipNo = 'REQ-' + String(r.id).padStart(3, '0');

            // 1. Teacher submitted new requisition -> Notify Principal & Admin
            if (prevSt === undefined && r.st === 'Pending') {
              const count = Array.isArray(r.it) ? r.it.length : 0;
              const notifData = {
                id: `req_new_${r.id}_${Date.now()}`,
                type: 'req_created',
                title: '📋 New Requisition Slip Raised',
                body: `${r.by || 'Teacher'} has filled Requisition Slip #${slipNo} (${count} items). Awaiting approval.`,
                targetRole: ['principal', 'admin'],
                targetTeacher: null,
                tag: `req-slip-${r.id}`,
                slipId: r.id,
                timestamp: Date.now()
              };
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
            // 2. Principal verified -> Notify Teacher & Admin
            else if (prevSt === 'Pending' && r.st === 'Verified') {
              const notifData = {
                id: `req_ver_${r.id}_${Date.now()}`,
                type: 'req_verified',
                title: '✅ Requisition Slip Approved by Principal',
                body: `Principal approved Requisition Slip #${slipNo} for ${r.by}. Please issue the requested items.`,
                targetRole: ['admin'],
                targetTeacher: r.by,
                tag: `req-verified-${r.id}`,
                slipId: r.id,
                timestamp: Date.now()
              };
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
            // 3. Admin issued/approved -> Notify Teacher
            else if (prevSt === 'Verified' && r.st === 'Approved') {
              const notifData = {
                id: `req_app_${r.id}_${Date.now()}`,
                type: 'req_approved',
                title: '📦 Requested Items Ready for Collection',
                body: `Your Requisition Slip #${slipNo} has been approved. You can collect your requested items from Admin.`,
                targetRole: ['teacher'],
                targetTeacher: r.by,
                tag: `req-approved-${r.id}`,
                slipId: r.id,
                timestamp: Date.now()
              };
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
            // 4. Declined -> Notify Teacher
            else if (prevSt && prevSt !== 'Declined' && r.st === 'Declined') {
              const notifData = {
                id: `req_dec_${r.id}_${Date.now()}`,
                type: 'req_declined',
                title: '❌ Requisition Slip Declined',
                body: `Your Requisition Slip #${slipNo} was declined by ${r.declBy === 'principal' ? 'Principal' : 'Store Admin'}.`,
                targetRole: ['teacher'],
                targetTeacher: r.by,
                tag: `req-declined-${r.id}`,
                slipId: r.id,
                timestamp: Date.now()
              };
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
          }
        } catch (e) {
          console.error('[API/DATA] Notification diff error:', e.message);
        }

        // Save updated state to PostgreSQL
        await db.query(
          "INSERT INTO dps_app_state (key, payload, updated_at) VALUES ('current', $1, NOW()) ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW();",
          [body]
        );
      }

      try {
        fs.writeFileSync(path.join(process.cwd(), 'data.json'), body, 'utf8');
      } catch (e) {}

      return res.status(200).json({ ok: true, source: db.isConnected() ? 'postgres' : 'local' });
    } catch (err) {
      console.error('[API/DATA] POST error:', err.message);
      return res.status(400).json({ ok: false, error: err.message });
    }
  }

  return res.status(405).send('Method Not Allowed');
};

