require('dotenv').config();
const db = require('../db');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('====================================================');
  console.log('  Delhi Public School - Central Inventory (DPSIMS)');
  console.log('  Database Initialization & Fast Batch Upload');
  console.log('====================================================');

  // 1. Create Schema Tables individually
  console.log('\n[1/5] Verifying Database Schema Tables...');
  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id INT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100),
      unit VARCHAR(50),
      min_level INT DEFAULT 10,
      variants JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS faculties (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id SERIAL PRIMARY KEY,
      tx_date DATE NOT NULL,
      item_id INT REFERENCES inventory_items(id) ON DELETE CASCADE,
      type VARCHAR(10) NOT NULL,
      quantity INT NOT NULL,
      by_person VARCHAR(255),
      variant VARCHAR(100),
      reference VARCHAR(255),
      department VARCHAR(100),
      remarks TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inward_bills (
      id INT PRIMARY KEY,
      bill_no VARCHAR(100),
      inpass_no VARCHAR(100),
      vendor VARCHAR(255),
      bill_date DATE,
      lines JSONB NOT NULL,
      stock_added BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS requisitions (
      id INT PRIMARY KEY,
      by_teacher VARCHAR(255) NOT NULL,
      items JSONB NOT NULL,
      status VARCHAR(50) DEFAULT 'Pending',
      req_date DATE,
      purpose TEXT,
      issued JSONB,
      meta JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS dps_app_state (
      key VARCHAR(64) PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Schema tables ready.');

  // 2. Read Master Data
  const dataPath = path.join(__dirname, '..', 'data.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  console.log('\n[2/5] Cleaning tables for pristine master upload...');
  await db.query('TRUNCATE inventory_transactions, inward_bills, requisitions, inventory_items, faculties, dps_app_state CASCADE;');

  // 3. Batch Insert 84 Items
  console.log(`\n[3/5] Batch uploading ${data.items.length} Store Items...`);
  const itemVals = [];
  const itemParams = [];
  data.items.forEach((it, idx) => {
    const o = idx * 6;
    itemVals.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`);
    itemParams.push(it.id, it.name, it.cat, it.unit, it.min, JSON.stringify(it.v));
  });
  await db.query(`INSERT INTO inventory_items (id, name, category, unit, min_level, variants) VALUES ${itemVals.join(', ')};`, itemParams);
  console.log(`-> ${data.items.length} items uploaded.`);

  // 4. Batch Insert Faculties, Bills, and Transactions
  console.log(`\n[4/5] Batch uploading ${data.fac.length} Faculties & ${data.bills.length} Bills...`);
  const facVals = [];
  const facParams = [];
  data.fac.forEach((f, idx) => {
    facVals.push(`($${idx + 1})`);
    facParams.push(f);
  });
  await db.query(`INSERT INTO faculties (name) VALUES ${facVals.join(', ')} ON CONFLICT (name) DO NOTHING;`, facParams);

  for (const b of data.bills) {
    await db.query(
      `INSERT INTO inward_bills (id, bill_no, inpass_no, vendor, bill_date, lines, stock_added)
       VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [b.id, b.no, b.ip, b.vendor, b.date, JSON.stringify(b.lines), b.stockAdded]
    );
  }

  console.log(`Batch uploading ${data.log.length} Transaction Records...`);
  const txVals = [];
  const txParams = [];
  data.log.forEach((l, idx) => {
    const o = idx * 9;
    txVals.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9})`);
    txParams.push(l.d, l.id, l.t, l.q, l.by || '', l.v || 'Standard', l.ref || '', l.dept || '', l.rem || '');
  });
  await db.query(
    `INSERT INTO inventory_transactions (tx_date, item_id, type, quantity, by_person, variant, reference, department, remarks) VALUES ${txVals.join(', ')};`,
    txParams
  );
  console.log(`-> ${data.log.length} transactions uploaded.`);

  // 5. Upload Master State Snapshot
  console.log('\n[5/5] Uploading Master State Snapshot to dps_app_state...');
  await db.query(
    `INSERT INTO dps_app_state (key, payload, updated_at)
     VALUES ('current', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW();`,
    [JSON.stringify(data)]
  );

  console.log('\n====================================================');
  console.log('  VERIFICATION & AUDIT RESULTS (NEON POSTGRESQL)');
  console.log('====================================================');

  const rItems = await db.query('SELECT COUNT(*) as count FROM inventory_items;');
  const rFac = await db.query('SELECT COUNT(*) as count FROM faculties;');
  const rTx = await db.query('SELECT COUNT(*) as count FROM inventory_transactions;');
  const rBills = await db.query('SELECT COUNT(*) as count FROM inward_bills;');
  const rReqs = await db.query('SELECT COUNT(*) as count FROM requisitions;');
  const rState = await db.query('SELECT COUNT(*) as count FROM dps_app_state;');

  console.log(`  Store Items:        ${rItems.rows[0].count}  (Expected: 84)`);
  console.log(`  Staff Faculties:    ${rFac.rows[0].count}  (Expected: 13)`);
  console.log(`  Ledger Movements:   ${rTx.rows[0].count} (Expected: 161)`);
  console.log(`  Inward Bills:       ${rBills.rows[0].count}   (Expected: 1)`);
  console.log(`  Requisitions:       ${rReqs.rows[0].count}   (Expected: 0)`);
  console.log(`  Master State Sync:  ${rState.rows[0].count}   (Expected: 1)`);
  console.log('====================================================');
  console.log('  ALL MASTER DATA SUCCESSFULLY UPLOADED TO DATABASE!');
  console.log('====================================================');
}

main().catch(err => {
  console.error('\nUpload Failed:', err.message);
  process.exit(1);
});
