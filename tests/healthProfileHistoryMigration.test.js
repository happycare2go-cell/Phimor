const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../backend/migrations/0003_create_care_profile_health_history');

async function sqlFrom(method) {
  const statements = [];
  await migration[method]({ query: async (sql) => { statements.push(String(sql)); } });
  return statements.join('\n');
}

test('health history migration follows version 0003 and creates an additive relational table', async () => {
  assert.equal(migration.version, '0003');
  assert.equal(migration.name, 'create_care_profile_health_history');
  const sql = await sqlFrom('up');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS care_profile_health_history/);
  assert.doesNotMatch(sql, /FOREIGN KEY|REFERENCES\s+"?careProfiles/i);
});

test('health history migration enforces actor, source and changed-field allowlists', async () => {
  const sql = await sqlFrom('up');
  for (const actor of ['family_owner', 'family_caregiver', 'center_owner', 'center_manager', 'system_admin']) assert.match(sql, new RegExp(`'${actor}'`));
  for (const source of ['family_liff', 'center_liff', 'api']) assert.match(sql, new RegExp(`'${source}'`));
  assert.doesNotMatch(sql, /future_ai_assisted/);
  assert.match(sql, /cardinality\(changed_fields\) > 0/);
  assert.match(sql, /changed_fields <@ ARRAY/);
});

test('health history stores changed values as JSONB and retention defaults to NULL', async () => {
  const sql = await sqlFrom('up');
  assert.match(sql, /before_values JSONB NOT NULL/);
  assert.match(sql, /after_values JSONB NOT NULL/);
  assert.match(sql, /retention_until TIMESTAMPTZ DEFAULT NULL/);
  assert.match(sql, /schema_version SMALLINT NOT NULL DEFAULT 1/);
});

test('health history migration creates time and changed-field indexes', async () => {
  const sql = await sqlFrom('up');
  assert.match(sql, /idx_health_history_profile_time/);
  assert.match(sql, /care_profile_id, changed_at DESC, history_id DESC/);
  assert.match(sql, /idx_health_history_changed_fields/);
  assert.match(sql, /USING GIN \(changed_fields\)/);
});

test('health history migration has an explicit rollback', async () => {
  assert.match(await sqlFrom('down'), /DROP TABLE IF EXISTS care_profile_health_history/);
});
