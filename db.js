require('dotenv').config();
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let connectionString = (process.env.DATABASE_URL || '').trim();

// Clean connection string for HTTP API (strip channel_binding which is SCRAM-only)
connectionString = connectionString.replace(/[?&]channel_binding=[^&]+/g, '');

function getHost() {
  try {
    const m = connectionString.match(/@([^/:?]+)/);
    if (!m) return null;
    // Neon HTTP endpoint is on the direct compute endpoint without -pooler
    return m[1].replace('-pooler', '');
  } catch(e) {
    return null;
  }
}

const dbHost = getHost();
const tmpDir = path.join(__dirname, 'scratch');
if (!fs.existsSync(tmpDir)) {
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}
}

async function query(sqlText, params = []) {
  if (!connectionString || !dbHost) {
    throw new Error('DATABASE_URL is not configured');
  }

  const endpoint = `https://${dbHost}/sql`;
  const payload = JSON.stringify({
    query: sqlText,
    params: params
  });

  const tmpFile = path.join(tmpDir, `neon_q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(tmpFile, payload, 'utf8');

  try {
    const raw = execFileSync('curl.exe', [
      '-s',
      '-X', 'POST',
      endpoint,
      '-H', `Neon-Connection-String: ${connectionString}`,
      '-H', 'Content-Type: application/json',
      '--data-binary', `@${tmpFile}`
    ], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024
    });

    try { fs.unlinkSync(tmpFile); } catch(e) {}

    const parsed = JSON.parse(raw);
    if (parsed.message) {
      throw new Error(`Neon DB Error: ${parsed.message}`);
    }
    return {
      rows: parsed.rows || [],
      rowCount: parsed.rowCount || (parsed.rows ? parsed.rows.length : 0),
      fields: parsed.fields || []
    };
  } catch(err) {
    try { fs.unlinkSync(tmpFile); } catch(e) {}
    throw err;
  }
}

module.exports = {
  query,
  isConnected: () => !!(connectionString && dbHost)
};
