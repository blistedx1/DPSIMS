require('dotenv').config();
const webpush = require('web-push');
const db = require('../db');

const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || '').trim();

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  } catch (e) {
    console.warn('[WebPush] setVapidDetails error:', e.message);
  }
} else {
  console.warn('[WebPush] VAPID environment variables not configured; background push disabled.');
}

/**
 * Save or update a client push subscription
 */
async function saveSubscription({ subscription, role, username }) {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw new Error('Invalid push subscription object');
  }

  const endpoint = subscription.endpoint;
  const p256dh = subscription.keys.p256dh;
  const auth = subscription.keys.auth;
  const created = Date.now();

  if (db.isConnected()) {
    await db.query(`
      INSERT INTO dps_push_subscriptions (endpoint, p256dh, auth, role, user_name, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (endpoint) DO UPDATE SET
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        role = EXCLUDED.role,
        user_name = EXCLUDED.user_name,
        created_at = EXCLUDED.created_at;
    `, [endpoint, p256dh, auth, role || null, username || null, created]);
  }

  return { ok: true };
}

/**
 * Delete a client push subscription (e.g. on logout or unsubscribe)
 */
async function deleteSubscription(endpoint) {
  if (!endpoint) return { ok: false };
  if (db.isConnected()) {
    await db.query('DELETE FROM dps_push_subscriptions WHERE endpoint = $1;', [endpoint]);
  }
  return { ok: true };
}

/**
 * Send real Web Push notification using VAPID to subscribed devices
 */
async function sendPushToSubscribers(notification) {
  if (!notification) return;
  if (!db.isConnected()) return;

  try {
    const res = await db.query('SELECT endpoint, p256dh, auth, role, user_name FROM dps_push_subscriptions;');
    const subs = res.rows || [];
    if (!subs.length) return;

    const payload = JSON.stringify({
      title: notification.title || 'DPS Stationery Alert',
      body: notification.body || '',
      tag: notification.tag || `dps-notify-${Date.now()}`,
      data: notification
    });

    const deadEndpoints = [];

    await Promise.allSettled(subs.map(async sub => {
      // Role & Teacher audience filtering
      const hasTargetRole = Array.isArray(notification.targetRole) && notification.targetRole.length > 0;
      const hasTargetTeacher = !!notification.targetTeacher;

      if (hasTargetRole || hasTargetTeacher) {
        const subRole = (sub.role || '').toLowerCase();
        const subUser = (sub.user_name || '').trim().toLowerCase();
        const roleList = hasTargetRole ? notification.targetRole.map(r => r.toLowerCase()) : [];
        const teacherMatches = hasTargetTeacher && notification.targetTeacher.trim().toLowerCase() === subUser;

        if (hasTargetTeacher && subRole === 'teacher') {
          if (!teacherMatches || (hasTargetRole && !roleList.includes('teacher'))) return;
        } else if (hasTargetRole && !roleList.includes(subRole)) {
          if (!teacherMatches) return;
        } else if (hasTargetTeacher && !hasTargetRole && !teacherMatches) {
          return;
        }
      }

      const pushSub = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth
        }
      };

      try {
        await webpush.sendNotification(pushSub, payload, {
          TTL: 60 * 60 * 24 // 24 hour TTL
        });
      } catch (err) {
        // 404 or 410 indicates the push token expired or user revoked browser permission
        if (err.statusCode === 404 || err.statusCode === 410) {
          deadEndpoints.push(sub.endpoint);
        } else {
          console.warn('[WebPush] Error sending push notification:', err.statusCode, err.message);
        }
      }
    }));

    // Cleanup expired endpoints
    if (deadEndpoints.length > 0) {
      await db.query('DELETE FROM dps_push_subscriptions WHERE endpoint = ANY($1);', [deadEndpoints]);
    }
  } catch (err) {
    console.error('[WebPush] sendPushToSubscribers error:', err.message);
  }
}

module.exports = {
  getPublicKey: () => VAPID_PUBLIC_KEY,
  saveSubscription,
  deleteSubscription,
  sendPushToSubscribers
};

