const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_LOCK_KEY = 73120461;
const MIGRATION_FILE_PATTERN = /^(\d{4,})_[a-z0-9][a-z0-9_-]*\.js$/i;

function checksum(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function validateMigrations(migrations) {
  const seen = new Set();
  for (const migration of migrations) {
    if (!migration || !/^\d{4,}$/.test(String(migration.version))) {
      throw new Error(`Invalid migration version: ${migration?.version ?? '<missing>'}`);
    }
    if (seen.has(String(migration.version))) throw new Error(`Duplicate migration version: ${migration.version}`);
    if (!migration.name || typeof migration.up !== 'function' || typeof migration.down !== 'function') {
      throw new Error(`Invalid migration contract for version ${migration.version}`);
    }
    if (!migration.checksum) throw new Error(`Missing checksum for migration ${migration.version}`);
    seen.add(String(migration.version));
  }
  return [...migrations].sort((a, b) => String(a.version).localeCompare(String(b.version)));
}

function loadMigrations(directory) {
  if (!fs.existsSync(directory)) return [];
  const migrations = fs.readdirSync(directory)
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .map((fileName) => {
      const filePath = path.join(directory, fileName);
      const source = fs.readFileSync(filePath, 'utf8');
      delete require.cache[require.resolve(filePath)];
      return { ...require(filePath), checksum: checksum(source), fileName };
    });
  return validateMigrations(migrations);
}

async function bootstrap(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(32) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      execution_ms INTEGER NOT NULL,
      status VARCHAR(32) NOT NULL CHECK (status IN ('applied'))
    )
  `);
}

async function readApplied(client) {
  const result = await client.query(
    'SELECT version, name, checksum, applied_at, execution_ms, status FROM schema_migrations ORDER BY version'
  );
  return result.rows;
}

function assertChecksums(migrations, applied) {
  const filesByVersion = new Map(migrations.map((migration) => [String(migration.version), migration]));
  for (const record of applied) {
    const migration = filesByVersion.get(String(record.version));
    if (!migration) throw new Error(`Applied migration ${record.version} is missing from the repository`);
    if (migration.checksum !== record.checksum) {
      throw new Error(`Checksum mismatch for applied migration ${record.version} (${record.name})`);
    }
  }
}

async function runMigrations({ pool, migrations }) {
  const ordered = validateMigrations(migrations);
  const client = await pool.connect();
  const appliedNow = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query('BEGIN');
    await bootstrap(client);
    await client.query('COMMIT');

    let applied = await readApplied(client);
    assertChecksums(ordered, applied);
    const appliedVersions = new Set(applied.map((row) => String(row.version)));

    for (const migration of ordered) {
      if (appliedVersions.has(String(migration.version))) continue;
      await client.query('BEGIN');
      const startedAt = Date.now();
      try {
        await migration.up(client);
        const executionMs = Math.max(0, Date.now() - startedAt);
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, execution_ms, status)
           VALUES ($1, $2, $3, $4, 'applied')`,
          [String(migration.version), migration.name, migration.checksum, executionMs]
        );
        await client.query('COMMIT');
        appliedNow.push(String(migration.version));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    applied = await readApplied(client);
    return { applied: appliedNow, currentVersion: applied.at(-1)?.version || null, migrations: applied };
  } catch (error) {
    // Roll back only when a transaction is still open. PostgreSQL safely ignores
    // the extra rollback after an already rolled-back migration transaction.
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]); } finally { client.release(); }
  }
}

async function migrationStatus({ pool, migrations }) {
  const ordered = validateMigrations(migrations);
  const client = await pool.connect();
  try {
    const exists = await client.query("SELECT to_regclass('public.schema_migrations') AS table_name");
    if (!exists.rows[0]?.table_name) {
      return { initialized: false, currentVersion: null, migrations: ordered.map((m) => ({ version: String(m.version), name: m.name, status: 'pending' })) };
    }
    const applied = await readApplied(client);
    assertChecksums(ordered, applied);
    const appliedByVersion = new Map(applied.map((row) => [String(row.version), row]));
    const rows = ordered.map((migration) => ({
      version: String(migration.version), name: migration.name,
      status: appliedByVersion.has(String(migration.version)) ? 'applied' : 'pending',
      appliedAt: appliedByVersion.get(String(migration.version))?.applied_at || null,
    }));
    return { initialized: true, currentVersion: applied.at(-1)?.version || null, migrations: rows };
  } finally {
    client.release();
  }
}

module.exports = {
  MIGRATION_LOCK_KEY, checksum, loadMigrations, validateMigrations,
  bootstrap, runMigrations, migrationStatus,
};
