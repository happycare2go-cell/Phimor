const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { buildCareProfileContext } = require('./careProfileContextBuilder');
const { getCurrentMedicationSnapshot } = require('./medicationRetrievalService');
const { compareLatestMedicationSnapshots } = require('./medicationDiffService');
const {
  getUpcomingAppointmentSummary, getUpcomingAppointmentById,
} = require('./appointmentSummaryService');
const { createLabRepository } = require('./labRepository');
const { buildDeterministicTrend } = require('./labTrendService');

const MAX_CURRENT_MEDICATIONS = 30;
const MAX_CONFIRMED_LABS = 16;
const MAX_SAFE_TRENDS = 4;
const ALLOWED_PRINCIPALS = new Set(['family_owner', 'family_caregiver', 'center_staff']);

class DoctorQuestionError extends Error {
  constructor(code, status = 400) {
    super('ไม่สามารถเตรียมคำถามสำหรับพบแพทย์ได้');
    this.name = 'DoctorQuestionError';
    this.code = code;
    this.status = status;
  }
}

function rowValue(row, camel, snake) {
  return row?.[camel] ?? row?.[snake] ?? null;
}

function confirmedRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    rowValue(row, 'reportStatus', 'report_status') === 'confirmed');
}

function text(value, max = 500) {
  return typeof value === 'string' ? value.normalize('NFC').trim().slice(0, max) : '';
}

function scalar(value, max = 80) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return typeof value === 'string' ? text(value, max) || null : null;
}

function medicationFact(item = {}) {
  return Object.freeze({
    name: text(item.name, 200), strength: text(item.strength, 120),
    dose: text(item.dose, 200), instruction: text(item.instruction, 500),
    amount: scalar(item.amount), unit: text(item.unit, 80) || null,
    frequency: text(item.frequency, 120) || null, timing: text(item.timing, 120) || null,
    useCondition: text(item.useCondition, 40) || null,
    dayPeriods: Object.freeze((Array.isArray(item.dayPeriods) ? item.dayPeriods : [])
      .map((value) => text(value, 40)).filter(Boolean).slice(0, 4)),
    route: text(item.route, 120) || null, condition: text(item.condition, 500) || null,
    indication: text(item.indication, 500) || null, notes: text(item.notes, 500) || null,
    source: 'medication_snapshot',
  });
}

function changedMedication(entry, side) {
  return medicationFact(entry?.[side]?.original || {});
}

function projectMedicationChanges(result) {
  if (result?.status !== 'AVAILABLE' || !result.diff) return Object.freeze([]);
  const changes = [];
  for (const item of result.diff.added || []) {
    changes.push(Object.freeze({ type: 'added', current: medicationFact(item.original), source: 'medication_diff' }));
  }
  for (const item of result.diff.removed || []) {
    changes.push(Object.freeze({ type: 'removed', previous: medicationFact(item.original), source: 'medication_diff' }));
  }
  for (const item of result.diff.doseChanged || []) {
    changes.push(Object.freeze({
      type: 'dose_changed', previous: changedMedication(item, 'previous'),
      current: changedMedication(item, 'current'), source: 'medication_diff',
    }));
  }
  for (const item of result.diff.instructionChanged || []) {
    changes.push(Object.freeze({
      type: 'instruction_changed', previous: changedMedication(item, 'previous'),
      current: changedMedication(item, 'current'), source: 'medication_diff',
    }));
  }
  return Object.freeze(changes.slice(0, 30));
}

function verifiedLabIdentity(row) {
  const loincCode = rowValue(row, 'loincCode', 'loinc_code');
  if (loincCode
    && rowValue(row, 'loincVerificationSource', 'loinc_verification_source')
    && rowValue(row, 'loincVerifiedBy', 'loinc_verified_by')
    && rowValue(row, 'loincVerifiedAt', 'loinc_verified_at')) {
    return { loincCode };
  }
  const comparisonKey = rowValue(row, 'comparisonKey', 'comparison_key');
  return comparisonKey ? { comparisonKey } : null;
}

function projectConfirmedLab(row) {
  return Object.freeze({
    observedAt: rowValue(row, 'specimenCollectedAt', 'specimen_collected_at'),
    analyteNameSource: text(rowValue(row, 'analyteNameSource', 'analyte_name_source'), 240),
    sourceValueText: text(rowValue(row, 'sourceValueText', 'source_value_text'), 240),
    numericValue: rowValue(row, 'numericValue', 'numeric_value'),
    valueType: rowValue(row, 'valueType', 'value_type'),
    sourceUnit: text(rowValue(row, 'sourceUnit', 'source_unit'), 100) || null,
    referenceRangeText: text(rowValue(row, 'referenceRangeText', 'reference_range_text'), 240) || null,
    abnormalFlagSource: text(rowValue(row, 'abnormalFlagSource', 'abnormal_flag_source'), 120) || null,
    specimenSource: text(rowValue(row, 'specimenSource', 'specimen_source'), 160) || null,
    methodSource: text(rowValue(row, 'methodSource', 'method_source'), 160) || null,
    source: 'confirmed_lab',
  });
}

function buildSafeTrends(rows) {
  const identities = new Map();
  for (const row of rows) {
    const identity = verifiedLabIdentity(row);
    if (!identity) continue;
    const key = JSON.stringify(identity);
    if (!identities.has(key)) identities.set(key, identity);
  }
  const trends = [];
  for (const identity of identities.values()) {
    const trend = buildDeterministicTrend(rows, identity);
    if (trend.status !== 'available') continue;
    trends.push(Object.freeze({
      analyteNameSource: trend.sourceDisplayName,
      direction: trend.direction,
      absoluteChange: trend.absoluteChange,
      comparisonUnit: trend.comparisonUnit,
      rangesDiffer: trend.rangesDiffer,
      firstObservedAt: trend.observations[0]?.specimenCollectedAt || null,
      latestObservedAt: trend.observations.at(-1)?.specimenCollectedAt || null,
      source: 'deterministic_lab_trend',
    }));
    if (trends.length >= MAX_SAFE_TRENDS) break;
  }
  return Object.freeze(trends);
}

function missingItem(code, label, field = null) {
  return Object.freeze({ code, label, field, source: 'deterministic_missing_information' });
}

function collectMissingInformation({ current, medicationDiff, labRows, appointment }) {
  const missing = [];
  if (current.status !== 'CURRENT_SNAPSHOT') {
    missing.push(missingItem('CURRENT_MEDICATION_SNAPSHOT_MISSING', 'ยังไม่มีรายการยาปัจจุบันที่ยืนยันไว้', 'currentMedications'));
  } else if (current.medications.some((item) => !text(item.instruction))) {
    missing.push(missingItem('MEDICATION_INSTRUCTION_MISSING', 'ยาบางรายการยังไม่มีวิธีใช้ที่บันทึกไว้', 'currentMedications'));
  }
  if (medicationDiff?.status !== 'AVAILABLE') {
    missing.push(missingItem('MEDICATION_CHANGE_HISTORY_MISSING', 'ยังเปรียบเทียบรายการยากับครั้งก่อนไม่ได้', 'medicationChanges'));
  } else if ((medicationDiff.diff?.warnings || []).length > 0) {
    missing.push(missingItem('MEDICATION_CHANGE_AMBIGUOUS', 'พบรายการยาที่จับคู่กับครั้งก่อนได้ไม่ชัดเจน', 'medicationChanges'));
  }
  if (labRows.length === 0) {
    missing.push(missingItem('CONFIRMED_LAB_MISSING', 'ยังไม่มีผล Lab ที่ยืนยันแล้ว', 'confirmedLabs'));
  } else {
    if (labRows.some((row) => !rowValue(row, 'sourceUnit', 'source_unit'))) {
      missing.push(missingItem('LAB_UNIT_MISSING', 'ผล Lab บางรายการไม่มีหน่วยจากต้นฉบับ', 'confirmedLabs'));
    }
    if (labRows.some((row) => !rowValue(row, 'referenceRangeText', 'reference_range_text'))) {
      missing.push(missingItem('LAB_REFERENCE_RANGE_MISSING', 'ผล Lab บางรายการไม่มีช่วงอ้างอิงจากต้นฉบับ', 'confirmedLabs'));
    }
  }
  if (!appointment) {
    missing.push(missingItem('UPCOMING_APPOINTMENT_MISSING', 'ยังไม่มีนัดหมายที่กำลังจะถึง', 'appointment'));
  } else if (!appointment.reason) {
    missing.push(missingItem('APPOINTMENT_REASON_MISSING', 'นัดหมายยังไม่มีเหตุผลที่บันทึกไว้', 'appointment'));
  }
  return Object.freeze(missing.slice(0, 20));
}

function projectAppointment(appointment) {
  if (!appointment) return null;
  return Object.freeze({
    hospital: text(appointment.hospital, 240) || null,
    department: text(appointment.department, 200) || null,
    datetime: appointment.datetime || null,
    reason: text(appointment.reason, 500) || null,
    notes: text(appointment.notes, 500) || null,
    source: 'appointment',
  });
}

function createDoctorQuestionContextBuilder(overrides = {}) {
  const authorize = overrides.authorizeCareProfileAccess || authorizeCareProfileAccess;
  const profileContext = overrides.buildCareProfileContext || buildCareProfileContext;
  const currentMedication = overrides.getCurrentMedicationSnapshot || getCurrentMedicationSnapshot;
  const medicationDiff = overrides.compareLatestMedicationSnapshots || compareLatestMedicationSnapshots;
  const upcomingAppointments = overrides.getUpcomingAppointmentSummary || getUpcomingAppointmentSummary;
  const appointmentById = overrides.getUpcomingAppointmentById || getUpcomingAppointmentById;
  const labRepository = overrides.labRepository || createLabRepository(overrides.labRepositoryOptions);

  return async function buildDoctorQuestionContext({
    careProfileId, lineUserId, centerId = null, appointmentId = null, now = new Date(),
  } = {}) {
    if (typeof careProfileId !== 'string' || !careProfileId.trim()
      || typeof lineUserId !== 'string' || !lineUserId.trim()) {
      throw new DoctorQuestionError('INVALID_INPUT');
    }
    const requester = { lineUserId, centerId: centerId || null, requireActiveCenter: true };
    const access = await authorize({
      lineUserId, careProfileId, permission: 'view', centerId: centerId || null,
      requireActiveCenter: true,
    });
    if (!ALLOWED_PRINCIPALS.has(access?.principalType)) throw new DoctorQuestionError('ACCESS_DENIED', 403);

    const [profile, current, changes, labRows, appointments] = await Promise.all([
      profileContext({ careProfileId, requester, purpose: 'care_profile_summary', options: { now } }),
      currentMedication({ careProfileId, requester }),
      medicationDiff({ careProfileId, requester }),
      labRepository.listRecentConfirmedObservations({ careProfileId, reportLimit: 5, observationLimit: 24 }),
      appointmentId
        ? appointmentById({ careProfileId, appointmentId, requester, now })
        : upcomingAppointments({ careProfileId, requester, limit: 1, now }),
    ]);
    const appointment = appointmentId ? appointments : appointments[0] || null;
    if (appointmentId && !appointment) throw new DoctorQuestionError('APPOINTMENT_NOT_FOUND', 404);
    const profileData = profile.context.profile;
    const usableLabRows = confirmedRows(labRows);
    const confirmedLabs = usableLabRows.slice(0, MAX_CONFIRMED_LABS).map(projectConfirmedLab);
    const currentMedications = current.status === 'CURRENT_SNAPSHOT'
      ? current.medications.slice(0, MAX_CURRENT_MEDICATIONS).map(medicationFact) : [];
    const drugAllergies = text(profileData.drugAllergies, 500);
    const foodAllergies = text(profileData.foodAllergies, 500);
    const mobilityLimitations = text(profileData.mobilityLimitations, 500);
    const conditions = profileData.chronicConditions
      .map((value) => text(value, 200)).filter(Boolean).slice(0, 20);
    const allergies = Object.freeze([
      ...(drugAllergies ? [{ type: 'drug', value: drugAllergies, source: 'care_profile' }] : []),
      ...(foodAllergies ? [{ type: 'food', value: foodAllergies, source: 'care_profile' }] : []),
    ].map(Object.freeze));
    const context = Object.freeze({
      contextType: 'doctor_question_preparation',
      conditions: Object.freeze(conditions.map((value) => Object.freeze({ value, source: 'care_profile' }))),
      allergies,
      mobilityLimitations: mobilityLimitations
        ? Object.freeze({ value: mobilityLimitations, source: 'care_profile' }) : null,
      currentMedications: Object.freeze(currentMedications),
      medicationChanges: projectMedicationChanges(changes),
      confirmedLabs: Object.freeze(confirmedLabs),
      safeLabTrends: buildSafeTrends(usableLabRows),
      appointment: projectAppointment(appointment),
      missingInformation: collectMissingInformation({
        current, medicationDiff: changes, labRows: usableLabRows, appointment,
      }),
    });
    return Object.freeze({
      context, contextTimestamp: new Date(now).toISOString(),
      dataVersion: Object.freeze({
        profileUpdatedAt: profile.dataVersion.profileUpdatedAt || null,
        medicationSnapshotId: current.currentSnapshot?.snapshotId || null,
        appointmentId: appointment?.appointmentId || null,
      }),
    });
  };
}

module.exports = {
  DoctorQuestionError, MAX_CURRENT_MEDICATIONS, MAX_CONFIRMED_LABS, MAX_SAFE_TRENDS,
  confirmedRows, medicationFact, projectMedicationChanges, verifiedLabIdentity, projectConfirmedLab,
  buildSafeTrends, collectMissingInformation, createDoctorQuestionContextBuilder,
};
