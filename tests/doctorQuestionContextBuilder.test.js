const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDoctorQuestionContextBuilder,
} = require('../backend/services/doctorQuestionContextBuilder');

const NOW = new Date('2026-08-26T00:00:00.000Z');

function labRow({ reportId, at, value, status = 'confirmed', overrides = {} }) {
  return {
    report_id: reportId, observation_id: `O-${reportId}`, report_status: status,
    specimen_collected_at: at, analyte_name_source: 'HbA1c', source_value_text: String(value),
    value_type: 'numeric', numeric_value: value, source_unit: '%', reference_range_text: '4.0-6.0',
    abnormal_flag_source: null, specimen_source: 'blood', method_source: 'HPLC',
    loinc_code: '4548-4', loinc_verification_source: 'human_verified',
    loinc_verified_by: 'VERIFIER', loinc_verified_at: '2026-08-20T00:00:00Z',
    comparison_key: 'hba1c', ...overrides,
  };
}

function dependencies(overrides = {}) {
  const access = overrides.access || { principalType: 'family_owner' };
  return {
    authorizeCareProfileAccess: overrides.authorize || (async () => access),
    buildCareProfileContext: async () => ({
      context: { profile: {
        patientName: 'คุณสมใจ', chronicConditions: ['เบาหวาน'],
        drugAllergies: 'Penicillin', foodAllergies: 'กุ้ง', mobilityLimitations: 'ใช้ไม้เท้า',
        emergencyContactPhone: '0899999999', familyPhone: '0811111111', lineUserId: 'U-PRIVATE',
      } },
      dataVersion: { profileUpdatedAt: '2026-08-25T00:00:00Z' },
    }),
    getCurrentMedicationSnapshot: async () => ({
      status: 'CURRENT_SNAPSHOT', currentSnapshot: { snapshotId: 'SNAP-NEW' },
      medications: [{
        name: 'Metformin', strength: '500 mg', dose: '1 เม็ด', instruction: 'หลังอาหาร',
        imageBase64: 'PRIVATE-IMAGE', phone: '0822222222',
      }],
    }),
    compareLatestMedicationSnapshots: async () => ({
      status: 'AVAILABLE', diff: {
        added: [{ original: { name: 'Aspirin', dose: '81 mg' } }], removed: [],
        doseChanged: [{
          previous: { original: { name: 'Metformin', dose: '500 mg' } },
          current: { original: { name: 'Metformin', dose: '1000 mg' } },
        }],
        instructionChanged: [], warnings: [],
      },
    }),
    getUpcomingAppointmentSummary: async () => [{
      appointmentId: 'APT-1', hospital: 'โรงพยาบาลกลาง', department: 'อายุรกรรม',
      datetime: '2026-09-01T09:00:00Z', reason: 'ติดตามเบาหวาน', notes: 'นำรายการยา',
    }],
    getUpcomingAppointmentById: async ({ appointmentId }) => appointmentId === 'APT-1' ? ({
      appointmentId, hospital: 'โรงพยาบาลกลาง', department: 'อายุรกรรม',
      datetime: '2026-09-01T09:00:00Z', reason: 'ติดตามเบาหวาน', notes: '',
    }) : null,
    labRepository: { listRecentConfirmedObservations: async () => [
      labRow({ reportId: 'R-NEW', at: '2026-08-20T00:00:00Z', value: 7.2 }),
      labRow({ reportId: 'R-OLD', at: '2026-05-20T00:00:00Z', value: 6.8 }),
      labRow({ reportId: 'R-DRAFT', at: '2026-08-21T00:00:00Z', value: 99, status: 'draft' }),
      labRow({ reportId: 'R-VOID', at: '2026-08-22T00:00:00Z', value: 98, status: 'voided' }),
    ] },
    ...overrides.dependencies,
  };
}

async function build(overrides = {}, input = {}) {
  return createDoctorQuestionContextBuilder(dependencies(overrides))({
    careProfileId: 'CP-1', lineUserId: 'U-ACTOR', now: NOW, ...input,
  });
}

test('Family owner context includes minimized current clinical facts with provenance', async () => {
  const result = await build();
  assert.deepEqual(result.context.conditions, [{ value: 'เบาหวาน', source: 'care_profile' }]);
  assert.equal(result.context.currentMedications[0].name, 'Metformin');
  assert.equal(result.context.medicationChanges.some((item) => item.type === 'dose_changed'), true);
  assert.equal(result.context.appointment.hospital, 'โรงพยาบาลกลาง');
  assert.equal(result.context.confirmedLabs.length, 2);
  assert.equal(result.context.safeLabTrends[0].direction, 'increased');
});

test('active caregiver and authorized center actor follow canonical view access', async () => {
  for (const principalType of ['family_caregiver', 'center_staff']) {
    const result = await build({ access: { principalType } }, { centerId: principalType === 'center_staff' ? 'CTR-1' : null });
    assert.equal(result.context.contextType, 'doctor_question_preparation');
  }
});

test('revoked caregiver and cross-profile authorization failures are propagated', async () => {
  for (const code of ['MEMBERSHIP_REVOKED', 'ACCESS_DENIED']) {
    await assert.rejects(
      build({ authorize: async () => { const error = new Error(code); error.code = code; throw error; } }),
      (error) => error.code === code,
    );
  }
});

test('pharmacist and system principals cannot use ordinary question context', async () => {
  for (const principalType of ['pharmacist', 'system_admin']) {
    await assert.rejects(build({ access: { principalType } }), (error) => error.code === 'ACCESS_DENIED');
  }
});

test('draft and voided Lab rows are excluded and only deterministic comparable trend is included', async () => {
  const result = await build();
  const serialized = JSON.stringify(result.context);
  assert.equal(serialized.includes('99'), false);
  assert.equal(serialized.includes('98'), false);
  assert.equal(result.context.safeLabTrends.length, 1);
  assert.equal(result.context.safeLabTrends[0].source, 'deterministic_lab_trend');
});

test('confirmed persisted Lab observations consumed by Family detail remain the same source for doctor questions', async () => {
  const persistedRows = [
    labRow({ reportId: 'R-CONFIRMED-NEW', at: '2026-08-20T00:00:00Z', value: 7.4,
      overrides: { source_value_text: '7.4', reference_range_text: '4.0-6.0' } }),
    labRow({ reportId: 'R-CONFIRMED-OLD', at: '2026-05-20T00:00:00Z', value: 6.9,
      overrides: { source_value_text: '6.9', reference_range_text: '4.0-6.0' } }),
  ];
  const result = await build({ dependencies: {
    labRepository: { listRecentConfirmedObservations: async () => persistedRows },
  } });
  assert.deepEqual(result.context.confirmedLabs.map((item) => item.sourceValueText), ['7.4', '6.9']);
  assert.equal(result.context.safeLabTrends[0].direction, 'increased');
  assert.equal(result.context.safeLabTrends[0].source, 'deterministic_lab_trend');
});

test('non-comparable Lab history is never exposed as a trend', async () => {
  const rows = [
    labRow({ reportId: 'R1', at: '2026-08-01T00:00:00Z', value: 5, overrides: { method_source: 'A' } }),
    labRow({ reportId: 'R2', at: '2026-08-20T00:00:00Z', value: 6, overrides: { method_source: 'B' } }),
  ];
  const result = await build({ dependencies: { labRepository: { listRecentConfirmedObservations: async () => rows } } });
  assert.deepEqual(result.context.safeLabTrends, []);
  assert.equal(result.context.confirmedLabs.length, 2);
});

test('selected appointment is scoped through existing appointment loader', async () => {
  const result = await build({}, { appointmentId: 'APT-1' });
  assert.equal(result.context.appointment.hospital, 'โรงพยาบาลกลาง');
  assert.equal(Object.hasOwn(result.context.appointment, 'appointmentId'), false);
  await assert.rejects(build({}, { appointmentId: 'APT-OTHER' }), (error) => error.code === 'APPOINTMENT_NOT_FOUND');
});

test('missing medication, Lab, and appointment information remains explicit and is never fabricated', async () => {
  const result = await build({ dependencies: {
    getCurrentMedicationSnapshot: async () => ({ status: 'NO_CURRENT_SNAPSHOT', medications: [] }),
    compareLatestMedicationSnapshots: async () => ({ status: 'NOT_AVAILABLE' }),
    getUpcomingAppointmentSummary: async () => [],
    labRepository: { listRecentConfirmedObservations: async () => [] },
  } });
  assert.deepEqual(result.context.currentMedications, []);
  assert.deepEqual(result.context.confirmedLabs, []);
  assert.equal(result.context.missingInformation.some((item) => item.code === 'CONFIRMED_LAB_MISSING'), true);
  assert.equal(result.context.missingInformation.some((item) => item.code === 'UPCOMING_APPOINTMENT_MISSING'), true);
});

test('context excludes phone LINE ID emergency contact raw image and Pending Card payload', async () => {
  const serialized = JSON.stringify((await build()).context);
  for (const secret of ['0899999999', '0811111111', '0822222222', 'U-PRIVATE', 'PRIVATE-IMAGE', 'pending_card', 'sourceReference']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});
