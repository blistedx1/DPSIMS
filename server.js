require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('./db');
const push = require('./lib/push');
const { mergeAppState, detectReqNotifications } = require('./lib/sync');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Notification Broker & Live State Cache
const notificationsQueue = [];
const notificationClients = new Set();
let cachedStateStr = null;
let cachedStateAt = 0;

function readLocalDataObj() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {}
  return null;
}

async function readAuthoritativeState(forceFresh) {
  if (db.isConnected()) {
    const r = await db.query("SELECT payload FROM dps_app_state WHERE key = 'current' LIMIT 1;");
    if (r.rows && r.rows.length && r.rows[0].payload) {
      const dbObj = typeof r.rows[0].payload === 'string' ? JSON.parse(r.rows[0].payload) : r.rows[0].payload;
      const str = JSON.stringify(dbObj);
      cachedStateStr = str;
      cachedStateAt = Date.now();
      return { str, obj: dbObj };
    }
    const localObj = readLocalDataObj();
    const chosen = localObj || { items: [], reqs: [] };
    return { str: JSON.stringify(chosen), obj: chosen };
  }

  const localObj = readLocalDataObj();
  const chosen = localObj || { items: [], reqs: [] };
  const str = JSON.stringify(chosen);
  cachedStateStr = str;
  cachedStateAt = Date.now();
  return { str, obj: chosen };
}

function broadcastNotification(notif) {
  if (!notif.id) notif.id = 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  if (!notif.timestamp) notif.timestamp = Date.now();

  // Deduplicate by tag or id in recent queue
  const exists = notificationsQueue.some(n => n.id === notif.id || (notif.tag && n.tag === notif.tag && Math.abs(n.timestamp - notif.timestamp) < 5000));
  if (exists) return;

  notificationsQueue.push(notif);
  if (notificationsQueue.length > 200) notificationsQueue.shift();

  // Persist to Neon DB so Vercel and all remote clients have access
  if (db.isConnected()) {
    db.query(`
      INSERT INTO dps_notifications (id, type, title, body, target_role, target_teacher, tag, slip_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO NOTHING;
    `, [
      notif.id,
      notif.type || 'info',
      notif.title || 'DPS Alert',
      notif.body || '',
      notif.targetRole || null,
      notif.targetTeacher || null,
      notif.tag || null,
      notif.slipId || null,
      notif.timestamp
    ]).catch(err => console.error('[DB] Notif insert error:', err.message));
  }

  // Trigger Web Push via VAPID keys asynchronously
  push.sendPushToSubscribers(notif).catch(err => {
    console.warn('[Push] broadcast trigger warning:', err.message);
  });

  const eventPayload = `data: ${JSON.stringify(notif)}\n\n`;
  notificationClients.forEach(client => {
    try {
      client.res.write(eventPayload);
    } catch (e) {
      notificationClients.delete(client);
    }
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const urlPath = decodeURI(parsedUrl.pathname);

  // CORS headers for all API requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // SSE Real-time Notification Stream
  if (urlPath === '/api/notifications/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');

    const client = { res, req };
    notificationClients.add(client);

    req.on('close', () => {
      notificationClients.delete(client);
    });
    return;
  }

  // Notification API endpoints (Query / Publish)
  if (urlPath === '/api/notifications' || urlPath === '/api/notify') {
    if (req.method === 'GET') {
      const since = parseInt(parsedUrl.searchParams.get('since') || '0', 10);
      if (db.isConnected()) {
        db.query(`
          SELECT id, type, title, body, target_role as "targetRole", target_teacher as "targetTeacher", tag, slip_id as "slipId", created_at as "timestamp"
          FROM dps_notifications
          WHERE created_at > $1
          ORDER BY created_at ASC
          LIMIT 50;
        `, [since]).then(r => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, notifications: r.rows || [] }));
        }).catch(() => {
          const filtered = notificationsQueue.filter(n => n.timestamp > since);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, notifications: filtered }));
        });
        return;
      }
      const filtered = notificationsQueue.filter(n => n.timestamp > since);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, notifications: filtered }));
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy();
      });
      req.on('end', () => {
        try {
          const notif = JSON.parse(body);
          broadcastNotification(notif);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, id: notif.id }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        }
      });
      return;
    }
  }

  // Shared data persistence endpoint (Dual-layer: PostgreSQL + local data.json fallback)
  if (urlPath === '/api/data') {
    const { parseCookies, verifyToken } = require('./lib/auth');
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.dps_limited_sess && !cookies.dps_session) {
      const limited = verifyToken(cookies.dps_limited_sess);
      if (limited && limited.scope === 'register_only') {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          ok: false,
          error: 'Forbidden: Full session required. Please complete device screen lock registration.'
        }));
      }
    }

    if (req.method === 'GET') {
      readAuthoritativeState(true).then(({ str }) => {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        res.end(str);
      }).catch(err => {
        console.error('[DB] Neon read error:', err.message);
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'Neon database read failed' }));
      });
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 5 * 1024 * 1024) req.destroy();
      });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body);
          const { obj: existing } = await readAuthoritativeState(true);
          const { state: merged, assignedId } = mergeAppState(existing, parsed);
          const mergedStr = JSON.stringify(merged);

          // Strict Neon DB persistence first when DB is configured
          if (db.isConnected()) {
            try {
              await db.query(
                "INSERT INTO dps_app_state (key, payload, updated_at) VALUES ('current', $1, NOW()) ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW();",
                [mergedStr]
              );
            } catch (err) {
              console.error('[DB] Cloud sync error:', err.message);
              res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
              return res.end(JSON.stringify({ ok: false, error: 'Neon database write failed: ' + err.message }));
            }
          }

          // Update memory cache & local mirror only after Neon write succeeds
          cachedStateStr = mergedStr;
          cachedStateAt = Date.now();
          try { fs.writeFileSync(DATA_FILE, mergedStr, 'utf8'); } catch (err) {
            console.error('[DATA] Local write error:', err.message);
          }

          // Detect requisition transitions & broadcast live notifications (SSE + DB + Web Push)
          const notifs = detectReqNotifications(existing ? existing.reqs : [], merged.reqs);
          notifs.forEach(n => broadcastNotification(n));

          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          });
          res.end(JSON.stringify({
            ok: true,
            source: db.isConnected() ? 'postgres' : 'local',
            state: merged,
            assignedId: assignedId || null
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message || 'Server error' }));
        }
      });
      return;
    }
  }

// Explicit references so Vercel NFT bundler includes lib/auth and modular APIs
const authLib = require('./lib/auth');
const API_HANDLERS = {
  'auth/login': require('./api/auth/login'),
  'auth/logout': require('./api/auth/logout'),
  'auth/me': require('./api/auth/me'),
  'auth/recover': require('./api/auth/recover'),
  'auth/change-credentials': require('./api/auth/change-credentials'),
  'auth/admin/devices': require('./api/auth/admin/devices'),
  'webauthn/login/options': require('./api/webauthn/login/options'),
  'webauthn/login/verify': require('./api/webauthn/login/verify'),
  'webauthn/register/options': require('./api/webauthn/register/options'),
  'webauthn/register/verify': require('./api/webauthn/register/verify'),
  'push/subscribe': require('./api/push/subscribe')
};

  // Generic /api/* handler for modular serverless functions (Auth & WebAuthn)
  if (urlPath.startsWith('/api/')) {
    const relApi = urlPath.slice(5).replace(/^\/+|\/+$/g, '');
    const handler = API_HANDLERS[relApi];
    if (handler) {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 5 * 1024 * 1024) req.destroy();
      });
      req.on('end', async () => {
        try {
          req.body = body ? JSON.parse(body) : {};
        } catch(e) {
          req.body = body;
        }
        req.query = Object.fromEntries(parsedUrl.searchParams.entries());
        
        // Polyfill Vercel response helper methods
        res.status = function(code) { this.statusCode = code; return this; };
        res.json = function(data) {
          this.setHeader('Content-Type', 'application/json; charset=utf-8');
          this.end(JSON.stringify(data));
          return this;
        };
        res.send = function(data) {
          this.end(data);
          return this;
        };

        try {
          await handler(req, res);
        } catch(err) {
          console.error(`[SERVER API ERROR ${urlPath}]`, err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        }
      });
      return;
    }
  }

// Force NFT (Node File Trace) to bundle critical PWA, lib & shell assets for Vercel
const _TRACE_ASSETS = [
  path.join(__dirname, 'lib', 'auth.js'),
  path.join(__dirname, 'sw.js'),
  path.join(__dirname, 'manifest.json'),
  path.join(__dirname, 'Dps.html'),
  path.join(__dirname, 'index.html'),
  path.join(__dirname, 'icon.svg'),
  path.join(__dirname, 'icon-192.png'),
  path.join(__dirname, 'icon-512.png'),
  path.join(__dirname, 'icon-maskable-512.png')
];

  // Static file serving
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('405 Method Not Allowed');
  }

  let reqPath = urlPath;
  if (reqPath === '/' || reqPath === '') reqPath = '/Dps.html';
  if (reqPath === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  
  let safePath = path.resolve(__dirname, '.' + path.normalize(reqPath));
  if (!fs.existsSync(safePath)) {
    const cwdPath = path.resolve(process.cwd(), '.' + path.normalize(reqPath));
    if (fs.existsSync(cwdPath)) safePath = cwdPath;
  }

  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(safePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (reqPath === '/sw.js') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Service-Worker-Allowed'] = '/';
    } else if (reqPath === '/manifest.json') {
      headers['Cache-Control'] = 'no-cache, must-revalidate';
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? null : data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ifaces = os.networkInterfaces();
  let lanIp = 'localhost';
  for (const name in ifaces) {
    for (const net of ifaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        lanIp = net.address;
        break;
      }
    }
  }

  console.log('======================================================');
  console.log('  Delhi Public School - Stationery App Server');
  console.log('======================================================');
  console.log(`  > Local:    http://localhost:${PORT}/`);
  console.log(`  > Network:  http://${lanIp}:${PORT}/`);
  console.log(`  > Database: ${db.isConnected() ? 'Connected (Neon PostgreSQL)' : 'Local JSON only'}`);
  console.log(`  > Push:     Live (SSE + Notifications API)`);
  console.log('======================================================');
});
