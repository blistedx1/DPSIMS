const db = require('../../db');
const { hashSecret, verifySecret, parseCookies, verifyToken } = require('../../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) { body = {}; }
    }
    const { currentSecret, newPin, newPassword, targetRole, targetUsername } = body || {};

    if (!newPin && !newPassword) {
      return res.status(400).json({ ok: false, error: 'Please provide a new PIN or new password.' });
    }

    if (newPin) {
      if (!/^\d{4}$/.test(newPin)) {
        return res.status(400).json({ ok: false, error: 'PIN must be exactly 4 digits.' });
      }
      if (/^(\d)\1{3}$/.test(newPin) || '01234567890'.includes(newPin) || '09876543210'.includes(newPin)) {
        return res.status(400).json({ ok: false, error: 'PIN is too simple. Choose a stronger 4-digit PIN.' });
      }
    }

    if (newPassword && newPassword.length < 4) {
      return res.status(400).json({ ok: false, error: 'Password must be at least 4 characters long.' });
    }

    // Determine target user
    const cookies = parseCookies(req.headers.cookie);
    const session = verifyToken(cookies.dps_session);

    let targetUser = null;

    if (session && session.userId) {
      if (session.role === 'admin' && targetUsername) {
        const uRes = await db.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1;', [targetUsername]);
        if (uRes.rows && uRes.rows.length) targetUser = uRes.rows[0];
      } else {
        const uRes = await db.query('SELECT * FROM users WHERE id = $1 LIMIT 1;', [session.userId]);
        if (uRes.rows && uRes.rows.length) targetUser = uRes.rows[0];
      }
    }

    // Fallback: search by targetUsername or targetRole
    if (!targetUser) {
      const uname = targetUsername || (targetRole === 'principal' ? 'principal' : targetRole === 'admin' ? 'admin' : '');
      if (uname) {
        const uRes = await db.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1;', [uname]);
        if (uRes.rows && uRes.rows.length) targetUser = uRes.rows[0];
      }
    }

    if (!targetUser) {
      return res.status(404).json({ ok: false, error: 'User account not found.' });
    }

    // Verify current credentials if not admin acting on another account
    const isAdminBypass = session && session.role === 'admin' && targetUser.id !== session.userId;
    if (!isAdminBypass) {
      if (!currentSecret) {
        return res.status(400).json({ ok: false, error: 'Current password or PIN is required.' });
      }
      const verified = verifySecret(currentSecret, targetUser.pin_hash) || verifySecret(currentSecret, targetUser.password_hash);
      if (!verified) {
        return res.status(401).json({ ok: false, error: 'Current password or PIN is incorrect.' });
      }
    }

    const newPinHash = newPin ? hashSecret(newPin) : null;
    const newPwHash = newPassword ? hashSecret(newPassword) : null;

    await db.query(`
      UPDATE users
      SET pin_hash = COALESCE($1, pin_hash),
          password_hash = COALESCE($2, password_hash),
          pin_changed = CASE WHEN $1 IS NOT NULL THEN TRUE ELSE pin_changed END,
          pw_changed = CASE WHEN $2 IS NOT NULL THEN TRUE ELSE pw_changed END,
          updated_at = NOW()
      WHERE id = $3;
    `, [newPinHash, newPwHash, targetUser.id]);

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    await db.query(`
      INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent)
      VALUES ($1, $2, 'changed_credentials', $3, $4, $5);
    `, [targetUser.id, (session && session.username) || targetUser.username, { pinUpdated: !!newPin, pwUpdated: !!newPassword }, clientIp, req.headers['user-agent'] || '']).catch(() => {});

    return res.status(200).json({
      ok: true,
      message: 'Credentials successfully updated in Neon database.'
    });
  } catch (err) {
    console.error('[API/AUTH/CHANGE-CREDENTIALS] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error: ' + err.message });
  }
};
