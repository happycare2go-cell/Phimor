const { test } = require('node:test');
const assert = require('node:assert');
const {
  runMigrations, migrationStatus, validateMigrations, MIGRATION_LOCK_KEY,
} = require('../backend/utils/migrationRunner');

class FakeDatabase {
  constructor() {
    this.schemaExists = false;
    this.applied = [];
    this.business = [];
    this.lockTail = Promise.resolve();
  }
}

class FakeClient {
  constructor(database) {
    this.database = database;
    this.transaction = null;
    this.unlock = null;
    this.released = false;
  }

  async query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.startsWith('select pg_advisory_lock')) {
      assert.strictEqual(params[0], MIGRATION_LOCK_KEY);
      const previous = this.database.lockTail;
      let release;
      this.database.lockTail = new Promise((resolve) => { release = resolve; });
      await previous;
      this.unlock = release;
      return { rows: [] };
    }
    if (normalized.startsWith('select pg_advisory_unlock')) {
      this.unlock?.(); this.unlock = null; return { rows: [{ pg_advisory_unlock: true }] };
    }
    if (normalized === 'begin') {
      this.transaction = {
        schemaExists: this.database.schemaExists,
        applied: this.database.applied.map((row) => ({ ...row })),
        business: [...this.database.business],
      };
      return { rows: [] };
    }
    if (normalized === 'commit') { this.transaction = null; return { rows: [] }; }
    if (normalized === 'rollback') {
      if (this.transaction) {
        this.database.schemaExists = this.transaction.schemaExists;
        this.database.applied = this.transaction.applied;
        this.database.business = this.transaction.business;
      }
      this.transaction = null;
      return { rows: [] };
    }
    if (normalized.startsWith('create table if not exists schema_migrations')) {
      this.database.schemaExists = true; return { rows: [] };
    }
    if (normalized.includes("to_regclass('public.schema_migrations')")) {
      return { rows: [{ table_name: this.database.schemaExists ? 'schema_migrations' : null }] };
    }
    if (normalized.startsWith('select version, name, checksum')) {
      if (!this.database.schemaExists) throw new Error('schema_migrations does not exist');
      return { rows: this.database.applied.map((row) => ({ ...row })).sort((a, b) => a.version.localeCompare(b.version)) };
    }
    if (normalized.startsWith('insert into schema_migrations')) {
      this.database.applied.push({
        version: params[0], name: params[1], checksum: params[2], execution_ms: params[3],
        status: 'applied', applied_at: new Date().toISOString(),
      });
      return { rows: [] };
    }
    throw new Error(`Unexpected fake SQL: ${normalized}`);
  }

  recordBusiness(value) { this.database.business.push(value); }
  release() { this.released = true; }
}

class FakePool {
  constructor(database = new FakeDatabase()) { this.database = database; this.clients = []; }
  async connect() { const client = new FakeClient(this.database); this.clients.push(client); return client; }
}

function migration(version, name, up, digest = `checksum-${version}`) {
  return { version, name, checksum: digest, up, async down() {} };
}

test('migration bootstrap initializes only schema_migrations on an empty database', async () => {
  const pool = new FakePool();
  const result = await runMigrations({ pool, migrations: [] });
  assert.strictEqual(pool.database.schemaExists, true);
  assert.deepStrictEqual(pool.database.business, []);
  assert.deepStrictEqual(result.applied, []);
  assert.strictEqual(result.currentVersion, null);
});

test('migration status does not mutate an uninitialized database', async () => {
  const pool = new FakePool();
  const result = await migrationStatus({ pool, migrations: [migration('0001', 'one', async () => {})] });
  assert.strictEqual(result.initialized, false);
  assert.strictEqual(result.migrations[0].status, 'pending');
  assert.strictEqual(pool.database.schemaExists, false);
});

test('an applied migration is not run twice', async () => {
  const pool = new FakePool();
  let calls = 0;
  const item = migration('0001', 'one', async (client) => { calls += 1; client.recordBusiness('one'); });
  await runMigrations({ pool, migrations: [item] });
  const second = await runMigrations({ pool, migrations: [item] });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(second.applied, []);
  assert.deepStrictEqual(pool.database.business, ['one']);
});

test('checksum mismatch for an applied migration is detected', async () => {
  const pool = new FakePool();
  await runMigrations({ pool, migrations: [migration('0001', 'one', async () => {}, 'original')] });
  await assert.rejects(
    runMigrations({ pool, migrations: [migration('0001', 'one', async () => {}, 'changed')] }),
    /Checksum mismatch/
  );
});

test('failed migration rolls back its transaction and is not recorded', async () => {
  const pool = new FakePool();
  const broken = migration('0001', 'broken', async (client) => {
    client.recordBusiness('must-rollback');
    throw new Error('migration exploded');
  });
  await assert.rejects(runMigrations({ pool, migrations: [broken] }), /migration exploded/);
  assert.deepStrictEqual(pool.database.business, []);
  assert.deepStrictEqual(pool.database.applied, []);
});

test('migrations run in version order regardless of input order', async () => {
  const pool = new FakePool();
  const order = [];
  await runMigrations({ pool, migrations: [
    migration('0002', 'two', async () => order.push('0002')),
    migration('0001', 'one', async () => order.push('0001')),
  ] });
  assert.deepStrictEqual(order, ['0001', '0002']);
  assert.deepStrictEqual(pool.database.applied.map((row) => row.version), ['0001', '0002']);
});

test('duplicate migration versions are rejected before database mutation', async () => {
  const items = [migration('0001', 'one', async () => {}), migration('0001', 'duplicate', async () => {})];
  assert.throws(() => validateMigrations(items), /Duplicate migration version/);
});

test('concurrent runners serialize through the advisory lock and apply once', async () => {
  const pool = new FakePool();
  let calls = 0;
  const item = migration('0001', 'one', async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const [first, second] = await Promise.all([
    runMigrations({ pool, migrations: [item] }),
    runMigrations({ pool, migrations: [item] }),
  ]);
  assert.strictEqual(calls, 1);
  assert.strictEqual(first.applied.length + second.applied.length, 1);
  assert.strictEqual(pool.database.applied.length, 1);
  assert.ok(pool.clients.every((client) => client.released));
});

test('infrastructure-only migration run leaves existing application tables untouched', async () => {
  const database = new FakeDatabase();
  database.business = ['centers', 'careProfiles', 'appointments'];
  const pool = new FakePool(database);
  await runMigrations({ pool, migrations: [] });
  assert.deepStrictEqual(database.business, ['centers', 'careProfiles', 'appointments']);
});
