require('dotenv').config();
const path = require('node:path');
const { Pool } = require('pg');
const { loadMigrations, migrationStatus } = require('../utils/migrationRunner');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required to inspect migration status');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const migrations = loadMigrations(path.resolve(__dirname, '..', 'migrations'));
    const status = await migrationStatus({ pool, migrations });
    console.log(`Migration infrastructure: ${status.initialized ? 'initialized' : 'not initialized'}`);
    console.log(`Current version: ${status.currentVersion || 'none'}`);
    for (const migration of status.migrations) console.log(`${migration.version} ${migration.status} ${migration.name}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Migration status failed: ${error.message}`);
  process.exitCode = 1;
});
