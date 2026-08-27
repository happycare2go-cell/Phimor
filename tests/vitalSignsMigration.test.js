const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../backend/migrations/0009_create_canonical_vital_signs');

async function sql() {
  const calls = [];
  await migration.up({ query:async (statement) => { calls.push(String(statement)); return { rows:[] }; } });
  return calls.join('\n');
}

test('migration 0009 creates canonical vital set, observation and event tables additively', async () => {
  const source = await sql();
  assert.equal(migration.version, '0009');
  for (const table of ['vital_sign_sets','vital_sign_observations','vital_sign_events']) {
    assert.match(source, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.doesNotMatch(source, /ALTER TABLE (careProfiles|residents|centers)|DROP TABLE (?!IF EXISTS vital_)/i);
});

test('migration binds tenant subject and external provenance without legacy JSONB clinical storage', async () => {
  const source = await sql();
  assert.match(source, /FOREIGN KEY \(center_id, organization_id\)[\s\S]*organization_centers/);
  assert.match(source, /FOREIGN KEY \(integration_client_id, organization_id\)[\s\S]*integration_clients/);
  assert.match(source, /source_type = 'external_integration'[\s\S]*integration_client_id IS NOT NULL[\s\S]*external_record_id IS NOT NULL/);
  assert.match(source, /external_staff_id VARCHAR\(160\)[\s\S]*external_staff_display_name VARCHAR\(160\)/);
  assert.doesNotMatch(source, /image_base64|raw_payload|line_user_id/i);
});

test('migration constrains supported vital types, source order, units and immutable observations', async () => {
  const source = await sql();
  for (const type of ['temperature','blood_pressure_systolic','blood_pressure_diastolic','pulse','spo2','respiratory_rate']) {
    assert.match(source, new RegExp(`'${type}'`));
  }
  assert.match(source, /UNIQUE \(vital_set_id, source_ordinal\)/);
  assert.match(source, /UNIQUE \(vital_set_id, measurement_type\)/);
  assert.match(source, /BEFORE UPDATE OR DELETE ON vital_sign_observations/);
});

test('migration includes bounded history, subject and idempotency indexes', async () => {
  const source = await sql();
  for (const name of ['uq_vital_external_record','idx_vital_care_profile_occurred',
    'idx_vital_center_occurred','idx_vital_resident_occurred','idx_vital_observations_set']) {
    assert.match(source, new RegExp(name));
  }
});

test('vital lifecycle is recorded or voided and events are append-only', async () => {
  const source = await sql();
  assert.match(source, /status IN \('recorded', 'voided'\)/);
  assert.match(source, /status = 'voided'[\s\S]*voided_at IS NOT NULL[\s\S]*void_reason/);
  assert.match(source, /BEFORE UPDATE OR DELETE ON vital_sign_events/);
});
