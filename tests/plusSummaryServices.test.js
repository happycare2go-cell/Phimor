const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';

const db = require('../backend/db');
const { buildCareProfileSummary } = require('../backend/services/careProfileSummaryService');
const { getUpcomingAppointmentSummary } = require('../backend/services/appointmentSummaryService');
const { buildDoctorVisitPreparation } = require('../backend/services/doctorVisitPreparationService');

const NOW = '2026-08-25T00:00:00.000Z';
const owner = { lineUserId: 'U-OWNER' };

test.beforeEach(() => db.resetAll());

async function seedProfile(overrides = {}) {
  return db.CareProfiles.insert({
    care_profile_id: 'CP-1', owner_line_id: 'U-OWNER', patient_name: 'คุณสมใจ', status: 'independent',
    gender: 'female', blood_type: 'A', height_cm: 160, weight_kg: 55,
    chronic_conditions: ['เบาหวาน'], drug_allergies: 'Penicillin', food_allergies: 'กุ้ง',
    mobility_limitations: 'ใช้ไม้เท้า', emergency_contact_phone: '0899999999',
    family_phone: '0811111111', line_user_id: 'U-PRIVATE', raw_document: 'private', ...overrides,
  });
}

async function seedSnapshot(id, recordedAt, items, overrides = {}) {
  return db.MedicationSnapshots.insert({
    snapshot_id: id, care_profile_id: 'CP-1', recorded_at: recordedAt, source: 'family_manual',
    items, source_image_base64: 'private-image', recorded_by: 'U-PRIVATE', ...overrides,
  });
}

async function seedAppointment(id, datetime, overrides = {}) {
  return db.Appointments.insert({
    appointment_id: id, care_profile_id: 'CP-1', datetime, status: 'confirmed',
    hospital: 'โรงพยาบาลกลาง', clinic_or_department: 'อายุรกรรม', reason_for_visit: 'ติดตามอาการ',
    note: 'นำรายการยา', created_by: 'U-PRIVATE', ...overrides,
  });
}

test('Care Profile summary is deterministic and owner is allowed', async () => {
  await seedProfile();
  await seedSnapshot('S-1', '2026-08-20T00:00:00Z', [{ name: 'Metformin', dose: '500 mg' }]);
  await seedAppointment('A-1', '2026-09-01T09:30:00Z');
  const result = await buildCareProfileSummary({ careProfileId: 'CP-1', requester: owner, now: NOW });
  assert.equal(result.profile.patientName, 'คุณสมใจ');
  assert.deepEqual(result.conditions, ['เบาหวาน']);
  assert.equal(result.currentMedicationStatus, 'AVAILABLE');
  assert.equal(result.currentMedicationCount, 1);
  assert.equal(result.upcomingAppointmentCount, 1);
});

test('active caregiver with view may read summary; revoked caregiver is denied', async () => {
  await seedProfile();
  await db.CareProfileMembers.insert({ member_id: 'M-1', care_profile_id: 'CP-1', line_user_id: 'U-CARE', status: 'active', permissions: ['view'] });
  const result = await buildCareProfileSummary({ careProfileId: 'CP-1', requester: { lineUserId: 'U-CARE' }, now: NOW });
  assert.equal(result.profile.patientName, 'คุณสมใจ');
  await db.CareProfileMembers.update((item) => item.member_id === 'M-1', { status: 'revoked' });
  await assert.rejects(
    buildCareProfileSummary({ careProfileId: 'CP-1', requester: { lineUserId: 'U-CARE' }, now: NOW }),
    (error) => error.code === 'MEMBERSHIP_REVOKED',
  );
});

test('appointment summary returns future active appointments sorted and excludes terminal statuses', async () => {
  await seedProfile();
  await seedAppointment('A-LATE', '2026-09-03T09:00:00Z');
  await seedAppointment('A-EARLY', '2026-09-01T09:00:00Z');
  await seedAppointment('A-CANCEL', '2026-09-02T09:00:00Z', { status: 'cancelled' });
  await seedAppointment('A-DONE', '2026-09-02T10:00:00Z', { status: 'completed' });
  await seedAppointment('A-PAST', '2020-09-02T10:00:00Z');
  const result = await getUpcomingAppointmentSummary({ careProfileId: 'CP-1', requester: owner, now: NOW });
  assert.deepEqual(result.map((item) => item.appointmentId), ['A-EARLY', 'A-LATE']);
});

test('appointment limit is applied safely and output only contains approved fields', async () => {
  await seedProfile();
  await seedAppointment('A-1', '2026-09-01T09:00:00Z');
  await seedAppointment('A-2', '2026-09-02T09:00:00Z');
  const result = await getUpcomingAppointmentSummary({ careProfileId: 'CP-1', requester: owner, limit: 1, now: NOW });
  assert.equal(result.length, 1);
  assert.deepEqual(Object.keys(result[0]), ['appointmentId', 'hospital', 'department', 'datetime', 'date', 'time', 'reason', 'notes', 'status']);
  assert.equal(JSON.stringify(result).includes('U-PRIVATE'), false);
});

test('appointment from another Care Profile is not exposed', async () => {
  await seedProfile();
  await seedAppointment('A-OTHER', '2026-09-01T09:00:00Z', { care_profile_id: 'CP-2' });
  const result = await getUpcomingAppointmentSummary({ careProfileId: 'CP-1', requester: owner, now: NOW });
  assert.deepEqual(result, []);
  await assert.rejects(
    buildDoctorVisitPreparation({ careProfileId: 'CP-1', appointmentId: 'A-OTHER', requester: owner, now: NOW }),
    (error) => ['APPOINTMENT_NOT_FOUND'].includes(error.code),
  );
});

test('doctor preparation uses current snapshot and deterministic recent medication diff', async () => {
  await seedProfile();
  await seedAppointment('A-1', '2026-09-01T09:00:00Z', { related_condition: 'เบาหวาน' });
  await seedSnapshot('S-OLD', '2026-08-01T00:00:00Z', [{ name: 'Metformin', dose: '500 mg' }]);
  await seedSnapshot('S-NEW', '2026-08-20T00:00:00Z', [
    { name: 'Metformin', dose: '1000 mg' }, { name: 'Aspirin', dose: '81 mg' },
  ]);
  const result = await buildDoctorVisitPreparation({ careProfileId: 'CP-1', appointmentId: 'A-1', requester: owner, now: NOW });
  assert.equal(result.currentMedications.snapshot.snapshotId, 'S-NEW');
  assert.equal(result.medicationChanges.status, 'AVAILABLE');
  assert.equal(result.medicationChanges.diff.doseChanged.length, 1);
  assert.equal(result.medicationChanges.diff.added.length, 1);
  assert.deepEqual(result.relevantConditions, ['เบาหวาน']);
});

test('doctor preparation reports NOT_AVAILABLE when there is no previous snapshot', async () => {
  await seedProfile();
  await seedAppointment('A-1', '2026-09-01T09:00:00Z');
  await seedSnapshot('S-ONLY', '2026-08-20T00:00:00Z', [{ name: 'Metformin', dose: '500 mg' }]);
  const result = await buildDoctorVisitPreparation({ careProfileId: 'CP-1', appointmentId: 'A-1', requester: owner, now: NOW });
  assert.deepEqual(result.medicationChanges, { status: 'NOT_AVAILABLE' });
});

test('doctor preparation handles no current snapshot without treating old medication rows as current', async () => {
  await seedProfile();
  await seedAppointment('A-1', '2026-09-01T09:00:00Z');
  await db.Medications.insert({ medication_id: 'M-OLD', care_profile_id: 'CP-1', name: 'Old medicine' });
  const result = await buildDoctorVisitPreparation({ careProfileId: 'CP-1', appointmentId: 'A-1', requester: owner, now: NOW });
  assert.equal(result.currentMedications.status, 'NO_CURRENT_SNAPSHOT');
  assert.deepEqual(result.currentMedications.medications, []);
  assert.equal(result.questionInputs.itemsToClarify.some((item) => item.code === 'CURRENT_MEDICATION_SNAPSHOT_MISSING'), true);
});

test('missing appointment fields stay empty and become data clarification items', async () => {
  await seedProfile();
  await seedAppointment('A-1', '2026-09-01', { reason_for_visit: '', reason: '', note: '', clinic_or_department: '' });
  const result = await buildDoctorVisitPreparation({ careProfileId: 'CP-1', appointmentId: 'A-1', requester: owner, now: NOW });
  assert.equal(result.appointment.reason, '');
  assert.equal(result.appointment.time, null);
  assert.deepEqual(result.questionInputs.itemsToClarify.map((item) => item.code), [
    'APPOINTMENT_TIME_MISSING', 'APPOINTMENT_REASON_MISSING', 'CURRENT_MEDICATION_SNAPSHOT_MISSING',
  ]);
});

test('outputs contain no clinical recommendation or sensitive identifier leakage', async () => {
  await seedProfile();
  await seedAppointment('A-1', '2026-09-01T09:00:00Z');
  await seedSnapshot('S-1', '2026-08-20T00:00:00Z', [{ name: 'Metformin', dose: '500 mg', imageBase64: 'nested-private' }]);
  const result = await buildDoctorVisitPreparation({ careProfileId: 'CP-1', appointmentId: 'A-1', requester: owner, now: NOW });
  const serialized = JSON.stringify(result);
  for (const secret of ['0899999999', '0811111111', 'U-PRIVATE', 'private-image', 'nested-private']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(Object.hasOwn(result, 'recommendation'), false);
  assert.equal(Object.hasOwn(result.questionInputs, 'clinicalAdvice'), false);
});
