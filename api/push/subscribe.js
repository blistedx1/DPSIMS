const push = require('../../lib/push');
const { parseCookies, verifyToken, setCorsHeaders } = require('../../lib/auth');

module.exports = async (req, res) => {
  setCorsHeaders(req, res, 'GET, POST, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // GET: Return public VAPID key
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      publicKey: push.getPublicKey()
    });
  }

  // POST: Register or update browser push subscription (bound to authenticated session)
  if (req.method === 'POST') {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const session = verifyToken(cookies.dps_session);
      if (!session || !session.userId || session.scope !== 'full') {
        return res.status(401).json({ ok: false, error: 'Unauthorized. Sign in before enabling notifications.' });
      }
      let body = req.body;
      if (typeof body === 'string') {
        body = JSON.parse(body);
      }
      const { subscription } = body || {};
      if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ ok: false, error: 'Invalid push subscription payload' });
      }

      await push.saveSubscription({
        subscription,
        role: session.role,
        username: session.displayName || session.username
      });
      if (body && body.test === true) {
        await push.sendTestNotification(subscription, {
          role: session.role,
          name: session.displayName || session.username
        });
        return res.status(200).json({ ok: true, tested: true, message: 'Test push sent to this device' });
      }
      return res.status(200).json({ ok: true, message: 'Subscription saved successfully' });
    } catch (e) {
      console.error('[API/PUSH/SUBSCRIBE] Save error:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // DELETE: Unsubscribe
  if (req.method === 'DELETE') {
    try {
      let body = req.body;
      if (typeof body === 'string') {
        body = JSON.parse(body);
      }
      const endpoint = (body && body.endpoint) || (req.query && req.query.endpoint);
      if (endpoint) {
        await push.deleteSubscription(endpoint);
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  return res.status(405).send('Method Not Allowed');
};

