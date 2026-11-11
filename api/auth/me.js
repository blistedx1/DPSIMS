const db = require('../../db');
const { parseCookies, verifyToken, setCorsHeaders, classifyApiError } = require('../../lib/auth');

module.exports = async (req, res) => {
  setCorsHeaders(req, res, 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

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

    let teachers = [];
    let hasAdminPasskey = false;
    try {
      const tRes = await db.query(
        "SELECT COALESCE(NULLIF(display_name, ''), username) AS name FROM users WHERE role = 'teacher' ORDER BY name ASC;"
      );
      teachers = (tRes.rows || []).map((r) => r.name).filter(Boolean);
      const admPass = await db.query(
        "SELECT 1 FROM passkeys pk JOIN users u ON u.id = pk.user_id WHERE u.role = 'admin' AND pk.revoked_at IS NULL LIMIT 1;"
      );
      hasAdminPasskey = !!(admPass.rows && admPass.rows.length);
    } catch (_) { }

    if (!session || !session.userId) {
      return res.status(200).json({ ok: false, user: null, sseEnabled: !process.env.VERCEL, teachers, hasAdminPasskey });
    }

    const userRes = await db.query(
      'SELECT id, username, role, display_name, pin_changed, reset_required FROM users WHERE id = $1 LIMIT 1;',
      [session.userId]
    );

    if (!userRes.rows || !userRes.rows.length) {
      return res.status(200).json({ ok: false, user: null, sseEnabled: !process.env.VERCEL, teachers, hasAdminPasskey });
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
      sseEnabled: !process.env.VERCEL,
      teachers,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.display_name,
        pinChanged: user.pin_changed,
        resetRequired: user.reset_required
      },
      hasPasskey: passkeyCount > 0,
      hasAdminPasskey,
      passkeyCount
    });
  } catch (err) {
    console.error('[API/AUTH/ME] Error:', err.message);
    const info = classifyApiError(err);
    return res.status(info.status).json({ ok: false, error: info.error });
  }
};

