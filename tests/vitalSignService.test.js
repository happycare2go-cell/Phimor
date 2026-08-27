process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../backend/db');
const { createVitalSignService } = require('../backend/services/vitalSignService');
const { normalizeObservations } = require('../backend/domain/vitalSigns');
const { createVitalSignMemoryRepository } = require('./helpers/vitalSignMemoryRepository');

function fixture({ capability = true, familyNotifications = null } = {}) {
  db.resetAll();
  const repository = createVitalSignMemoryRepository();
  let sequence = 0;
  const platformService = {
    async getOrganizationForCenter(centerId) {
      return centerId === 'CTR-A' ? { organizationId:'ORG-A', status:'active' }
        : centerId === 'CTR-B' ? { organizationId:'ORG-B', status:'active' } : null;
    },
    async isCenterCapabilityEnabled(centerId, key) {
      return capability && centerId === 'CTR-A' && key === 'vital_signs_v1';
    },
    async inspectIntegrationClient(clientId) {
      return clientId === 'INT-A'
        ? { integrationClientId:clientId, organizationId:'ORG-A', status:'active', centers:[{ center_id:'CTR-A' }] }
        : { integrationClientId:clientId, organizationId:'ORG-B', status:'revoked', centers:[] };
    },
  };
  const service = createVitalSignService({ repository, platformService,
    familyCareNotificationService:familyNotifications || { async enqueueRecorded() { return {ok:false,reason:'no_test_recipient'}; } },
    idFactory:(prefix) => `${prefix}-${++sequence}`,
    withTransaction:async (_key, fn) => fn(),
    authorizeCareProfileAccess:async ({ lineUserId, careProfileId }) => {
      if (lineUserId !== 'U-OWNER' || careProfileId !== 'CP-A') throw Object.assign(new Error('denied'), { code:'FORBIDDEN', status:403 });
      return { actorType:'family_owner' };
    },
  });
  return { service, repository };
}

async function seed() {
  await db.Centers.insert({ center_id:'CTR-A', name:'ศูนย์ A', status:'active' });
  await db.Centers.insert({ center_id:'CTR-B', status:'active' });
  await db.CenterStaff.insert({ staff_id:'STF-A', center_id:'CTR-A', line_user_id:'U-STAFF', display_name:'ผู้ดูแลเอ', role:'staff', status:'active' });
  await db.CenterStaff.insert({ staff_id:'STF-M', center_id:'CTR-A', line_user_id:'U-MANAGER', role:'manager', status:'active' });
  await db.Residents.insert({ resident_id:'RES-A', center_id:'CTR-A', care_profile_id:'CP-A', full_name:'คุณยายเอ', room:'A-1', status:'active' });
  await db.Residents.insert({ resident_id:'RES-B', center_id:'CTR-B', care_profile_id:'CP-B', status:'active' });
}

const observations = [
  { measurementType:'temperature', numericValue:36.7, sourceValueText:'36.7', sourceUnit:'°C' },
  { measurementType:'pulse', numericValue:72, sourceUnit:'bpm' },
];

test('normalization accepts the controlled generic registry and deterministic unit/context rules', () => {
  const normalized = normalizeObservations(observations);
  assert.deepEqual(normalized.map((item) => [item.measurementType,item.canonicalUnit]), [['temperature','Cel'],['pulse','/min']]);
  assert.deepEqual(normalizeObservations([{ measurementType:'weight', numericValue:60, sourceUnit:'kg' }])[0], {
    sourceOrdinal:1,measurementType:'weight',sourceValueText:'60',numericValue:60,
    sourceUnit:'kg',canonicalUnit:'kg',measurementContext:null,
  });
  assert.equal(normalizeObservations([{ measurementType:'blood_glucose', numericValue:108, sourceUnit:'mg/dL', context:'fasting' }])[0].measurementContext,'fasting');
  assert.equal(normalizeObservations([{ measurementType:'blood_glucose', numericValue:6, sourceUnit:'mmol/L' }])[0].canonicalUnit,'mmol/L');
  assert.throws(() => normalizeObservations([{ measurementType:'blood_glucose', numericValue:108, sourceUnit:'mg/dL', context:'bedtime' }]), { code:'INVALID_GLUCOSE_CONTEXT' });
  assert.throws(() => normalizeObservations([{ measurementType:'vendor_custom', numericValue:1, sourceUnit:'x' }]), { code:'UNSUPPORTED_MEASUREMENT' });
  assert.throws(() => normalizeObservations([{ measurementType:'spo2', numericValue:98, sourceUnit:'bpm' }]), { code:'UNSUPPORTED_UNIT' });
  assert.throws(() => normalizeObservations([{ measurementType:'pulse', numericValue:70, sourceUnit:'bpm' },{ measurementType:'pulse', numericValue:71, sourceUnit:'bpm' }]), { code:'DUPLICATE_MEASUREMENT' });
});

test('authorized Center staff records through canonical service with minimized staff reference', async () => {
  const { service, repository } = fixture(); await seed();
  const result = await service.recordNative({ lineUserId:'U-STAFF', centerId:'CTR-A', residentId:'RES-A', occurredAt:'2026-08-27T08:00:00+07:00', observations });
  assert.equal(result.duplicate, false); assert.equal(result.item.status, 'recorded');
  assert.equal(result.item.observations[0].numericValue, 36.7);
  assert.equal(repository.state.sets[0].recorded_by_actor_reference, 'center_staff:STF-A');
  assert.doesNotMatch(JSON.stringify(result), /U-STAFF|organization_id|resident_id|care_profile_id/i);
  assert.deepEqual(repository.state.events[0].metadata.measurementTypes, ['temperature','pulse']);
});

test('native recording rejects wrong Center subject, inactive staff and disabled capability', async () => {
  const f = fixture(); await seed();
  await assert.rejects(f.service.recordNative({ lineUserId:'U-STAFF', centerId:'CTR-A', residentId:'RES-B', occurredAt:'2026-08-27T01:00:00Z', observations }), { code:'RESIDENT_NOT_READY' });
  await db.CenterStaff.update((row) => row.staff_id === 'STF-A', { status:'revoked' });
  await assert.rejects(f.service.recordNative({ lineUserId:'U-STAFF', centerId:'CTR-A', residentId:'RES-A', occurredAt:'2026-08-27T01:00:00Z', observations }), { code:'CENTER_ACCESS_DENIED' });
  const disabled = fixture({ capability:false }); await seed();
  await assert.rejects(disabled.service.recordNative({ lineUserId:'U-STAFF', centerId:'CTR-A', residentId:'RES-A', occurredAt:'2026-08-27T01:00:00Z', observations }), { code:'CAPABILITY_DISABLED' });
});

test('external canonical record requires matching active client tenant and Center scope', async () => {
  const { service } = fixture(); await seed();
  const input = { tenant:{organizationId:'ORG-A'}, subject:{centerId:'CTR-A',residentId:'RES-A',careProfileId:'CP-A'},
    occurredAt:'2026-08-27T01:00:00Z', observations,
    provenance:{sourceType:'external_integration',sourceSystem:'trusted',integrationClientId:'INT-A',externalRecordId:'EXT-1',actorReference:'integration_client:INT-A'} };
  assert.equal((await service.recordCanonical(input)).item.sourceType, 'external_integration');
  await assert.rejects(service.recordCanonical({ ...input, provenance:{...input.provenance,integrationClientId:'INT-B',externalRecordId:'EXT-2'} }), { code:'INTEGRATION_TENANT_MISMATCH' });
  await assert.rejects(service.recordCanonical({ ...input, tenant:{organizationId:'ORG-B'} }), { code:'TENANT_MISMATCH' });
});

test('external record ID is idempotent and cannot create a second canonical set', async () => {
  const { service, repository } = fixture(); await seed();
  const input = { tenant:{organizationId:'ORG-A'}, subject:{centerId:'CTR-A',residentId:'RES-A',careProfileId:'CP-A'},
    occurredAt:'2026-08-27T01:00:00Z', observations,
    provenance:{sourceType:'external_integration',sourceSystem:'trusted',integrationClientId:'INT-A',externalRecordId:'EXT-1',actorReference:'integration_client:INT-A'} };
  const first = await service.recordCanonical(input); const second = await service.recordCanonical(input);
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true);
  assert.equal(first.item.vitalSetId, second.item.vitalSetId); assert.equal(repository.state.sets.length, 1);
});

test('native and external standalone Vital writes are stored without automatic Family push', async () => {
  const calls=[]; const {service}=fixture({familyNotifications:{async enqueueRecorded(input){calls.push(input);return{ok:true};}}}); await seed();
  await service.recordNative({lineUserId:'U-STAFF',centerId:'CTR-A',residentId:'RES-A',occurredAt:'2026-08-27T01:00:00Z',observations});
  await service.recordCanonical({tenant:{organizationId:'ORG-A'},subject:{centerId:'CTR-A',residentId:'RES-A',careProfileId:'CP-A'},occurredAt:'2026-08-27T02:00:00Z',observations,
    provenance:{sourceType:'external_integration',sourceSystem:'trusted',integrationClientId:'INT-A',externalRecordId:'EXT-NOTIFY',
      externalStaffDisplayName:'ผู้ดูแลภายนอก',actorReference:'integration_client:INT-A'}});
  assert.equal(calls.length,0);
});

test('standalone Vital notification cannot be enabled through a legacy suppression flag', async () => {
  const calls=[]; const {service}=fixture({familyNotifications:{async enqueueRecorded(input){calls.push(input);return{ok:true};}}}); await seed();
  await service.recordCanonical({tenant:{organizationId:'ORG-A'},subject:{centerId:'CTR-A',residentId:'RES-A',careProfileId:'CP-A'},occurredAt:'2026-08-27T02:00:00Z',observations,
    provenance:{sourceType:'external_integration',sourceSystem:'trusted',integrationClientId:'INT-A',externalRecordId:'EXT-NESTED',actorReference:'integration_client:INT-A'},suppressFamilyNotification:true});
  assert.equal(calls.length,0);
});

test('history is authorized, bounded, ordered, paginated and excludes voided rows', async () => {
  const { service } = fixture(); await seed();
  for (let day = 1; day <= 3; day += 1) await service.recordNative({ lineUserId:'U-STAFF', centerId:'CTR-A', residentId:'RES-A', occurredAt:`2026-08-0${day}T01:00:00Z`, observations });
  const first = await service.listHistory({ lineUserId:'U-OWNER', careProfileId:'CP-A', limit:2 });
  assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  const second = await service.listHistory({ lineUserId:'U-OWNER', careProfileId:'CP-A', limit:2, cursor:first.nextCursor });
  assert.equal(second.items.length, 1); assert.notEqual(first.items[0].vitalSetId, second.items[0].vitalSetId);
  await assert.rejects(service.listHistory({ lineUserId:'U-OTHER', careProfileId:'CP-A' }), { code:'FORBIDDEN' });
  await assert.rejects(service.listHistory({ lineUserId:'U-OWNER', careProfileId:'CP-A', from:'2020-01-01T00:00:00Z', to:'2026-01-01T00:00:00Z' }), { code:'DATE_RANGE_TOO_LARGE' });
});

test('manager can explicitly void without deleting observations and void is idempotent', async () => {
  const { service, repository } = fixture(); await seed();
  const created = await service.recordNative({ lineUserId:'U-STAFF', centerId:'CTR-A', residentId:'RES-A', occurredAt:'2026-08-27T01:00:00Z', observations });
  const once = await service.voidVitalSet({ lineUserId:'U-MANAGER', centerId:'CTR-A', vitalSetId:created.item.vitalSetId, reason:'บันทึกผิดคน' });
  const twice = await service.voidVitalSet({ lineUserId:'U-MANAGER', centerId:'CTR-A', vitalSetId:created.item.vitalSetId, reason:'ซ้ำ' });
  assert.equal(once.status, 'voided'); assert.equal(twice.status, 'voided');
  assert.equal(repository.state.observations.length, 2);
  assert.equal(repository.state.events.filter((row) => row.event_type === 'voided').length, 1);
  assert.equal((await service.listHistory({ lineUserId:'U-OWNER', careProfileId:'CP-A' })).items.length, 0);
  await assert.rejects(service.voidVitalSet({ lineUserId:'U-STAFF', centerId:'CTR-A', vitalSetId:created.item.vitalSetId, reason:'x' }), { code:'CENTER_ACCESS_DENIED' });
});
