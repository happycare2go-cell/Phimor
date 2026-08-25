require('dotenv').config();
const path = require('node:path');
const { Pool } = require('pg');
const { loadMigrations, runMigrations } = require('../utils/migrationRunner');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required to run migrations');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const migrations = loadMigrations(path.resolve(__dirname, '..', 'migrations'));
    const result = await runMigrations({ pool, migrations });
    console.log(`Migration complete. Current version: ${result.currentVersion || 'none'}; applied now: ${result.applied.length}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
