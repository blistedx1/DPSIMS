require('dotenv').config();
const db = require('../db');
const { hashSecret } = require('../lib/auth');

const TEACHERS = [
  "Mr. Abhishek Shukla",
  "Mr. Anugraha",
  "Mr. Devesh Saini",
  "Ms. Aparna",
  "Ms. Divyanshi",
  "Ms. Eishwari",
  "Ms. Harshita",
  "Ms. Juhee",
  "Ms. Kajal",
  "Ms. Kaynat",
  "Ms. Pragya",
  "Ms. Rachana",
  "Ms. Shivangi"
];

async function migrate() {
  console.log('--- Starting Auth & Passkey Migration ---');
  if (!db.isConnected()) {
    throw new Error('Database is not connected! Check DATABASE_URL in .env');
  }

  // 1. Create tables
  console.log('[1/4] Creating users table...');
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      role VARCHAR(20) NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      pin_hash VARCHAR(255) NOT NULL,
      pin_changed BOOLEAN DEFAULT FALSE,
      pw_changed BOOLEAN DEFAULT FALSE,
      reset_required BOOLEAN DEFAULT FALSE,
      admin_recovery_code_hash VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('[2/4] Creating passkeys table...');
  await db.query(`
    CREATE TABLE IF NOT EXISTS passkeys (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      credential_id VARCHAR(512) UNIQUE NOT NULL,
      public_key TEXT NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      transports JSONB DEFAULT '[]'::jsonb,
      device_label VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      last_used_at TIMESTAMP,
      revoked_at TIMESTAMP
    );
  `);

  console.log('[3/4] Creating webauthn_challenges & auth_audit_log tables...');
  await db.query(`
    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      id SERIAL PRIMARY KEY,
      challenge VARCHAR(255) NOT NULL,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(32) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS auth_audit_log (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      actor_username VARCHAR(100),
      action VARCHAR(100) NOT NULL,
      details JSONB,
      ip_address VARCHAR(100),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_passkeys_user_id ON passkeys(user_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_passkeys_cred_id ON passkeys(credential_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_challenges_lookup ON webauthn_challenges(challenge, user_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_created ON auth_audit_log(created_at DESC);`);

  // 2. Seed Default Accounts (passwords/PINs must come from environment variables)
  console.log('[4/4] Seeding default accounts (Admin, Principal, Teachers)...');

  if (!process.env.SEED_ADMIN_PW || !process.env.SEED_PRINCIPAL_PW || !process.env.SEED_TEACHER_PW) {
    throw new Error('Set SEED_ADMIN_PW, SEED_PRINCIPAL_PW, SEED_TEACHER_PW (and optional SEED_*_PIN / SEED_ADMIN_RECOVER) in env before running seed migration.');
  }

  const adminPwHash = hashSecret(process.env.SEED_ADMIN_PW);
  const adminPinHash = hashSecret(process.env.SEED_ADMIN_PIN || '2026');
  const adminRecoverHash = process.env.SEED_ADMIN_RECOVER ? hashSecret(process.env.SEED_ADMIN_RECOVER) : null;

  await db.query(`
    INSERT INTO users (username, role, display_name, password_hash, pin_hash, pin_changed, pw_changed, admin_recovery_code_hash)
    VALUES ('admin', 'admin', 'Administrator', $1, $2, FALSE, FALSE, $3)
    ON CONFLICT (username) DO NOTHING;
  `, [adminPwHash, adminPinHash, adminRecoverHash]);

  // Principal
  const princPwHash = hashSecret(process.env.SEED_PRINCIPAL_PW);
  const princPinHash = hashSecret(process.env.SEED_PRINCIPAL_PIN || '2025');

  await db.query(`
    INSERT INTO users (username, role, display_name, password_hash, pin_hash, pin_changed, pw_changed)
    VALUES ('principal', 'principal', 'Principal', $1, $2, FALSE, FALSE)
    ON CONFLICT (username) DO NOTHING;
  `, [princPwHash, princPinHash]);

  // Teachers
  const teacherPwHash = hashSecret(process.env.SEED_TEACHER_PW);
  const teacherPinHash = hashSecret(process.env.SEED_TEACHER_PIN || '1234');

  for (const name of TEACHERS) {
    await db.query(`
      INSERT INTO users (username, role, display_name, password_hash, pin_hash, pin_changed, pw_changed)
      VALUES ($1, 'teacher', $1, $2, $3, FALSE, FALSE)
      ON CONFLICT (username) DO NOTHING;
    `, [name, teacherPwHash, teacherPinHash]);
  }

  console.log('✅ Auth and Passkey database migration completed successfully!');
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
