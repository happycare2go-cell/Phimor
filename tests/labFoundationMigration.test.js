const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../backend/migrations/0006_create_structured_lab_results');

async function capture(method) {
  const statements = [];
  await migration[method]({ query: async (sql) => statements.push(String(sql)) });
  return statements.join('\n');
}

test('structured Lab migration is the additive next migration 0006', async () => {
  assert.equal(migration.version, '0006');
  assert.equal(migration.name, 'create_structured_lab_results');
  const sql = await capture('up');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS lab_reports/);
  assert.doesNotMatch(sql, /ALTER TABLE\s+(?:"?careProfiles"?|appointments|medications|consultation_)/i);
});

test('migration creates four relational Lab tables without legacy JSONB storage', async () => {
  const sql = await capture('up');
  for (const table of ['lab_reports', 'lab_report_sources', 'lab_observations', 'lab_report_events']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.doesNotMatch(sql, /CREATE TABLE[^;]+\bdata\s+JSONB\s+NOT NULL/i);
});

test('report lifecycle, correction and confirmation constraints are present', async () => {
  const sql = await capture('up');
  assert.match(sql, /status IN \('draft', 'confirmed', 'voided'\)/);
  assert.match(sql, /UNIQUE \(report_group_id, version_no\)/);
  assert.match(sql, /REFERENCES lab_reports\(report_id\) ON DELETE RESTRICT/);
  assert.match(sql, /report_id <> supersedes_report_id/);
  assert.match(sql, /confirmed_by_actor_type IS NOT NULL/);
  assert.match(sql, /NULLIF\(BTRIM\(void_reason\), ''\) IS NOT NULL/);
});

test('observation constraints preserve source semantics without inventing values', async () => {
  const sql = await capture('up');
  assert.match(sql, /UNIQUE \(report_id, source_ordinal\)/);
  assert.match(sql, /value_type = 'numeric' AND numeric_value IS NOT NULL AND text_value IS NULL/);
  assert.match(sql, /value_type = 'text' AND numeric_value IS NULL/);
  assert.match(sql, /reference_low <= reference_high/);
  assert.match(sql, /loinc_verification_source IS NOT NULL/);
  assert.match(sql, /normalized_numeric_value IS NULL AND ucum_unit IS NULL/);
});

test('provenance schema stores references and metadata but no document bytes or Base64', async () => {
  const sql = await capture('up');
  assert.match(sql, /source_kind IN \('pending_card', 'family_upload', 'center_upload', 'api', 'manual'\)/);
  assert.match(sql, /content_sha256 VARCHAR\(64\)/);
  assert.match(sql, /storage_status IN \('available', 'purged', 'not_retained'\)/);
  assert.doesNotMatch(sql, /base64|BYTEA|document_bytes|image_bytes/i);
});

test('required Lab indexes and event idempotency are present', async () => {
  const sql = await capture('up');
  for (const index of [
    'idx_lab_reports_profile_status_time', 'idx_lab_reports_supersedes',
    'idx_lab_report_sources_report', 'idx_lab_observations_report',
    'idx_lab_observations_comparison_key', 'idx_lab_report_events_report_time',
    'idx_lab_report_events_idempotency',
  ]) assert.match(sql, new RegExp(index));
  assert.match(sql, /WHERE comparison_key IS NOT NULL/);
  assert.match(sql, /WHERE idempotency_key IS NOT NULL/);
});

test('database guards make confirmed reports, observations and provenance immutable', async () => {
  const sql = await capture('up');
  assert.match(sql, /guard_immutable_lab_report\(\)/);
  assert.match(sql, /trg_guard_immutable_lab_observation/);
  assert.match(sql, /trg_guard_immutable_lab_source/);
  assert.match(sql, /trg_guard_append_only_lab_event/);
  assert.match(sql, /lab report events are append-only/);
  assert.match(sql, /confirmed lab report content is immutable/);
});

test('migration rollback drops only new Lab objects in dependency-safe order', async () => {
  const sql = await capture('down');
  assert.match(sql, /DROP TABLE IF EXISTS lab_report_events/);
  assert.match(sql, /DROP TABLE IF EXISTS lab_observations/);
  assert.match(sql, /DROP TABLE IF EXISTS lab_report_sources/);
  assert.match(sql, /DROP TABLE IF EXISTS lab_reports/);
  assert.doesNotMatch(sql, /DROP TABLE IF EXISTS (?:careProfiles|appointments|consultation_)/i);
});
