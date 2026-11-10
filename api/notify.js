const db = require('../db');
const push = require('../lib/push');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'POST') {
    try {
      let notif = req.body;
      if (typeof notif === 'string') {
        notif = JSON.parse(notif);
      }
      const id = notif.id || `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const timestamp = notif.timestamp || Date.now();

      if (db.isConnected()) {
        await db.query(`
          INSERT INTO dps_notifications (id, type, title, body, target_role, target_teacher, tag, slip_id, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO NOTHING;
        `, [
          id,
          notif.type || 'info',
          notif.title || 'DPS Alert',
          notif.body || '',
          notif.targetRole || null,
          notif.targetTeacher || null,
          notif.tag || null,
          notif.slipId || null,
          timestamp
        ]);
      }

      // Trigger Web Push via VAPID keys asynchronously
      push.sendPushToSubscribers(notif).catch(err => {
        console.warn('[API/NOTIFY] Push trigger warning:', err.message);
      });

      return res.status(200).json({ ok: true, id: id });
    } catch (e) {
      console.error('[API/NOTIFY] Error:', e.message);
      return res.status(400).json({ ok: false, error: e.message });
    }
  }

  return res.status(405).send('Method Not Allowed');
};
