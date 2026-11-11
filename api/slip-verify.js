const fs = require('fs');
const path = require('path');
const db = require('../db');
const { setCorsHeaders } = require('../lib/auth');
const { extractPublicSlip } = require('../lib/sync');

module.exports = async (req, res) => {
  setCorsHeaders(req, res, 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  try {
    const id = req.query && req.query.id;
    if (!id) {
      return res.status(400).json({ ok: false, error: 'Missing slip id' });
    }

    let state = null;
    if (db.isConnected()) {
      const r = await db.query("SELECT payload FROM dps_app_state WHERE key = 'current' LIMIT 1;");
      if (r.rows && r.rows.length && r.rows[0].payload) {
        state = typeof r.rows[0].payload === 'string' ? JSON.parse(r.rows[0].payload) : r.rows[0].payload;
      }
    } else {
      try {
        const dataFile = path.join(process.cwd(), 'data.json');
        if (fs.existsSync(dataFile)) state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      } catch (e) {}
    }

    const slip = extractPublicSlip(state, id);
    if (!slip) {
      return res.status(404).json({ ok: false, error: 'Slip not found' });
    }
    return res.status(200).json({ ok: true, slip });
  } catch (err) {
    console.error('[API/SLIP-VERIFY] Error:', err.message);
    return res.status(503).json({ ok: false, error: 'Database lookup failed' });
  }
};

