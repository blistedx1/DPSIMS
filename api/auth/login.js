const db = require('../../db');
const { hashSecret, verifySecret, signToken, formatCookie, checkRateLimit } = require('../../lib/auth');

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
    const { username, role, password, pin, newPin } = body || {};

    if (!username || !role) {
      return res.status(400).json({ ok: false, error: 'Username and role are required' });
    }

    // Rate limit check: max 10 attempts per minute per IP
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const limit = checkRateLimit(`login:${clientIp}:${username}`, 10, 60);
    if (!limit.ok) {
      return res.status(429).json({ ok: false, error: `Too many attempts. Try again in ${limit.retrySec}s.` });
    }

    // Find user in database
    const userRes = await db.query(
      'SELECT id, username, role, display_name, password_hash, pin_hash, pin_changed, pw_changed, reset_required FROM users WHERE username = $1 AND role = $2 LIMIT 1;',
      [username, role]
    );

    if (!userRes.rows || !userRes.rows.length) {
      return res.status(401).json({ ok: false, error: 'User not found or role mismatch.' });
    }

    const user = userRes.rows[0];

    // Check passkey enforcement
    const passkeyRes = await db.query(
      'SELECT id FROM passkeys WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1;',
      [user.id]
    );
    const hasActivePasskey = passkeyRes.rows && passkeyRes.rows.length > 0;

    // ENFORCEMENT: If user has an active passkey and reset_required is FALSE,
    // server refuses PIN/password sign-in!
    if (hasActivePasskey && !user.reset_required) {
      return res.status(403).json({
        ok: false,
        code: 'PASSKEY_ENFORCED',
        message: 'Screen lock / Passkey is enforced for this account. Please use your device screen lock to sign in.'
      });
    }

    // Verify secret (PIN or password)
    let secretVerified = false;
    if (password) {
      secretVerified = verifySecret(password, user.password_hash);
    } else if (pin) {
      secretVerified = verifySecret(pin, user.pin_hash);
    }

    if (!secretVerified) {
      // Log failed login
      await db.query(
        'INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6);',
        [user.id, username, 'failed_pin_pw_login', { role, method: password ? 'password' : 'pin' }, clientIp, req.headers['user-agent'] || '']
      );
      return res.status(401).json({ ok: false, error: 'Incorrect PIN or password. Please try again.' });
    }

    // Check teacher initial PIN change requirement
    if (user.role === 'teacher' && !user.pin_changed) {
      if (newPin) {
        if (!/^\d{4}$/.test(newPin) || /^(\d)\1{3}$/.test(newPin) || '01234567890'.includes(newPin) || '09876543210'.includes(newPin) || newPin === '1234') {
          return res.status(400).json({ ok: false, error: 'Too easy to guess. Choose a different 4-digit PIN.' });
        }
        const newHash = hashSecret(newPin);
        await db.query('UPDATE users SET pin_hash = $1, pin_changed = TRUE, updated_at = NOW() WHERE id = $2;', [newHash, user.id]);
        user.pin_changed = true;
      } else {
        return res.status(200).json({
          ok: false,
          code: 'PIN_CHANGE_REQUIRED',
          message: 'First sign-in: Please create a new 4-digit PIN.'
        });
      }
    }

    // Issue LIMITED session cookie (scope: register_only, 10 min TTL)
    const limitedToken = signToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
      scope: 'register_only'
    }, 10 * 60 * 1000);

    const limitedCookie = formatCookie('dps_limited_sess', limitedToken, 600, true);
    res.setHeader('Set-Cookie', limitedCookie);

    // Audit log
    await db.query(
      'INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6);',
      [user.id, username, 'pin_login_limited_session', { role, resetRequired: user.reset_required }, clientIp, req.headers['user-agent'] || '']
    );

    return res.status(200).json({
      ok: true,
      status: 'ENROLL_REQUIRED',
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.display_name
      },
      message: 'Initial verification successful. Device screen lock enrollment required.'
    });
  } catch (err) {
    console.error('[API/AUTH/LOGIN] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};

