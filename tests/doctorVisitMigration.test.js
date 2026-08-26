const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../backend/migrations/0007_create_doctor_visit_records');

async function capture(method) {
  const statements = [];
  await migration[method]({ query: async (sql) => statements.push(String(sql)) });
  return statements.join('\n');
}

test('doctor visit migration is the additive next migration 0007', async () => {
  assert.equal(migration.version, '0007');
  assert.equal(migration.name, 'create_doctor_visit_records');
  const sql = await capture('up');
  assert.doesNotMatch(sql, /ALTER TABLE\s+(?:careProfiles|appointments|medications|lab_|consultation_)/i);
});

test('migration creates relational record, guidance and append-only event tables', async () => {
  const sql = await capture('up');
  for (const table of ['doctor_visit_records', 'doctor_visit_guidance_items', 'doctor_visit_events']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.doesNotMatch(sql, /CREATE TABLE[^;]+\bdata\s+JSONB\s+NOT NULL/i);
});

test('draft confirmed void and correction constraints preserve history', async () => {
  const sql = await capture('up');
  assert.match(sql, /status IN \('draft', 'confirmed', 'voided'\)/);
  assert.match(sql, /UNIQUE \(record_group_id, version_no\)/);
  assert.match(sql, /REFERENCES doctor_visit_records\(visit_record_id\) ON DELETE RESTRICT/);
  assert.match(sql, /version_no > 1 AND supersedes_visit_record_id IS NOT NULL/);
  assert.match(sql, /confirmed_by_actor_type IS NOT NULL/);
  assert.match(sql, /NULLIF\(BTRIM\(void_reason\), ''\) IS NOT NULL/);
});

test('guidance schema preserves source support and approved kinds without canonical write links', async () => {
  const sql = await capture('up');
  assert.match(sql, /source_support TEXT NOT NULL/);
  assert.match(sql, /medication_statement/);
  assert.match(sql, /next_appointment/);
  assert.match(sql, /lab_follow_up/);
  assert.match(sql, /UNIQUE \(visit_record_id, source_ordinal\)/);
  assert.doesNotMatch(sql, /REFERENCES (?:medications|appointments|lab_reports)/i);
});

test('required indexes, idempotency and immutability guards are present', async () => {
  const sql = await capture('up');
  for (const name of [
    'idx_doctor_visit_records_profile_status_time', 'idx_doctor_visit_records_appointment',
    'idx_doctor_visit_records_supersedes', 'idx_doctor_visit_guidance_record',
    'idx_doctor_visit_events_record_time', 'idx_doctor_visit_events_idempotency',
  ]) assert.match(sql, new RegExp(name));
  assert.match(sql, /guard_immutable_doctor_visit_record/);
  assert.match(sql, /confirmed doctor visit guidance is immutable/);
  assert.match(sql, /doctor visit events are append-only/);
});

test('migration down removes only the new doctor visit objects', async () => {
  const sql = await capture('down');
  assert.match(sql, /DROP TABLE IF EXISTS doctor_visit_events/);
  assert.match(sql, /DROP TABLE IF EXISTS doctor_visit_guidance_items/);
  assert.match(sql, /DROP TABLE IF EXISTS doctor_visit_records/);
  assert.doesNotMatch(sql, /DROP TABLE IF EXISTS (?:careProfiles|appointments|lab_reports|consultation_)/i);
});
