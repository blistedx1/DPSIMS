const { generateRegistrationOptions } = require('@simplewebauthn/server');
const db = require('../../../db');
const { parseCookies, verifyToken, getRpContext } = require('../../../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const cookies = parseCookies(req.headers.cookie);
    // User can register either via limited session (initial setup) or full session (additional device)
    const sessToken = cookies.dps_limited_sess || cookies.dps_session;
    const session = verifyToken(sessToken);

    if (!session || !session.userId) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized. Sign in with PIN or password first.'
      });
    }

    // Get user from DB
    const userRes = await db.query(
      'SELECT id, username, role, display_name FROM users WHERE id = $1 LIMIT 1;',
      [session.userId]
    );
    if (!userRes.rows || !userRes.rows.length) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    const user = userRes.rows[0];

    // Get existing passkeys for this user to exclude them
    const passkeyRes = await db.query(
      'SELECT credential_id, transports FROM passkeys WHERE user_id = $1 AND revoked_at IS NULL;',
      [user.id]
    );
    const existingPasskeys = (passkeyRes.rows || []).map(p => ({
      id: p.credential_id,
      transports: Array.isArray(p.transports) ? p.transports : []
    }));

    const { rpID, rpName } = getRpContext(req);

    // Convert numeric user ID to Uint8Array buffer for WebAuthn user.id
    const userIDBuffer = Buffer.from(String(user.id), 'utf8');

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: userIDBuffer,
      userName: user.username,
      userDisplayName: user.display_name,
      attestationType: 'none',
      excludeCredentials: existingPasskeys,
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred'
      }
    });

    // Clean up previous registration challenges for this user
    await db.query(
      "DELETE FROM webauthn_challenges WHERE user_id = $1 AND type = 'registration';",
      [user.id]
    );

    // Store new challenge with 5 min TTL
    await db.query(`
      INSERT INTO webauthn_challenges (challenge, user_id, type, expires_at)
      VALUES ($1, $2, 'registration', NOW() + INTERVAL '5 minutes');
    `, [options.challenge, user.id]);

    return res.status(200).json({ ok: true, options });
  } catch (err) {
    console.error('[API/WEBAUTHN/REGISTER/OPTIONS] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to generate registration options' });
  }
};

