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

    // Verify secret (PIN)
    let secretVerified = false;
    if (pin) {
      secretVerified = verifySecret(pin, user.pin_hash);
    } else if (password) {
      secretVerified = verifySecret(password, user.password_hash);
    }

    if (!secretVerified) {
      // Log failed login
      await db.query(
        'INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6);',
        [user.id, username, 'failed_pin_login', { role }, clientIp, req.headers['user-agent'] || '']
      );
      return res.status(401).json({ ok: false, error: 'Incorrect PIN. Please try again.' });
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

    // Check if user has active passkey / fingerprint saved
    const passkeyRes = await db.query(
      'SELECT id FROM passkeys WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1;',
      [user.id]
    );
    const hasActivePasskey = passkeyRes.rows && passkeyRes.rows.length > 0;

    // Issue full session cookie directly on valid PIN - PIN ALWAYS WORKS!
    const fullToken = signToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
      scope: 'full'
    }, 8 * 60 * 60 * 1000);
    const fullCookie = formatCookie('dps_session', fullToken, 28800, false);

    // Also issue limited session token for WebAuthn calls if needed
    const limitedToken = signToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
      scope: 'register_only'
    }, 10 * 60 * 1000);
    const limitedCookie = formatCookie('dps_limited_sess', limitedToken, 600, false);

    // Set full session cookie immediately so user is authenticated
    res.setHeader('Set-Cookie', [fullCookie, limitedCookie]);

    await db.query(
      'INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6);',
      [user.id, username, 'pin_login_success', { role, hasActivePasskey }, clientIp, req.headers['user-agent'] || '']
    );

    return res.status(200).json({
      ok: true,
      status: 'LOGGED_IN_PIN',
      hasActivePasskey: hasActivePasskey,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.display_name
      },
      message: 'PIN verified successfully.'
    });
  } catch (err) {
    console.error('[API/AUTH/LOGIN] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};

