const { CareProfiles, Appointments } = require('../db');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { createConsultationRepository } = require('./consultationRepository');
const { createPharmacistAccountService } = require('./pharmacistAccountService');
const { loadCurrentSnapshot } = require('./medicationRetrievalService');
const { createPharmacistClinicalContextService } = require('./pharmacistClinicalContextService');
const {
  projectProfile, projectMedication, projectAppointment, isUpcomingActive,
} = require('./careProfileContextBuilder');
const lineClient = require('../providers/lineClient');
const {
  ConsultationDomainError, effectiveConsultationState, assertProvisionedConsultationCase,
} = require('../domain/consultation');

const MAX_UPCOMING_APPOINTMENTS = 5;

function safeLinePictureUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    if (hostname !== 'profile.line-scdn.net' && !hostname.endsWith('.line-scdn.net')) return null;
    return parsed.toString();
  } catch (_) { return null; }
}

function projectLineContact(profile) {
  const displayName = typeof profile?.displayName === 'string' && profile.displayName.trim()
    ? profile.displayName.trim().slice(0, 100) : 'ผู้ติดต่อผ่าน LINE';
  return Object.freeze({
    displayName,
    pictureUrl:safeLinePictureUrl(profile?.pictureUrl),
  });
}

function createConsultationCaseContextService({
  repository = createConsultationRepository(),
  pharmacistAccounts = null,
  authorize = authorizeCareProfileAccess,
  careProfiles = CareProfiles,
  appointments = Appointments,
  loadMedicationSnapshot = loadCurrentSnapshot,
  clinicalContextService = null,
  getLineProfile = lineClient.getProfile,
  now = () => new Date(),
} = {}) {
  const accounts = pharmacistAccounts || createPharmacistAccountService({ repository });
  const clinicalService = clinicalContextService
    || (loadMedicationSnapshot === loadCurrentSnapshot ? createPharmacistClinicalContextService() : null);

  async function getCaseContext({ caseId, pharmacistLineUserId } = {}) {
    if (!caseId || !pharmacistLineUserId) {
      throw new ConsultationDomainError('CONSULTATION_CONTEXT_INPUT_REQUIRED', 400);
    }
    const pharmacist = await accounts.requireActive(pharmacistLineUserId);
    const consultationCase = await repository.findCaseForRead(caseId);
    if (!consultationCase) throw new ConsultationDomainError('CASE_NOT_FOUND', 404);
    assertProvisionedConsultationCase(consultationCase);
    if (consultationCase.assigned_pharmacist_id !== pharmacist.pharmacistId) {
      throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED', 403);
    }
    const state = effectiveConsultationState(
      consultationCase,
      consultationCase.database_now || now()
    );
    if (!['active', 'resolved'].includes(state)) {
      throw new ConsultationDomainError(
        state === 'closed' ? 'CONSULTATION_EXPIRED' : 'CONSULTATION_NOT_ACTIVE',
        409
      );
    }

    // The customer bought this consultation for a specific Care Profile. Recheck
    // that relationship before every fresh clinical projection; assigned-case
    // access alone must never grant access after caregiver revocation.
    const authorization = await authorize({
      lineUserId:consultationCase.customer_line_user_id,
      careProfileId:consultationCase.care_profile_id,
      permission:'view',
      requireActiveCenter:true,
    });
    const profile = authorization?.careProfile || await careProfiles.findOne(
      (item) => item.care_profile_id === consultationCase.care_profile_id
    );
    if (!profile || ['inactive', 'revoked', 'deleted'].includes(profile.status)) {
      throw new ConsultationDomainError('CARE_PROFILE_NOT_FOUND', 404);
    }

    const [lineProfile, clinical, upcoming] = await Promise.all([
      Promise.resolve(getLineProfile(consultationCase.customer_line_user_id)).catch(() => null),
      clinicalService ? clinicalService.getContext({
        careProfileId:consultationCase.care_profile_id,
        customerLineUserId:consultationCase.customer_line_user_id,
        now:consultationCase.database_now || now(),
      }) : loadMedicationSnapshot(consultationCase.care_profile_id).then((medication) => ({
        currentMedications:medication.medications,
        medicationSnapshot:medication.currentSnapshot || {}, recentMedicationChanges:[],
        recentVitals:[], latestVitals:{ temperature:null,bloodPressure:null,pulse:null,spo2:null },
        contextVersion:{ medicationSnapshotId:medication.currentSnapshot?.snapshotId || null,
          medicationVersionNo:medication.currentSnapshot?.versionNo || null, latestVitalOccurredAt:null },
      })),
      appointments.findWhere((item) => item.care_profile_id === consultationCase.care_profile_id),
    ]);
    const referenceTime = new Date(consultationCase.database_now || now());
    const upcomingAppointments = upcoming
      .filter((item) => isUpcomingActive(item, referenceTime))
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
      .slice(0, MAX_UPCOMING_APPOINTMENTS)
      .map(projectAppointment);

    return Object.freeze({
      caseId:consultationCase.case_id,
      generatedAt:new Date(now()).toISOString(),
      contact:projectLineContact(lineProfile),
      careProfile:Object.freeze(projectProfile(profile)),
      currentMedications:Object.freeze(clinical.currentMedications.map(projectMedication)),
      recentMedicationChanges:clinical.recentMedicationChanges,
      recentVitals:clinical.recentVitals,
      latestVitals:clinical.latestVitals,
      upcomingAppointments:Object.freeze(upcomingAppointments),
      dataVersion:Object.freeze({
        profileUpdatedAt:profile._updatedAt || profile.updated_at || profile.created_at || null,
        medicationSnapshotId:clinical.medicationSnapshot?.snapshotId || null,
        medicationVersionNo:clinical.medicationSnapshot?.versionNo || null,
        medicationRecordedAt:clinical.medicationSnapshot?.recordedAt || null,
        latestVitalOccurredAt:clinical.contextVersion?.latestVitalOccurredAt || null,
      }),
    });
  }

  return { getCaseContext };
}

module.exports = {
  MAX_UPCOMING_APPOINTMENTS,
  safeLinePictureUrl,
  projectLineContact,
  createConsultationCaseContextService,
};
