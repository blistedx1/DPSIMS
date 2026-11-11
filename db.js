require('dotenv').config();
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}
const { Pool } = require('pg');

const connectionString = (process.env.DATABASE_URL || '').trim();
let pool = null;

function getPool() {
  if (!connectionString) return null;
  if (!pool) {
    let cs = connectionString;
    try {
      const u = new URL(cs);
      u.searchParams.delete('channel_binding');
      if (u.searchParams.get('sslmode') === 'require' && !u.searchParams.has('uselibpqcompat')) {
        u.searchParams.set('uselibpqcompat', 'true');
      }
      cs = u.toString();
    } catch (e) {}
    pool = new Pool({
      connectionString: cs,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 15000
    });
    pool.on('error', () => {});
  }
  return pool;
}

async function query(sqlText, params = []) {
  const p = getPool();
  if (!p) {
    throw new Error('DATABASE_URL is not configured');
  }

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await p.query(sqlText, params);
      return {
        rows: res.rows || [],
        rowCount: res.rowCount || (res.rows ? res.rows.length : 0),
        fields: res.fields || []
      };
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 250));
      }
    }
  }
  throw lastErr;
}

module.exports = {
  query,
  isConnected: () => !!connectionString
};
