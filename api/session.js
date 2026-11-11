const { verifyToken, parseCookies, formatCookie, setCorsHeaders } = require('../lib/auth');

module.exports = async (req, res) => {
  setCorsHeaders(req, res, 'GET, DELETE, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const cookies = parseCookies(req.headers.cookie);

    if (req.method === 'GET') {
      const payload = verifyToken(cookies.dps_session);
      if (!payload || !payload.userId || payload.scope !== 'full') {
        return res.status(200).json({ ok: false, session: null });
      }
      return res.status(200).json({
        ok: true,
        session: {
          role: payload.role,
          name: payload.displayName || payload.username,
          t: payload.iat || Date.now()
        }
      });
    }

    if (req.method === 'POST') {
      return res.status(403).json({
        ok: false,
        error: 'Unauthenticated session minting disabled. Sign in via /api/auth/login.'
      });
    }

    if (req.method === 'DELETE') {
      res.setHeader('Set-Cookie', [
        formatCookie('dps_session', '', 0, true),
        formatCookie('dps_limited_sess', '', 0, true),
        formatCookie('dps_portal_token', '', 0, true)
      ]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  } catch (err) {
    console.error('[API/SESSION] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};

