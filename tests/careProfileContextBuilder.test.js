const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';

const db = require('../backend/db');
const {
  PURPOSE_PERMISSION_MAP, buildCareProfileContext,
} = require('../backend/services/careProfileContextBuilder');

const NOW = '2026-08-24T10:00:00.000Z';

test.beforeEach(() => db.resetAll());

async function seedProfile(overrides = {}) {
  return db.CareProfiles.insert({
    care_profile_id: 'CP-1', owner_line_id: 'U-OWNER', patient_name: 'คุณแม่สมใจ', status: 'independent',
    gender: 'female', blood_type: 'A', height_cm: 160, weight_kg: 55,
    chronic_conditions: ['เบาหวาน', 'ความดันโลหิตสูง'], drug_allergies: 'Penicillin', food_allergies: 'กุ้ง',
    mobility_limitations: 'ใช้ไม้เท้า', emergency_contact_name: 'ลูกสาว', emergency_contact_phone: '0899999999',
    family_phone: '0811111111', line_token: 'secret-line-token', raw_document_image: 'private-image',
    ...overrides,
  });
}

async function seedClinicalData(careProfileId = 'CP-1') {
  await db.MedicationSnapshots.insert({
    snapshot_id: 'SNAP-OLD', care_profile_id: careProfileId, recorded_at: '2026-08-01T00:00:00.000Z',
    items: [{ name: 'Old medicine', dose: 'old' }], source_image_base64: 'old-private-image',
  });
  await db.MedicationSnapshots.insert({
    snapshot_id: 'SNAP-NEW', care_profile_id: careProfileId, recorded_at: '2026-08-20T00:00:00.000Z', source: 'family_manual',
    items: [{ name: 'Metformin', dose: '500 mg หลังอาหาร', condition: 'เบาหวาน', imageBase64: 'nested-private-image' }],
    source_image_base64: 'new-private-image', recorded_by: 'U-SECRET',
  });
  await db.Medications.insert({ medication_id: 'MED-1', care_profile_id: careProfileId, name: 'Historical drug', dose: 'old', created_by: 'U-SECRET' });
  await db.Appointments.insert({ appointment_id: 'APT-UP', care_profile_id: careProfileId, hospital: 'รพ.กลาง', datetime: '2099-01-10T09:00:00.000Z', status: 'confirmed', doctor_name: 'นพ.ดี', related_condition: 'เบาหวาน', note: 'นำรายการยาไปด้วย', created_by: 'U-SECRET' });
  await db.Appointments.insert({ appointment_id: 'APT-CANCEL', care_profile_id: careProfileId, hospital: 'รพ.ยกเลิก', datetime: '2099-01-11T09:00:00.000Z', status: 'cancelled' });
  await db.Appointments.insert({ appointment_id: 'APT-PAST', care_profile_id: careProfileId, hospital: 'รพ.อดีต', datetime: '2020-01-01T09:00:00.000Z', status: 'confirmed' });
}

test('all current read-only context purposes map to existing view permission', () => {
  assert.deepEqual(PURPOSE_PERMISSION_MAP, {
    care_profile_summary: 'view', medication_summary: 'view', appointment_summary: 'view', doctor_visit_preparation: 'view',
  });
});

test('owner may build a minimized Care Profile summary', async () => {
  await seedProfile();
  const result = await buildCareProfileContext({ careProfileId: 'CP-1', requester: { lineUserId: 'U-OWNER' }, purpose: 'care_profile_summary', options: { now: NOW } });
  assert.equal(result.context.profile.patientName, 'คุณแม่สมใจ');
  assert.deepEqual(result.context.profile.chronicConditions, ['เบาหวาน', 'ความดันโลหิตสูง']);
  assert.equal(result.generatedAt, NOW);
  assert.equal(result.dataVersion.contextSchema, 'care-profile-context-v1');
});

test('active caregiver with view permission may build summary', async () => {
  await seedProfile();
  await db.CareProfileMembers.insert({ member_id: 'M-1', care_profile_id: 'CP-1', line_user_id: 'U-CARE', status: 'active', role: 'caregiver', permissions: ['view'] });
  const result = await buildCareProfileContext({ careProfileId: 'CP-1', requester: { lineUserId: 'U-CARE' }, purpose: 'medication_summary', options: { now: NOW } });
  assert.equal(result.purpose, 'medication_summary');
});

test('revoked caregiver is denied before context is returned', async () => {
  await seedProfile();
  await db.CareProfileMembers.insert({ member_id: 'M-1', care_profile_id: 'CP-1', line_user_id: 'U-CARE', status: 'revoked', permissions: ['view'] });
  await assert.rejects(buildCareProfileContext({
    careProfileId: 'CP-1', requester: { lineUserId: 'U-CARE' }, purpose: 'care_profile_summary', options: { now: NOW },
  }), (error) => error.code === 'MEMBERSHIP_REVOKED');
});

test('caregiver membership cannot cross to another profile', async () => {
  await seedProfile();
  await seedProfile({ care_profile_id: 'CP-2', owner_line_id: 'U-OTHER' });
  await db.CareProfileMembers.insert({ member_id: 'M-2', care_profile_id: 'CP-2', line_user_id: 'U-CARE', status: 'active', permissions: ['view'] });
  await assert.rejects(buildCareProfileContext({
    careProfileId: 'CP-1', requester: { lineUserId: 'U-CARE' }, purpose: 'care_profile_summary', options: { now: NOW },
  }), (error) => error.code === 'ACCESS_DENIED');
});

test('medication context uses current snapshot and excludes documents/images', async () => {
  await seedProfile();
  await seedClinicalData();
  const result = await buildCareProfileContext({ careProfileId: 'CP-1', requester: { lineUserId: 'U-OWNER' }, purpose: 'medication_summary', options: { now: NOW } });
  assert.equal(result.context.currentSnapshot.snapshotId, 'SNAP-NEW');
  assert.deepEqual(result.context.medications, [{ name: 'Metformin', dose: '500 mg หลังอาหาร', condition: 'เบาหวาน', note: '', instruction: '' }]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private-image|source_image_base64|imageBase64|raw_document/);
});

test('appointment context contains only active upcoming appointments', async () => {
  await seedProfile();
  await seedClinicalData();
  const result = await buildCareProfileContext({ careProfileId: 'CP-1', requester: { lineUserId: 'U-OWNER' }, purpose: 'appointment_summary', options: { now: NOW } });
  assert.deepEqual(result.context.upcomingAppointments.map((item) => item.appointmentId), ['APT-UP']);
});

test('doctor visit preparation includes selected appointment, current medicines, allergies and relevant conditions only', async () => {
  await seedProfile();
  await seedClinicalData();
  const result = await buildCareProfileContext({
    careProfileId: 'CP-1', requester: { lineUserId: 'U-OWNER' }, purpose: 'doctor_visit_preparation',
    options: { now: NOW, appointmentId: 'APT-UP' },
  });
  assert.equal(result.context.appointment.appointmentId, 'APT-UP');
  assert.equal(result.context.medications[0].name, 'Metformin');
  assert.equal(result.context.allergies.drug, 'Penicillin');
  assert.deepEqual(result.context.relevantConditions, ['เบาหวาน']);
  assert.equal(Object.hasOwn(result.context, 'profile'), false);
});

test('doctor preparation rejects a non-selected, cancelled or inaccessible appointment', async () => {
  await seedProfile();
  await seedClinicalData();
  await assert.rejects(buildCareProfileContext({
    careProfileId: 'CP-1', requester: { lineUserId: 'U-OWNER' }, purpose: 'doctor_visit_preparation',
    options: { now: NOW, appointmentId: 'APT-CANCEL' },
  }), (error) => error.code === 'APPOINTMENT_NOT_FOUND');
});

test('all envelopes exclude LINE credentials, owners, family contacts and emergency contacts', async () => {
  await seedProfile();
  await seedClinicalData();
  for (const [purpose, extra] of [
    ['care_profile_summary', {}], ['medication_summary', {}], ['appointment_summary', {}],
    ['doctor_visit_preparation', { appointmentId: 'APT-UP' }],
  ]) {
    const result = await buildCareProfileContext({ careProfileId: 'CP-1', requester: { lineUserId: 'U-OWNER' }, purpose, options: { now: NOW, ...extra } });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /secret-line-token|U-OWNER|U-SECRET|0899999999|0811111111|ลูกสาว/);
    assert.doesNotMatch(serialized, /owner_line_id|family_phone|emergency_contact|line_token|created_by|recorded_by/);
  }
});

test('unsupported purpose denies before protected context is built', async () => {
  await seedProfile();
  await assert.rejects(buildCareProfileContext({
    careProfileId: 'CP-1', requester: { lineUserId: 'U-OWNER' }, purpose: 'raw_documents', options: { now: NOW },
  }), (error) => error.code === 'UNSUPPORTED_PURPOSE');
});
