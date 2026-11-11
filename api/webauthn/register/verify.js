const { verifyRegistrationResponse } = require('@simplewebauthn/server');
const db = require('../../../db');
const { parseCookies, verifyToken, getRpContext, formatCookie, signToken, setCorsHeaders, PERSISTENT_MAX_AGE } = require('../../../lib/auth');

module.exports = async (req, res) => {
  setCorsHeaders(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const cookies = parseCookies(req.headers.cookie);
    const sessToken = cookies.dps_limited_sess || cookies.dps_session;
    const session = verifyToken(sessToken);

    if (!session || !session.userId) {
      return res.status(401).json({ ok: false, error: 'Unauthorized session.' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) { body = {}; }
    }
    const { response, deviceLabel } = body || {};

    if (!response || !response.id) {
      return res.status(400).json({ ok: false, error: 'Registration response object is required.' });
    }

    // Retrieve active challenge from DB
    const chalRes = await db.query(`
      SELECT id, challenge 
      FROM webauthn_challenges 
      WHERE user_id = $1 AND type = 'registration' AND expires_at > NOW()
      ORDER BY id DESC LIMIT 1;
    `, [session.userId]);

    if (!chalRes.rows || !chalRes.rows.length) {
      return res.status(400).json({
        ok: false,
        error: 'Registration challenge expired or not found. Please try again.'
      });
    }

    const currentChallenge = chalRes.rows[0].challenge;

    // Single-use guarantee: Delete challenge immediately
    await db.query('DELETE FROM webauthn_challenges WHERE id = $1;', [chalRes.rows[0].id]);

    const { rpID, expectedOrigins } = getRpContext(req);

    // Verify registration response
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: currentChallenge,
        expectedOrigin: expectedOrigins,
        expectedRPID: rpID,
        requireUserVerification: true
      });
    } catch (err) {
      console.error('[API/WEBAUTHN/REGISTER/VERIFY] Verification error:', err.message);
      return res.status(400).json({ ok: false, error: err.message });
    }

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ ok: false, error: 'Registration verification failed.' });
    }

    const { credential } = verification.registrationInfo;
    const credentialID = credential.id;
    // Base64URL string of public key
    const publicKey = Buffer.from(credential.publicKey).toString('base64url');
    const counter = credential.counter || 0;
    const transports = response.response && response.response.transports ? response.response.transports : [];
    const label = deviceLabel || (req.headers['user-agent'] && req.headers['user-agent'].includes('Mobile') ? 'Mobile Device' : 'Desktop Device');

    // Store passkey
    await db.query(`
      INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, device_label, created_at, last_used_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      ON CONFLICT (credential_id) DO UPDATE SET 
        public_key = EXCLUDED.public_key,
        counter = EXCLUDED.counter,
        transports = EXCLUDED.transports,
        device_label = EXCLUDED.device_label,
        revoked_at = NULL,
        last_used_at = NOW();
    `, [
      session.userId,
      credentialID,
      publicKey,
      counter,
      JSON.stringify(transports),
      label
    ]);

    // Clear reset_required flag on user
    await db.query('UPDATE users SET reset_required = FALSE, updated_at = NOW() WHERE id = $1;', [session.userId]);

    // Issue persistent FULL session cookie
    const fullToken = signToken({
      userId: session.userId,
      username: session.username,
      role: session.role,
      displayName: session.displayName,
      scope: 'full'
    }, PERSISTENT_MAX_AGE * 1000);

    const fullCookie = formatCookie('dps_session', fullToken, PERSISTENT_MAX_AGE, true);
    // Clear limited session cookie
    const clearLimitedCookie = formatCookie('dps_limited_sess', '', 0, true);

    res.setHeader('Set-Cookie', [fullCookie, clearLimitedCookie]);

    // Audit log
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    await db.query(`
      INSERT INTO auth_audit_log (user_id, actor_username, action, details, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6);
    `, [
      session.userId,
      session.username,
      'passkey_registered',
      { credentialId: credentialID.slice(0, 16) + '...', label },
      clientIp,
      req.headers['user-agent'] || ''
    ]);

    return res.status(200).json({
      ok: true,
      verified: true,
      user: {
        id: session.userId,
        username: session.username,
        role: session.role,
        displayName: session.displayName
      }
    });
  } catch (err) {
    console.error('[API/WEBAUTHN/REGISTER/VERIFY] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};
