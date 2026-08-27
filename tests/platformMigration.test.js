process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../backend/migrations/0008_create_platform_organizations_and_integrations');

async function migrationSql() {
  const statements = [];
  await migration.up({ query: async (sql) => { statements.push(String(sql)); return { rows: [] }; } });
  return statements.join('\n').replace(/\s+/g, ' ');
}

test('P0 uses migration 0008 and creates the relational platform foundation', async () => {
  assert.equal(migration.version, '0008');
  assert.equal(migration.name, 'create_platform_organizations_and_integrations');
  const sql = await migrationSql();
  for (const table of ['organizations', 'organization_centers', 'center_capabilities',
    'integration_clients', 'integration_credentials', 'integration_client_centers',
    'integration_client_event_scopes', 'external_center_mappings',
    'external_subject_mappings', 'platform_audit_events']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'));
  }
});

test('migration enforces tenant, scope, mapping, capability and append-only audit constraints', async () => {
  const sql = await migrationSql();
  assert.match(sql, /center_id VARCHAR\(80\) PRIMARY KEY/i);
  assert.match(sql, /CHECK \(capability_key IN \('vital_signs_v1', 'daily_care_v1'\)\)/i);
  assert.match(sql, /FOREIGN KEY \(integration_client_id, organization_id\)/i);
  assert.match(sql, /FOREIGN KEY \(center_id, organization_id\)/i);
  assert.match(sql, /UNIQUE \(integration_client_id, external_center_id\)/i);
  assert.match(sql, /UNIQUE \(integration_client_id, external_center_id, external_resident_id\)/i);
  assert.match(sql, /pending_subject_mapping/i);
  assert.match(sql, /trg_guard_append_only_platform_audit/i);
});

test('existing Centers are backfilled one-to-one without fuzzy merging', async () => {
  const sql = await migrationSql();
  assert.match(sql, /FROM "centers"/i);
  assert.match(sql, /to_regclass\('public\.centers'\)/i);
  assert.match(sql, /MD5\(center_id\)/i);
  assert.match(sql, /ON CONFLICT \(center_id\) DO NOTHING/i);
  assert.doesNotMatch(sql, /owner_line_id|contact_phone|address|similarity|levenshtein/i);
  assert.match(sql, /organization\.center_backfilled/i);
});

test('migration is additive to legacy product tables and does not create Vital or Daily Care records', async () => {
  const sql = await migrationSql();
  assert.doesNotMatch(sql, /ALTER TABLE\s+"?(centers|residents|careProfiles|appointments|medications)"?/i);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS (vital_sign|daily_care|integration_event)/i);
  assert.doesNotMatch(sql, /DROP TABLE (?!IF EXISTS platform_|IF EXISTS external_|IF EXISTS integration_|IF EXISTS center_capabilities|IF EXISTS organization)/i);
});

test('migration down removes only P0 relational objects', async () => {
  const statements = [];
  await migration.down({ query: async (sql) => { statements.push(String(sql)); return { rows: [] }; } });
  const sql = statements.join('\n');
  assert.match(sql, /DROP TABLE IF EXISTS organizations/i);
  assert.doesNotMatch(sql, /DROP TABLE IF EXISTS "?(centers|residents|careProfiles)"?/i);
});
