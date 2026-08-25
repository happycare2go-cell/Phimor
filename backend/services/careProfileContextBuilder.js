const { CareProfiles, Appointments } = require('../db');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { AI_VERSIONS } = require('../config/aiVersions');
const { getCurrentMedicationSnapshot } = require('./medicationRetrievalService');

const PURPOSE_PERMISSION_MAP = Object.freeze({
  care_profile_summary: 'view',
  medication_summary: 'view',
  appointment_summary: 'view',
  doctor_visit_preparation: 'view',
});

class CareProfileContextError extends Error {
  constructor(code) {
    super('ไม่สามารถสร้างข้อมูลประกอบสำหรับคำขอนี้ได้');
    this.name = 'CareProfileContextError';
    this.code = code;
    this.status = code === 'APPOINTMENT_NOT_FOUND' ? 404 : 400;
  }
}

function asArray(value) { return Array.isArray(value) ? value : []; }
function timestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function projectProfile(profile) {
  return {
    patientName: profile.patient_name || null,
    gender: profile.gender || null,
    bloodType: profile.blood_type || null,
    heightCm: nullableNumber(profile.height_cm),
    weightKg: nullableNumber(profile.weight_kg),
    chronicConditions: asArray(profile.chronic_conditions).filter((value) => typeof value === 'string').slice(0, 50),
    drugAllergies: typeof profile.drug_allergies === 'string' ? profile.drug_allergies : '',
    foodAllergies: typeof profile.food_allergies === 'string' ? profile.food_allergies : '',
    mobilityLimitations: typeof profile.mobility_limitations === 'string' ? profile.mobility_limitations : '',
  };
}

function projectMedication(item) {
  return {
    name: typeof item?.name === 'string' ? item.name : '',
    dose: typeof item?.dose === 'string' ? item.dose : '',
    condition: typeof item?.condition === 'string' ? item.condition : '',
    note: typeof item?.note === 'string' ? item.note : '',
    instruction: typeof item?.instruction === 'string' ? item.instruction : '',
  };
}

function projectAppointment(item) {
  return {
    appointmentId: item.appointment_id,
    hospital: item.hospital || '',
    datetime: item.datetime,
    clinicOrDepartment: item.clinic_or_department || '',
    reasonForVisit: item.reason_for_visit || '',
    relatedCondition: item.related_condition || '',
    doctorName: item.doctor_name || '',
    note: item.note || '',
    status: item.status || 'active',
  };
}

function isUpcomingActive(appointment, now) {
  if (['cancelled', 'completed', 'deleted'].includes(appointment.status)) return false;
  const at = new Date(appointment.datetime);
  return !Number.isNaN(at.getTime()) && at.getTime() > now.getTime();
}

async function medicationContext(careProfileId, profile, requester) {
  const current = await getCurrentMedicationSnapshot({ careProfileId, requester });
  return {
    data: {
      status: current.status,
      currentSnapshot: current.currentSnapshot,
      medicationSource: current.medicationSource,
      medications: current.medications.map(projectMedication),
      allergies: { drug: profile.drug_allergies || '', food: profile.food_allergies || '' },
    },
    version: {
      medicationSnapshotId: current.currentSnapshot?.snapshotId || null,
      medicationRecordedAt: current.currentSnapshot?.recordedAt || null,
    },
  };
}

async function upcomingAppointments(careProfileId, now, limit = 10) {
  const records = await Appointments.findWhere((item) => item.care_profile_id === careProfileId);
  return records.filter((item) => isUpcomingActive(item, now))
    .sort((a, b) => timestamp(a.datetime) - timestamp(b.datetime))
    .slice(0, Math.min(Math.max(Number(limit) || 10, 1), 25));
}

async function buildCareProfileContext({ careProfileId, requester, purpose, options = {} } = {}) {
  const permission = PURPOSE_PERMISSION_MAP[purpose];
  if (!permission) throw new CareProfileContextError('UNSUPPORTED_PURPOSE');
  const generatedAtDate = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(generatedAtDate.getTime())) throw new CareProfileContextError('INVALID_TIME');

  await authorizeCareProfileAccess({
    lineUserId: requester?.lineUserId,
    careProfileId,
    permission,
    centerId: requester?.centerId || null,
    requireActiveCenter: requester?.requireActiveCenter !== false,
  });
  // Read again only after backend authorization, so no protected context is
  // assembled before access is confirmed.
  const profile = await CareProfiles.findOne((item) => item.care_profile_id === careProfileId);
  const profileVersion = profile?._updatedAt || profile?.updated_at || profile?.created_at || null;
  let context;
  let purposeVersion = {};

  if (purpose === 'care_profile_summary') {
    context = { profile: projectProfile(profile) };
  } else if (purpose === 'medication_summary') {
    const medication = await medicationContext(careProfileId, profile, requester);
    context = medication.data;
    purposeVersion = medication.version;
  } else if (purpose === 'appointment_summary') {
    const appointments = await upcomingAppointments(careProfileId, generatedAtDate, options.limit);
    context = { upcomingAppointments: appointments.map(projectAppointment) };
    purposeVersion = { appointmentIds: appointments.map((item) => item.appointment_id) };
  } else {
    if (!options.appointmentId) throw new CareProfileContextError('APPOINTMENT_REQUIRED');
    const appointments = await upcomingAppointments(careProfileId, generatedAtDate, 25);
    const selected = appointments.find((item) => item.appointment_id === options.appointmentId);
    if (!selected) throw new CareProfileContextError('APPOINTMENT_NOT_FOUND');
    const medication = await medicationContext(careProfileId, profile, requester);
    const explicitlyRelated = typeof selected.related_condition === 'string' && selected.related_condition.trim()
      ? [selected.related_condition.trim()] : [];
    const relevantConditions = explicitlyRelated.length > 0
      ? explicitlyRelated
      : [...new Set(asArray(profile.chronic_conditions).filter((item) => typeof item === 'string' && item.trim()))];
    context = {
      appointment: projectAppointment(selected),
      medications: medication.data.medications,
      allergies: medication.data.allergies,
      relevantConditions,
    };
    purposeVersion = { appointmentId: selected.appointment_id, ...medication.version };
  }

  return Object.freeze({
    purpose,
    careProfileId,
    generatedAt: generatedAtDate.toISOString(),
    dataVersion: Object.freeze({ contextSchema: AI_VERSIONS.careProfileContext, profileUpdatedAt: profileVersion, ...purposeVersion }),
    context: Object.freeze(context),
  });
}

module.exports = {
  PURPOSE_PERMISSION_MAP, CareProfileContextError,
  projectProfile, projectMedication, projectAppointment, isUpcomingActive,
  buildCareProfileContext,
};
