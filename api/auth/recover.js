const db = require('../../db');
const { verifySecret, checkRateLimit } = require('../../lib/auth');

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
    const { username, role, recoveryCode } = body || {};

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const limit = checkRateLimit(`recover:${clientIp}`, 5, 60);
    if (!limit.ok) {
      return res.status(429).json({ ok: false, error: `Too many attempts. Try again in ${limit.retrySec}s.` });
    }

    if (role !== 'admin') {
      return res.status(200).json({
        ok: false,
        canSelfRecover: false,
        message: 'Device screen lock recovery requires Store Administrator assistance. Please contact the Admin to reset your screen lock.'
      });
    }

    // Admin self-recovery
    const adminRes = await db.query(
      "SELECT id, username, admin_recovery_code_hash FROM users WHERE username = 'admin' LIMIT 1;"
    );

    if (!adminRes.rows || !adminRes.rows.length) {
      return res.status(404).json({ ok: false, error: 'Admin account not found.' });
    }

    const adminUser = adminRes.rows[0];

    if (!recoveryCode) {
      return res.status(200).json({
        ok: false,
        canSelfRecover: true,
        message: 'Admin recovery requires the one-time Recovery Code generated during setup.'
      });
    }

    const validCode = verifySecret(recoveryCode.trim(), adminUser.admin_recovery_code_hash);
    if (!validCode) {
      // Audit log failed recovery
      await db.query(`
        INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent)
        VALUES ($1, 'admin', 'failed_admin_recovery_attempt', {}, $2, $3);
      `, [adminUser.id, clientIp, req.headers['user-agent'] || '']);

      return res.status(401).json({ ok: false, error: 'Invalid recovery code. Please check and try again.' });
    }

    // Revoke all existing passkeys for admin
    await db.query('UPDATE passkeys SET revoked_at = NOW() WHERE user_id = $1;', [adminUser.id]);
    // Set reset_required = TRUE so admin can sign in once with password/PIN
    await db.query('UPDATE users SET reset_required = TRUE, updated_at = NOW() WHERE id = $1;', [adminUser.id]);

    // Audit log
    await db.query(`
      INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent)
      VALUES ($1, 'admin', 'admin_screen_lock_reset_via_recovery_code', {}, $2, $3);
    `, [adminUser.id, clientIp, req.headers['user-agent'] || '']);

    return res.status(200).json({
      ok: true,
      message: 'Admin screen lock has been reset successfully. You can now sign in using your Admin password/PIN to register your new device.'
    });
  } catch (err) {
    console.error('[API/AUTH/RECOVER] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};

