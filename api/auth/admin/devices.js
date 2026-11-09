const db = require('../../../db');
const { parseCookies, verifyToken } = require('../../../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    // Admin check
    const cookies = parseCookies(req.headers.cookie);
    const session = verifyToken(cookies.dps_session);

    if (!session || !session.userId || session.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Forbidden: Admin access required.' });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    // GET: List users with their passkeys and device status
    if (req.method === 'GET') {
      const targetUserId = req.query && req.query.userId ? parseInt(req.query.userId, 10) : null;

      if (targetUserId) {
        const passRes = await db.query(`
          SELECT id, credential_id, counter, device_label, created_at, last_used_at, revoked_at
          FROM passkeys
          WHERE user_id = $1
          ORDER BY created_at DESC;
        `, [targetUserId]);

        const passkeys = (passRes.rows || []).map(p => ({
          id: p.id,
          credentialIdSnippet: p.credential_id.slice(0, 16) + '...',
          deviceLabel: p.device_label || 'Unnamed Device',
          createdAt: p.created_at,
          lastUsedAt: p.last_used_at,
          revokedAt: p.revoked_at,
          isActive: !p.revoked_at
        }));

        return res.status(200).json({ ok: true, passkeys });
      }

      // Return overview of all users and their active device count
      const usersRes = await db.query(`
        SELECT u.id, u.username, u.role, u.display_name, u.reset_required,
               COUNT(p.id) FILTER (WHERE p.revoked_at IS NULL) as active_devices_count,
               MAX(p.last_used_at) as last_device_login
        FROM users u
        LEFT JOIN passkeys p ON u.id = p.user_id
        GROUP BY u.id
        ORDER BY (u.role = 'admin') DESC, (u.role = 'principal') DESC, u.username ASC;
      `);

      return res.status(200).json({
        ok: true,
        users: (usersRes.rows || []).map(u => ({
          id: u.id,
          username: u.username,
          role: u.role,
          displayName: u.display_name,
          resetRequired: u.reset_required,
          activeDevicesCount: parseInt(u.active_devices_count || 0, 10),
          lastDeviceLogin: u.last_device_login
        }))
      });
    }

    // POST: Manage devices (Revoke single device OR Reset user screen lock)
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) { body = {}; }
      }
      const { action, passkeyId, targetUserId } = body || {};

      if (action === 'revoke') {
        if (!passkeyId) {
          return res.status(400).json({ ok: false, error: 'passkeyId is required.' });
        }
        const passRes = await db.query('SELECT user_id, device_label FROM passkeys WHERE id = $1 LIMIT 1;', [passkeyId]);
        if (!passRes.rows || !passRes.rows.length) {
          return res.status(404).json({ ok: false, error: 'Passkey not found.' });
        }
        const p = passRes.rows[0];

        await db.query('UPDATE passkeys SET revoked_at = NOW() WHERE id = $1;', [passkeyId]);

        await db.query(`
          INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent)
          VALUES ($1, $2, 'admin_revoked_passkey', $3, $4, $5);
        `, [p.user_id, session.username, { passkeyId, deviceLabel: p.device_label }, clientIp, req.headers['user-agent'] || '']);

        return res.status(200).json({ ok: true, message: 'Device revoked successfully.' });
      }

      if (action === 'reset_user') {
        if (!targetUserId) {
          return res.status(400).json({ ok: false, error: 'targetUserId is required.' });
        }
        const targetRes = await db.query('SELECT id, username, role FROM users WHERE id = $1 LIMIT 1;', [targetUserId]);
        if (!targetRes.rows || !targetRes.rows.length) {
          return res.status(404).json({ ok: false, error: 'User not found.' });
        }
        const target = targetRes.rows[0];

        // Revoke all passkeys for target user
        await db.query('UPDATE passkeys SET revoked_at = NOW() WHERE user_id = $1;', [target.id]);

        // Enable reset_required on target user
        await db.query('UPDATE users SET reset_required = TRUE, updated_at = NOW() WHERE id = $1;', [target.id]);

        // Log admin reset
        await db.query(`
          INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent)
          VALUES ($1, $2, 'admin_reset_user_screen_lock', $3, $4, $5);
        `, [target.id, session.username, { targetUsername: target.username, targetRole: target.role }, clientIp, req.headers['user-agent'] || '']);

        return res.status(200).json({
          ok: true,
          message: `Screen lock for ${target.username} has been reset. They may now sign in once with their PIN/password and register a new device.`
        });
      }

      return res.status(400).json({ ok: false, error: 'Unknown action.' });
    }

    return res.status(405).send('Method Not Allowed');
  } catch (err) {
    console.error('[API/AUTH/ADMIN/DEVICES] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};
