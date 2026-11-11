const db = require('../../db');
const { hashSecret, verifySecret, needsRehash, signToken, formatCookie, setCorsHeaders, checkRateLimit, getClientIp, classifyApiError, PERSISTENT_MAX_AGE } = require('../../lib/auth');

module.exports = async (req, res) => {
  setCorsHeaders(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    const { username, role, password, pin, newPin } = body || {};

    if (!username || !role) {
      return res.status(400).json({ ok: false, error: 'Username and role are required' });
    }
    if (!pin && !password) {
      return res.status(400).json({ ok: false, error: 'PIN or password is required' });
    }

    // Rate limit check: max 10 attempts per minute per IP
    const clientIp = getClientIp(req);
    const limit = checkRateLimit(`login:${clientIp}:${username}`, 10, 60);
    if (!limit.ok) {
      return res.status(429).json({ ok: false, error: `Too many attempts. Try again in ${limit.retrySec}s.` });
    }

    // Find user in database (supports both username and display_name match)
    const userRes = await db.query(
      'SELECT id, username, role, display_name, password_hash, pin_hash, pin_changed, pw_changed, reset_required, failed_attempts, locked_until FROM users WHERE (LOWER(username) = LOWER($1) OR LOWER(display_name) = LOWER($1)) AND role = $2 LIMIT 1',
      [String(username).trim(), String(role).trim().toLowerCase()]
    );

    if (!userRes.rows || !userRes.rows.length) {
      return res.status(401).json({ ok: false, error: 'User not found or role mismatch.' });
    }

    const user = userRes.rows[0];

    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      const waitSec = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000);
      return res.status(429).json({ ok: false, error: `Account temporarily locked. Try again in ${waitSec}s.` });
    }

    // Verify secret (PIN or password)
    let secretVerified = false;
    if (pin) {
      secretVerified = verifySecret(pin, user.pin_hash);
    } else if (password) {
      secretVerified = verifySecret(password, user.password_hash);
    }

    if (!secretVerified) {
      const nextFails = (Number(user.failed_attempts) || 0) + 1;
      const lockMinutes = nextFails >= 5 ? 5 : 0;
      await db.query(
        `UPDATE users SET failed_attempts = $1, locked_until = ${lockMinutes ? "NOW() + INTERVAL '5 minutes'" : 'NULL'} WHERE id = $2;`,
        [nextFails, user.id]
      ).catch(() => { });
      db.query(
        'INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6)',
        [user.id, user.username, pin ? 'failed_pin_login' : 'failed_pw_login', { role, fails: nextFails }, clientIp, req.headers['user-agent'] || '']
      ).catch(() => { });
      return res.status(401).json({ ok: false, error: pin ? 'Incorrect PIN. Please try again.' : 'Incorrect password. Please try again.' });
    }

    // Reset failed login counter and transparently rehash legacy SHA/djb2 secrets to scrypt
    const upgradeUpdates = ['failed_attempts = 0', 'locked_until = NULL'];
    const upgradeParams = [];
    if (pin && needsRehash(user.pin_hash)) {
      upgradeParams.push(hashSecret(pin));
      upgradeUpdates.push(`pin_hash = $${upgradeParams.length}`);
    } else if (password && needsRehash(user.password_hash)) {
      upgradeParams.push(hashSecret(password));
      upgradeUpdates.push(`password_hash = $${upgradeParams.length}`);
    }
    upgradeParams.push(user.id);
    await db.query(`UPDATE users SET ${upgradeUpdates.join(', ')}, updated_at = NOW() WHERE id = $${upgradeParams.length};`, upgradeParams);

    // Check forced PIN change requirement (first sign-in or Admin reset) on BOTH PIN and password login
    const mustSetPin = (user.role === 'teacher' && !user.pin_changed) || !!user.reset_required;
    if (mustSetPin) {
      if (newPin) {
        if (!/^\d{4}$/.test(newPin) || /^(\d)\1{3}$/.test(newPin) || '01234567890'.includes(newPin) || '09876543210'.includes(newPin) || newPin === '1234') {
          return res.status(400).json({ ok: false, error: 'Too easy to guess. Choose a different 4-digit PIN.' });
        }
        const newHash = hashSecret(newPin);
        await db.query('UPDATE users SET pin_hash = $1, pin_changed = TRUE, reset_required = FALSE, updated_at = NOW() WHERE id = $2', [newHash, user.id]);
        user.pin_changed = true;
        user.reset_required = false;
      } else {
        return res.status(200).json({
          ok: false,
          code: 'PIN_CHANGE_REQUIRED',
          message: 'First sign-in or reset: Please create a new 4-digit PIN.'
        });
      }
    }

    // Check if user has active passkey / fingerprint saved (Admin only)
    let hasActivePasskey = false;
    if (user.role === 'admin') {
      const passkeyRes = await db.query(
        'SELECT id FROM passkeys WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1',
        [user.id]
      );
      hasActivePasskey = !!(passkeyRes.rows && passkeyRes.rows.length > 0);
    }

    // Issue persistent HttpOnly session cookie (only cleared on explicit logout)
    const fullToken = signToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
      scope: 'full'
    }, PERSISTENT_MAX_AGE * 1000);
    const fullCookie = formatCookie('dps_session', fullToken, PERSISTENT_MAX_AGE, true);

    // Also issue limited session token for WebAuthn calls if needed
    const limitedToken = signToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
      scope: 'register_only'
    }, 10 * 60 * 1000);
    const limitedCookie = formatCookie('dps_limited_sess', limitedToken, 600, true);

    res.setHeader('Set-Cookie', [fullCookie, limitedCookie]);

    db.query(
      'INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6)',
      [user.id, user.username, pin ? 'pin_login_success' : 'pw_login_success', { role: user.role, hasActivePasskey }, clientIp, req.headers['user-agent'] || '']
    ).catch(() => { });

    return res.status(200).json({
      ok: true,
      status: 'LOGGED_IN_PIN',
      hasActivePasskey: hasActivePasskey,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.display_name,
        pinChanged: user.pin_changed,
        resetRequired: user.reset_required
      },
      message: 'Verified successfully.'
    });
  } catch (err) {
    console.error('[API/AUTH/LOGIN] Error:', err.message);
    const info = classifyApiError(err);
    return res.status(info.status).json({ ok: false, error: info.error });
  }
};

