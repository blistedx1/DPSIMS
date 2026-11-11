const { verifyAuthenticationResponse } = require('@simplewebauthn/server');
const db = require('../../../db');
const { getRpContext, signToken, formatCookie, setCorsHeaders, checkRateLimit, PERSISTENT_MAX_AGE } = require('../../../lib/auth');

module.exports = async (req, res) => {
  setCorsHeaders(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) { body = {}; }
    }
    const { username, response } = body || {};

    if (!username || !response || !response.id) {
      return res.status(400).json({ ok: false, error: 'Username and authentication response are required.' });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const limit = checkRateLimit(`login_verify:${clientIp}:${username}`, 10, 60);
    if (!limit.ok) {
      return res.status(429).json({ ok: false, error: `Too many attempts. Try again in ${limit.retrySec}s.` });
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

    // Find active challenge in DB
    const chalRes = await db.query(`
      SELECT id, challenge 
      FROM webauthn_challenges 
      WHERE user_id = $1 AND type = 'authentication' AND expires_at > NOW()
      ORDER BY id DESC LIMIT 1;
    `, [user.id]);

    if (!chalRes.rows || !chalRes.rows.length) {
      return res.status(400).json({ ok: false, error: 'Authentication challenge expired or not found. Please try again.' });
    }

    const currentChallenge = chalRes.rows[0].challenge;

    // Single use: delete challenge
    await db.query('DELETE FROM webauthn_challenges WHERE id = $1;', [chalRes.rows[0].id]);

    // Find passkey record in DB by credential_id
    const passRes = await db.query(`
      SELECT id, credential_id, public_key, counter, transports, device_label 
      FROM passkeys 
      WHERE user_id = $1 AND credential_id = $2 AND revoked_at IS NULL
      LIMIT 1;
    `, [user.id, response.id]);

    if (!passRes.rows || !passRes.rows.length) {
      return res.status(400).json({ ok: false, error: 'Passkey not recognized or device revoked.' });
    }

    const passkey = passRes.rows[0];
    const { rpID, expectedOrigins } = getRpContext(req);

    // Decode stored public key
    const publicKeyBytes = Buffer.from(passkey.public_key, 'base64url');

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: currentChallenge,
        expectedOrigin: expectedOrigins,
        expectedRPID: rpID,
        credential: {
          id: passkey.credential_id,
          publicKey: publicKeyBytes,
          counter: parseInt(passkey.counter, 10),
          transports: Array.isArray(passkey.transports) ? passkey.transports : []
        },
        requireUserVerification: true
      });
    } catch (err) {
      console.error('[API/WEBAUTHN/LOGIN/VERIFY] Verification exception:', err.message);
      // Audit log failed attempt
      await db.query(
        'INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6);',
        [user.id, username, 'failed_passkey_login', { error: err.message }, clientIp, req.headers['user-agent'] || '']
      );
      return res.status(400).json({ ok: false, error: err.message });
    }

    if (!verification.verified || !verification.authenticationInfo) {
      return res.status(400).json({ ok: false, error: 'Authentication verification failed.' });
    }

    const newCounter = verification.authenticationInfo.newCounter;

    // Update counter and last_used_at
    await db.query(`
      UPDATE passkeys 
      SET counter = $1, last_used_at = NOW() 
      WHERE id = $2;
    `, [newCounter, passkey.id]);

    // Issue persistent FULL session cookie
    const fullToken = signToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
      scope: 'full'
    }, PERSISTENT_MAX_AGE * 1000);

    const fullCookie = formatCookie('dps_session', fullToken, PERSISTENT_MAX_AGE, true);
    res.setHeader('Set-Cookie', fullCookie);

    // Audit log
    await db.query(`
      INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6);
    `, [
      user.id,
      username,
      'passkey_login_success',
      { credentialId: passkey.credential_id.slice(0, 16) + '...', device: passkey.device_label },
      clientIp,
      req.headers['user-agent'] || ''
    ]);

    return res.status(200).json({
      ok: true,
      verified: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.display_name
      }
    });
  } catch (err) {
    console.error('[API/WEBAUTHN/LOGIN/VERIFY] Internal Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};

