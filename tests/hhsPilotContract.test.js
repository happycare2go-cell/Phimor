process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeEnvelope } = require('../backend/domain/integrationEvents');
const { publicCodeFor, publicIntegrationError } = require('../backend/domain/integrationErrorContract');
const { createIntegrationEventService } = require('../backend/services/integrationEventService');
const { createIntegrationEventMemoryRepository } = require('./helpers/integrationEventMemoryRepository');
const { buildScenarios, assertLocalTarget, sendScenarios } = require('../backend/scripts/simulate-hhs-pilot');

const identity = { integrationClientId:'INT-PILOT', organizationId:'ORG-PILOT', sourceSystem:'pilot_vendor' };

function serviceFixture({ mapped = true, subjectError = null, canonicalError = null, notification = null } = {}) {
  const repository = createIntegrationEventMemoryRepository(); let sequence = 0;
  const service = createIntegrationEventService({
    repository,
    tenantResolver:{
      async authorizeResolvedIntegrationTarget(input) { return { ...identity, eventType:input.eventType, externalCenterId:input.externalCenterId, centerId:'CTR-PILOT' }; },
      async resolveExternalSubject() {
        if (subjectError) throw subjectError;
        return mapped ? { status:'mapped', residentId:'RES-PILOT', careProfileId:'CP-PILOT' } : { status:'pending_subject_mapping' };
      },
    },
    platformService:{
      async inspectIntegrationClient() { return { ...identity, status:'active' }; },
      async observeExternalSubject() { return { mapping_status:'pending_subject_mapping' }; },
    },
    vitalSignService:{ async recordCanonical() { if (canonicalError) throw canonicalError; return { item:{ vitalSetId:'VSET-PILOT' } }; } },
    dailyCareService:{
      async recordCanonical() { if (canonicalError) throw canonicalError; return { item:{ dailyReportId:'DCR-PILOT' }, notification }; },
      async enqueueFinalizedNotificationByReport() { return notification; },
    },
    idFactory:(prefix) => `${prefix}-${++sequence}`,
    withTransaction:async (_key, work) => work(),
    now:() => new Date('2026-08-27T14:00:00Z'),
  });
  return { service, repository };
}

function scenario(key) { return buildScenarios().find((item) => item.key === key); }

test('HHS-like simulator contains the nine fictional contract scenarios and never includes audio or a real secret', () => {
  const scenarios = buildScenarios();
  assert.deepEqual(scenarios.map((item) => item.key), ['day','duplicate-day','night','pending-subject','group-mismatch','invalid-credential','invalid-center','invalid-payload','standalone-vital']);
  const text = JSON.stringify(scenarios);
  assert.doesNotMatch(text, /audio|base64|transcript|pim_int_[a-f0-9]{16}\./i);
  assert.equal(scenario('day').payload.subject.display.first_name, 'สมใจ');
});

test('valid Day and Night finalized payloads normalize with the locked shift mapping and HHS Vital subset', () => {
  const day = normalizeEnvelope(scenario('day').payload).envelope;
  const night = normalizeEnvelope(scenario('night').payload).envelope;
  assert.deepEqual([day.data.shift.code, day.data.shift.sourceLabel], ['day','D']);
  assert.deepEqual([night.data.shift.code, night.data.shift.sourceLabel], ['night','N']);
  assert.deepEqual(day.data.observations.map((item) => item.measurementType), ['temperature','blood_pressure_systolic','blood_pressure_diastolic','pulse','spo2']);
  assert.equal(day.data.careItems[0].itemType, 'symptom_note');
});

test('same finalized event has the same normalized hash while a conflicting duplicate changes it', () => {
  const first = normalizeEnvelope(scenario('day').payload);
  const duplicate = normalizeEnvelope(scenario('duplicate-day').payload);
  const changed = JSON.parse(JSON.stringify(scenario('duplicate-day').payload)); changed.data.care_items[0].value = 'changed final text';
  assert.equal(first.payloadSha256, duplicate.payloadSha256);
  assert.notEqual(first.payloadSha256, normalizeEnvelope(changed).payloadSha256);
  assert.equal(publicCodeFor({ code:'EVENT_ID_PAYLOAD_CONFLICT' }, { status:409 }), 'EVENT_ID_REUSED');
});

test('unknown Resident remains accepted pending and does not create a canonical record', async () => {
  const fixture = serviceFixture({ mapped:false });
  const result = await fixture.service.ingest({ identity, input:scenario('pending-subject').payload });
  assert.equal(result.status, 'pending_subject_mapping'); assert.equal(result.error, null);
  assert.equal(fixture.repository.state.events[0].canonical_resource_id, null);
});

test('invalid Resident relationship and disabled capability persist safe terminal rejection codes', async () => {
  const invalidResident = serviceFixture({ subjectError:Object.assign(new Error('private resident row'), { code:'CROSS_TENANT_SUBJECT_MAPPING', status:403 }) });
  let result = await invalidResident.service.ingest({ identity, input:scenario('day').payload });
  assert.equal(result.error.code, 'RESIDENT_MAPPING_INVALID');
  assert.equal(invalidResident.repository.state.events[0].last_error_code, 'RESIDENT_MAPPING_INVALID');
  const disabled = serviceFixture({ canonicalError:Object.assign(new Error('private capability row'), { code:'CAPABILITY_DISABLED', status:403 }) });
  result = await disabled.service.ingest({ identity, input:scenario('night').payload });
  assert.equal(result.error.code, 'CAPABILITY_NOT_ENABLED');
  assert.equal(result.error.retryable, false);
  assert.doesNotMatch(JSON.stringify(result), /private|capability row/i);
});

test('group match, mismatch, and missing states preserve canonical care while controlling only notification intent', async () => {
  for (const expected of [
    ['verified_match','queued'], ['group_binding_mismatch','held_group_mismatch'], ['group_binding_missing','held_group_missing'],
  ]) {
    const fixture = serviceFixture({ notification:{ groupReconciliationStatus:expected[0], notificationStatus:expected[1], expectedLineGroupId:'Cfictionalpilotfamilygroup', verifiedLineGroupId:expected[0] === 'verified_match' ? 'Cfictionalpilotfamilygroup' : null } });
    const result = await fixture.service.ingest({ identity, input:scenario('day').payload });
    assert.equal(result.status, 'processed'); assert.equal(result.groupReconciliationStatus, expected[0]); assert.equal(result.notificationIntentStatus, expected[1]);
    assert.equal(fixture.repository.state.events[0].canonical_resource_type, 'daily_care_report');
  }
});

test('standalone Vital remains canonical store-only and has no notification intent', async () => {
  const fixture = serviceFixture();
  const result = await fixture.service.ingest({ identity, input:scenario('standalone-vital').payload });
  assert.equal(result.status, 'processed'); assert.equal(result.canonicalResource.type, 'vital_sign_set');
  assert.equal(result.notificationIntentStatus, 'not_applicable');
});

test('public rejection contract classifies terminal and retryable failures without raw clinical or secret content', () => {
  assert.equal(publicIntegrationError({ code:'EXTERNAL_CENTER_MAPPING_NOT_FOUND', message:'SQL secret 128/76' }, { status:422 }).code, 'CENTER_MAPPING_NOT_FOUND');
  assert.equal(publicIntegrationError({ code:'UNSUPPORTED_UNIT', message:'raw value 128/76' }, { status:400 }).retryable, false);
  assert.equal(publicIntegrationError(new Error('database password and clinical note'), { status:503 }).retryable, true);
  const serialized = JSON.stringify(publicIntegrationError(new Error('Bearer pim_int_private 128/76'), { status:503 }));
  assert.doesNotMatch(serialized, /pim_int|128\/76|database password/i);
});

test('invalid external record identity receives its dedicated safe terminal code', () => {
  const payload = JSON.parse(JSON.stringify(scenario('day').payload)); payload.data.external_record_id = 'invalid external id';
  assert.throws(() => normalizeEnvelope(payload), { code:'INVALID_EXTERNAL_RECORD_ID' });
  assert.equal(publicCodeFor({ code:'INVALID_EXTERNAL_RECORD_ID' }, { status:400 }), 'INVALID_EXTERNAL_RECORD_ID');
});

test('checked-in JSON Schema and mapping contract match supported fields without HHS-specific runtime branching', () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'contracts', 'hhs-pilot-v1-finalized-daily.schema.json'), 'utf8'));
  assert.deepEqual(schema.required, ['schema_version','event_id','event_type','occurred_at','subject','data']);
  assert.equal(schema.properties.event_type.const, 'care.daily_report.finalized');
  assert.equal(schema.properties.data.properties.care_items.minItems, 1);
  const contract = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'HHS_PILOT_V1_CONTRACT.md'), 'utf8');
  assert.match(contract, /D.*Day.*→ `day`/); assert.match(contract, /N.*Night.*→ `night`/);
  assert.match(contract, /final human-reviewed text/); assert.match(contract, /symptom_note/);
  assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname, '..', 'backend', 'services', 'integrationEventService.js'), 'utf8'), /vendor\s*===?\s*['"]hhs|sourceSystem\s*===?\s*['"]hhs/i);
});

test('simulator can only send to loopback, never logs the token, and reports safe metadata', async () => {
  assert.equal(assertLocalTarget('http://127.0.0.1:3000/path'), 'http://127.0.0.1:3000');
  assert.throws(() => assertLocalTarget('https://api.example.test'), /localhost\/loopback/);
  const calls = [];
  const results = await sendScenarios({ baseUrl:'http://localhost:3000', token:'local-test-token-that-is-long-enough', scenarios:[scenario('day')], fetchImpl:async (url, options) => { calls.push({ url, options }); return { status:202, json:async () => ({ status:'processed' }) }; } });
  assert.deepEqual(results, [{ key:'day', httpStatus:202, status:'processed', errorCode:null }]);
  assert.doesNotMatch(JSON.stringify(results), /local-test-token/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer local-test-token-that-is-long-enough');
});
