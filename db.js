require('dotenv').config();
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let connectionString = (process.env.DATABASE_URL || '').trim();

// Clean connection string for HTTP API (strip channel_binding which is SCRAM-only)
connectionString = connectionString.replace(/[?&]channel_binding=[^&]+/g, '');

function getHost() {
  try {
    const m = connectionString.match(/@([^/:?]+)/);
    if (!m) return null;
    return m[1].replace('-pooler', '');
  } catch(e) {
    return null;
  }
}

const dbHost = getHost();
const tmpDir = os.tmpdir();

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

  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';

  try {
    const raw = execFileSync(bin, [
      '-s',
      '--retry', '2',
      '--retry-delay', '1',
      '--max-time', '18',
      '-X', 'POST',
      endpoint,
      '-H', `Neon-Connection-String: ${connectionString}`,
      '-H', 'Content-Type: application/json',
      '--data-binary', `@${tmpFile}`
    ], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 20000
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
