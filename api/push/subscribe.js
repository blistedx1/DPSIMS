const push = require('../../lib/push');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

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

  // POST: Register or update browser push subscription
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') {
        body = JSON.parse(body);
      }
      const { subscription, role, username } = body || {};
      if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ ok: false, error: 'Invalid push subscription payload' });
      }

      await push.saveSubscription({ subscription, role, username });
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

