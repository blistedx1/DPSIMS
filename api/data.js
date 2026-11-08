const db = require('../db');
const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
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
              await db.query(`
                INSERT INTO dps_notifications (id, type, title, body, target_role, target_teacher, tag, slip_id, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (id) DO NOTHING;
              `, [
                `req_new_${r.id}_${Date.now()}`,
                'req_created',
                '📋 New Requisition Slip Raised',
                `${r.by || 'Teacher'} raised slip #${slipNo} (${count} items). Awaiting approval.`,
                ['principal', 'admin'],
                null,
                `req-slip-${r.id}`,
                r.id,
                Date.now()
              ]);
            }
            // 2. Principal verified -> Notify Teacher & Admin
            else if (prevSt === 'Pending' && r.st === 'Verified') {
              await db.query(`
                INSERT INTO dps_notifications (id, type, title, body, target_role, target_teacher, tag, slip_id, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (id) DO NOTHING;
              `, [
                `req_ver_${r.id}_${Date.now()}`,
                'req_verified',
                '✅ Requisition Approved by Principal',
                `Requisition #${slipNo} for ${r.by} has been approved by Principal and forwarded to Admin to issue.`,
                ['admin'],
                r.by,
                `req-verified-${r.id}`,
                r.id,
                Date.now()
              ]);
            }
            // 3. Admin issued/approved -> Notify Teacher
            else if (prevSt === 'Verified' && r.st === 'Approved') {
              await db.query(`
                INSERT INTO dps_notifications (id, type, title, body, target_role, target_teacher, tag, slip_id, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (id) DO NOTHING;
              `, [
                `req_app_${r.id}_${Date.now()}`,
                'req_approved',
                '🎉 Stationery Requisition Issued!',
                `Your requisition #${slipNo} has been approved & issued by Store Admin. Please collect items.`,
                null,
                r.by,
                `req-approved-${r.id}`,
                r.id,
                Date.now()
              ]);
            }
            // 4. Declined -> Notify Teacher
            else if (prevSt && prevSt !== 'Declined' && r.st === 'Declined') {
              await db.query(`
                INSERT INTO dps_notifications (id, type, title, body, target_role, target_teacher, tag, slip_id, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (id) DO NOTHING;
              `, [
                `req_dec_${r.id}_${Date.now()}`,
                'req_declined',
                '❌ Requisition Declined',
                `Your requisition #${slipNo} was declined by ${r.declBy === 'principal' ? 'Principal' : 'Store Admin'}.`,
                null,
                r.by,
                `req-declined-${r.id}`,
                r.id,
                Date.now()
              ]);
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

