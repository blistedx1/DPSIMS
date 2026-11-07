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

const server = http.createServer((req, res) => {
  const urlPath = decodeURI(req.url.split('?')[0]);

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
              // Also update local data.json cache in background
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
          JSON.parse(body);
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
  
  const safePath = path.resolve(__dirname, '.' + path.normalize(reqPath));
  if (!safePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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
  console.log('======================================================');
});
