const { generateAuthenticationOptions } = require('@simplewebauthn/server');
const db = require('../../../db');
const { getRpContext, checkRateLimit } = require('../../../lib/auth');

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
    const { username, role } = body || {};

    if (!username) {
      return res.status(400).json({ ok: false, error: 'Username is required.' });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const limit = checkRateLimit(`login_opts:${clientIp}:${username}`, 20, 60);
    if (!limit.ok) {
      return res.status(429).json({ ok: false, error: `Too many requests. Try again in ${limit.retrySec}s.` });
    }

    // Find user
    const userRes = await db.query(
      'SELECT id, username, role, display_name FROM users WHERE username = $1 LIMIT 1;',
      [username]
    );

    if (!userRes.rows || !userRes.rows.length) {
      return res.status(404).json({ ok: false, error: 'User not found.' });
    }
    const user = userRes.rows[0];

    // Find active passkeys for user
    const passRes = await db.query(
      'SELECT credential_id, transports FROM passkeys WHERE user_id = $1 AND revoked_at IS NULL;',
      [user.id]
    );

    if (!passRes.rows || !passRes.rows.length) {
      return res.status(200).json({
        ok: false,
        code: 'NO_PASSKEY',
        message: 'No registered device screen lock found for this account. Please sign in with PIN to enroll.'
      });
    }

    const allowCredentials = passRes.rows.map(p => ({
      id: p.credential_id,
      transports: Array.isArray(p.transports) ? p.transports : []
    }));

    const { rpID } = getRpContext(req);

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification: 'required'
    });

    // Delete previous authentication challenges
    await db.query(
      "DELETE FROM webauthn_challenges WHERE user_id = $1 AND type = 'authentication';",
      [user.id]
    );

    // Store challenge with 5 min TTL
    await db.query(`
      INSERT INTO webauthn_challenges (challenge, user_id, type, expires_at)
      VALUES ($1, $2, 'authentication', NOW() + INTERVAL '5 minutes');
    `, [options.challenge, user.id]);

    return res.status(200).json({
      ok: true,
      options,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.display_name
      }
    });
  } catch (err) {
    console.error('[API/WEBAUTHN/LOGIN/OPTIONS] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to generate authentication options' });
  }
};

