require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('./db');

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

// Notification Broker (In-memory ring buffer + SSE live streaming)
const notificationsQueue = [];
const notificationClients = new Set();
let lastReqsState = null;

// Initialize lastReqsState from data.json if available
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(raw.reqs)) {
      lastReqsState = {};
      raw.reqs.forEach(r => { if (r && r.id != null) lastReqsState[r.id] = r.st; });
    }
  }
} catch (e) {}

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
    const fallbackLocalRead = () => {
      fs.readFile(DATA_FILE, 'utf8', (err, data) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(err ? '{}' : data);
      });
    };

    if (req.method === 'GET') {
      if (db.isConnected()) {
        db.query("SELECT payload FROM dps_app_state WHERE key = 'current' LIMIT 1;")
          .then(r => {
            if (r.rows && r.rows.length && r.rows[0].payload) {
              const payloadStr = typeof r.rows[0].payload === 'string' ? r.rows[0].payload : JSON.stringify(r.rows[0].payload);
              fs.writeFile(DATA_FILE, payloadStr, () => {});
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              return res.end(payloadStr);
            }
            fallbackLocalRead();
          })
          .catch(() => fallbackLocalRead());
        return;
      }
      fallbackLocalRead();
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 5 * 1024 * 1024) req.destroy();
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);

          // Auto-detect requisition status changes and broadcast push notifications
          if (Array.isArray(parsed.reqs)) {
            const nextMap = {};
            parsed.reqs.forEach(r => {
              if (!r || r.id == null) return;
              nextMap[r.id] = r.st;
              const prevSt = lastReqsState ? lastReqsState[r.id] : undefined;

              // 1. New Requisition submitted by Teacher -> Notify Principal & Admin
              if (prevSt === undefined && r.st === 'Pending') {
                const count = Array.isArray(r.it) ? r.it.length : 0;
                broadcastNotification({
                  id: `req_new_${r.id}_${Date.now()}`,
                  type: 'req_created',
                  targetRole: ['principal', 'admin'],
                  title: '📋 New Requisition Slip Raised',
                  body: `${r.by || 'Teacher'} raised requisition #${String(r.id).padStart(3, '0')} (${count} items). Awaiting approval.`,
                  tag: `req-slip-${r.id}`,
                  slipId: r.id
                });
              }
              // 2. Principal verifies slip -> Notify Teacher & Admin
              else if (prevSt === 'Pending' && r.st === 'Verified') {
                broadcastNotification({
                  id: `req_ver_${r.id}_${Date.now()}`,
                  type: 'req_verified',
                  targetTeacher: r.by,
                  targetRole: ['admin'],
                  title: '✅ Requisition Approved by Principal',
                  body: `Requisition #${String(r.id).padStart(3, '0')} for ${r.by} has been approved by Principal and forwarded to Admin.`,
                  tag: `req-verified-${r.id}`,
                  slipId: r.id
                });
              }
              // 3. Admin issues/approves slip -> Notify Teacher
              else if (prevSt === 'Verified' && r.st === 'Approved') {
                broadcastNotification({
                  id: `req_app_${r.id}_${Date.now()}`,
                  type: 'req_approved',
                  targetTeacher: r.by,
                  title: '🎉 Stationery Requisition Issued!',
                  body: `Your requisition #${String(r.id).padStart(3, '0')} has been approved & issued by Store Admin. Please collect items.`,
                  tag: `req-approved-${r.id}`,
                  slipId: r.id
                });
              }
              // 4. Declined slip -> Notify Teacher
              else if (prevSt && prevSt !== 'Declined' && r.st === 'Declined') {
                broadcastNotification({
                  id: `req_dec_${r.id}_${Date.now()}`,
                  type: 'req_declined',
                  targetTeacher: r.by,
                  title: '❌ Requisition Declined',
                  body: `Your requisition #${String(r.id).padStart(3, '0')} was declined by ${r.declBy === 'principal' ? 'Principal' : 'Store Admin'}.`,
                  tag: `req-declined-${r.id}`,
                  slipId: r.id
                });
              }
            });
            lastReqsState = nextMap;
          }

          // 1. Write local disk cache
          fs.writeFile(DATA_FILE, body, 'utf8', err => {
            if (err) console.error('[DATA] Local write error:', err.message);
          });
          // 2. Write to PostgreSQL in cloud
          if (db.isConnected()) {
            db.query(
              "INSERT INTO dps_app_state (key, payload, updated_at) VALUES ('current', $1, NOW()) ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW();",
              [body]
            ).catch(err => console.error('[DB] Cloud sync error:', err.message));
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, source: db.isConnected() ? 'postgres+local' : 'local' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid JSON');
        }
      });
      return;
    }
  }

// Force NFT (Node File Trace) to bundle critical PWA & shell assets for Vercel
const _TRACE_ASSETS = [
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
