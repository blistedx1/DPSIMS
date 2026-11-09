const db = require('../../db');
const { parseCookies, verifyToken } = require('../../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const cookies = parseCookies(req.headers.cookie);
    const fullToken = cookies.dps_session;
    const limitedToken = cookies.dps_limited_sess;

    let session = verifyToken(fullToken);
    let isLimited = false;

    if (!session && limitedToken) {
      session = verifyToken(limitedToken);
      isLimited = true;
    }

    if (!session || !session.userId) {
      return res.status(200).json({ ok: false, user: null });
    }

    const userRes = await db.query(
      'SELECT id, username, role, display_name, pin_changed, reset_required FROM users WHERE id = $1 LIMIT 1;',
      [session.userId]
    );

    if (!userRes.rows || !userRes.rows.length) {
      return res.status(200).json({ ok: false, user: null });
    }

    const user = userRes.rows[0];

    const passRes = await db.query(
      'SELECT count(*) as count FROM passkeys WHERE user_id = $1 AND revoked_at IS NULL;',
      [user.id]
    );
    const passkeyCount = parseInt((passRes.rows && passRes.rows[0] && passRes.rows[0].count) || 0, 10);

    return res.status(200).json({
      ok: true,
      limited: isLimited,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.display_name,
        pinChanged: user.pin_changed,
        resetRequired: user.reset_required
      },
      hasPasskey: passkeyCount > 0,
      passkeyCount
    });
  } catch (err) {
    console.error('[API/AUTH/ME] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};
