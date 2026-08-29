process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEnvelope } = require('../backend/domain/integrationEvents');
const { normalizeObservations } = require('../backend/domain/vitalSigns');
const { normalizeItems } = require('../backend/domain/dailyCare');
const { createIntegrationEventService } = require('../backend/services/integrationEventService');
const { createIntegrationEventMemoryRepository } = require('./helpers/integrationEventMemoryRepository');

const identity = {
  integrationClientId:'INT-HHS', organizationId:'ORG-HHS', sourceSystem:'hhs',
};

function hhsPayload({
  eventId = 'hhs-health-record-123',
  externalRecordId = 'HHS_HEALTH_RECORD_123',
  shiftCode = 'day',
  shiftLabel = 'Day',
  observations,
} = {}) {
  return {
    schema_version:'1.0',
    event_id:eventId,
    event_type:'care.daily_report.finalized',
    occurred_at:'2026-08-27T20:05:00+07:00',
    subject:{
      center_external_id:'HHS_BRANCH_1',
      resident_external_id:'HHS_RESIDENT_10025',
      expected_line_group_id:'Cfictionalpilotfamilygroup',
      display:{ first_name:'สมใจ', last_name:'ใจดี', room:'A-201' },
    },
    data:{
      external_record_id:externalRecordId,
      care_date:'2026-08-27',
      shift:{ code:shiftCode, source_label:shiftLabel },
      observations:observations === undefined ? [
        { type:'temperature', value:36.6, unit:'Cel' },
        { type:'blood_pressure_systolic', value:128, unit:'mm[Hg]' },
        { type:'blood_pressure_diastolic', value:76, unit:'mm[Hg]' },
        { type:'pulse', value:72, unit:'/min' },
        { type:'spo2', value:97, unit:'%' },
      ] : observations,
      care_items:[{
        item_type:'symptom_note', value_type:'text',
        value:'ข้อความสรุปที่ผู้จัดการตรวจสอบและยืนยันแล้ว',
      }],
      recorded_by:'STAFF_123',
      finalized_by:'MANAGER_456',
      recorded_at:'2026-08-27T19:55:00+07:00',
      finalized_at:'2026-08-27T20:05:00+07:00',
    },
  };
}

function serviceFixture({ dailyImpl } = {}) {
  const repository = createIntegrationEventMemoryRepository();
  let sequence = 0;
  const service = createIntegrationEventService({
    repository,
    tenantResolver:{
      async authorizeResolvedIntegrationTarget({ eventType, externalCenterId }) {
        return { ...identity, eventType, externalCenterId, centerId:'CTR-HHS' };
      },
      async resolveExternalSubject() {
        return { status:'mapped', residentId:'RES-PHIMOR', careProfileId:'CP-PHIMOR' };
      },
    },
    platformService:{
      async inspectIntegrationClient() { return { ...identity, status:'active' }; },
      async observeExternalSubject() { assert.fail('mapped subject must not be observed as pending'); },
    },
    vitalSignService:{ async recordCanonical() { return { item:{ vitalSetId:'VSET-HHS' } }; } },
    dailyCareService:{
      async recordCanonical(input) {
        return dailyImpl ? dailyImpl(input) : {
          item:{ dailyReportId:'DCR-HHS' },
          notification:{ notificationStatus:'queued', groupReconciliationStatus:'verified_match' },
        };
      },
      async enqueueFinalizedNotificationByReport() {
        return { notificationStatus:'queued', groupReconciliationStatus:'verified_match' };
      },
    },
    idFactory:(prefix) => `${prefix}-${++sequence}`,
    withTransaction:async (_key, work) => work(),
  });
  return { service, repository };
}

test('exact approved HHS payload accepts scalar actors, Day label, and all five exact Vital units', () => {
  const normalized = normalizeEnvelope(hhsPayload()).envelope;
  assert.deepEqual(normalized.data.recordedBy, { externalStaffId:'STAFF_123', displayName:null });
  assert.deepEqual(normalized.data.finalizedBy, { externalStaffId:'MANAGER_456', displayName:null });
  assert.deepEqual(normalized.data.shift, { code:'day', sourceLabel:'Day' });
  assert.deepEqual(normalized.data.observations.map((item) => [item.measurementType, item.sourceUnit]), [
    ['temperature','Cel'],
    ['blood_pressure_systolic','mm[Hg]'],
    ['blood_pressure_diastolic','mm[Hg]'],
    ['pulse','/min'],
    ['spo2','%'],
  ]);
  assert.equal(normalizeObservations(normalized.data.observations).length, 5);
  assert.deepEqual(normalizeItems(normalized.data.careItems).map((item) => item.itemType), ['symptom_note']);
  assert.doesNotMatch(JSON.stringify(normalized), /audio|stt|ai.?draft/i);
});

test('Night source label and existing strict object actor form remain compatible', () => {
  const input = hhsPayload({ eventId:'hhs-health-record-124', externalRecordId:'HHS_HEALTH_RECORD_124',
    shiftCode:'night', shiftLabel:'Night' });
  input.data.recorded_by = { external_staff_id:'STAFF_124', display_name:'ผู้ดูแลทดสอบ' };
  input.data.finalized_by = { external_staff_id:'MANAGER_457', display_name:'ผู้จัดการทดสอบ' };
  const normalized = normalizeEnvelope(input).envelope;
  assert.deepEqual(normalized.data.shift, { code:'night', sourceLabel:'Night' });
  assert.deepEqual(normalized.data.recordedBy,
    { externalStaffId:'STAFF_124', displayName:'ผู้ดูแลทดสอบ' });
  assert.deepEqual(normalized.data.finalizedBy,
    { externalStaffId:'MANAGER_457', displayName:'ผู้จัดการทดสอบ' });
});

test('scalar actor references remain nonblank, bounded, and identifier-safe', () => {
  for (const invalid of ['', '   ', 'STAFF 123', `STAFF_${'x'.repeat(160)}`]) {
    const input = hhsPayload(); input.data.recorded_by = invalid;
    assert.throws(() => normalizeEnvelope(input), { code:'INVALID_EVENT_RECORDER' });
  }
  const missing = hhsPayload(); delete missing.data.finalized_by;
  assert.throws(() => normalizeEnvelope(missing), { code:'INVALID_EVENT_FINALIZER' });
});

test('HHS sparse observations support one, some, or none while explicit null is rejected', () => {
  const variants = [
    [{ type:'temperature', value:36.5, unit:'Cel' }],
    [
      { type:'blood_pressure_systolic', value:120, unit:'mm[Hg]' },
      { type:'blood_pressure_diastolic', value:75, unit:'mm[Hg]' },
      { type:'spo2', value:98, unit:'%' },
    ],
    [],
  ];
  for (const observations of variants) {
    const normalized = normalizeEnvelope(hhsPayload({ observations })).envelope;
    assert.equal(normalized.data.observations.length, observations.length);
    assert.equal(normalizeItems(normalized.data.careItems)[0].itemType, 'symptom_note');
    if (observations.length) assert.equal(normalizeObservations(normalized.data.observations).length, observations.length);
  }
  const explicitNull = hhsPayload({ observations:[{ type:'temperature', value:null, unit:'Cel' }] });
  assert.throws(() => normalizeEnvelope(explicitNull), { code:'INVALID_EVENT_OBSERVATION' });
  const malformed = normalizeEnvelope(hhsPayload({
    observations:[{ type:'temperature', value:36.5, unit:'fahrenheit' }],
  })).envelope;
  assert.throws(() => normalizeObservations(malformed.data.observations), { code:'UNSUPPORTED_UNIT' });
});

test('HHS clinical data remains a typed care_items array and disallowed source fields fail closed', () => {
  const keyed = hhsPayload(); keyed.data.care_items = { symptom_note:'not a typed array' };
  assert.throws(() => normalizeEnvelope(keyed), { code:'EVENT_DAILY_ITEMS_REQUIRED' });
  for (const field of ['stt_transcript','audio_storage_path','ai_draft']) {
    const input = hhsPayload(); input.data[field] = 'must-not-pass';
    assert.throws(() => normalizeEnvelope(input), { code:'INVALID_EVENT_DATA' });
  }
});

test('HHS scalar finalizer reference reaches canonical Daily provenance without entering response projection', async () => {
  let canonicalInput;
  const fixture = serviceFixture({ dailyImpl:async (input) => {
    canonicalInput = input;
    return { item:{ dailyReportId:'DCR-HHS' },
      notification:{ notificationStatus:'queued', groupReconciliationStatus:'verified_match' } };
  } });
  const result = await fixture.service.ingest({ identity, input:hhsPayload() });
  assert.equal(canonicalInput.provenance.externalStaffId, 'STAFF_123');
  assert.equal(canonicalInput.provenance.externalFinalizerReference, 'MANAGER_456');
  assert.equal(canonicalInput.provenance.integrationClientId, 'INT-HHS');
  assert.equal(canonicalInput.provenance.externalRecordId, 'HHS_HEALTH_RECORD_123');
  assert.equal(canonicalInput.provenance.sourceRecordedAt, '2026-08-27T12:55:00.000Z');
  assert.equal(canonicalInput.provenance.finalizedAt, '2026-08-27T13:05:00.000Z');
  assert.doesNotMatch(JSON.stringify(result), /STAFF_123|MANAGER_456|HHS_HEALTH_RECORD_123/);
});

test('same HHS event converges under concurrent delivery and changed payload remains a conflict', async () => {
  let canonicalWrites = 0;
  const fixture = serviceFixture({ dailyImpl:async () => {
    canonicalWrites += 1;
    return { item:{ dailyReportId:'DCR-HHS' }, notification:null };
  } });
  const [first, second] = await Promise.all([
    fixture.service.ingest({ identity, input:hhsPayload() }),
    fixture.service.ingest({ identity, input:hhsPayload() }),
  ]);
  assert.equal(fixture.repository.state.events.length, 1);
  assert.equal(canonicalWrites, 1);
  assert.equal([first, second].filter((item) => item.duplicate).length, 1);
  const changed = hhsPayload(); changed.data.care_items[0].value = 'changed reviewed text';
  await assert.rejects(fixture.service.ingest({ identity, input:changed }),
    { code:'EVENT_ID_PAYLOAD_CONFLICT', status:409 });
});

test('different event IDs with one external record converge to one canonical Daily and linked Vital identity', async () => {
  const canonicalByExternalRecord = new Map(); let canonicalWrites = 0; let linkedVitalWrites = 0;
  const fixture = serviceFixture({ dailyImpl:async (input) => {
    const existing = canonicalByExternalRecord.get(input.provenance.externalRecordId);
    if (existing) return { duplicate:true, item:existing,
      notification:{ duplicate:true, notificationStatus:'duplicate', groupReconciliationStatus:'verified_match' } };
    canonicalWrites += 1; linkedVitalWrites += input.vitalSigns ? 1 : 0;
    const item = { dailyReportId:'DCR-HHS-CANONICAL' };
    canonicalByExternalRecord.set(input.provenance.externalRecordId, item);
    return { duplicate:false, item,
      notification:{ notificationStatus:'queued', groupReconciliationStatus:'verified_match' } };
  } });
  const first = hhsPayload();
  const replayAsNewEvent = hhsPayload({ eventId:'hhs-health-record-123-republished' });
  const firstResult = await fixture.service.ingest({ identity, input:first });
  const secondResult = await fixture.service.ingest({ identity, input:replayAsNewEvent });
  assert.equal(canonicalWrites, 1);
  assert.equal(linkedVitalWrites, 1);
  assert.equal(firstResult.canonicalResource.id, secondResult.canonicalResource.id);
  assert.equal(fixture.repository.state.events.length, 2);
});
