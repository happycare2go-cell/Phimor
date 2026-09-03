const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { buildCareProfileContext } = require('./careProfileContextBuilder');
const { compareLatestMedicationSnapshots } = require('./medicationDiffService');
const { getUpcomingAppointmentSummary } = require('./appointmentSummaryService');
const { createLabRepository } = require('./labRepository');
const { createConsultationRepository } = require('./consultationRepository');
const { createPharmacistAccountService } = require('./pharmacistAccountService');
const { createPharmacistClinicalContextService } = require('./pharmacistClinicalContextService');
const {
  ConsultationDomainError, effectiveConsultationState, assertProvisionedConsultationCase,
} = require('../domain/consultation');
const { classifyConsultationSafety } = require('./consultationSafetyService');
const {
  medicationFact, projectMedicationChanges, confirmedRows, projectConfirmedLab,
} = require('./doctorQuestionContextBuilder');

const MAX_RESEARCH_MESSAGES = 200;
const MAX_RESEARCH_CONVERSATION_CHARS = 60000;
const MAX_RESEARCH_LABS = 16;
const MAX_RESEARCH_APPOINTMENTS = 3;

function boundedText(value, max = 4000) {
  return typeof value === 'string' ? value.normalize('NFC').trim().slice(0, max) : '';
}

function minimizeResearchConversation(initialQuestion, rows, {
  totalCount = rows.length,
  maxMessages = MAX_RESEARCH_MESSAGES,
  maxCharacters = MAX_RESEARCH_CONVERSATION_CHARS,
} = {}) {
  const sourceRows = (Array.isArray(rows) ? rows : []).slice(0, maxMessages);
  let remaining = maxCharacters;
  const initial = boundedText(initialQuestion, Math.min(4000, remaining));
  remaining -= initial.length;
  const messages = [];
  for (const row of sourceRows) {
    if (!['customer', 'pharmacist'].includes(row.sender_type) || remaining <= 0) continue;
    const source = boundedText(row.body, 4000);
    if (!source) continue;
    const text = source.slice(0, remaining);
    if (!text) break;
    remaining -= text.length;
    messages.push(Object.freeze({
      role:row.sender_type,
      text,
      sequence:Number(row.message_sequence),
      createdAt:row.created_at || null,
      sourceCategory:'consultation_message',
    }));
    if (text.length < source.length) break;
  }
  const actualTotal = Math.max(Number(totalCount) || 0, sourceRows.length);
  const totalMessageCount = actualTotal + (initial ? 1 : 0);
  const analyzedMessageCount = messages.length + (initial ? 1 : 0);
  return Object.freeze({
    initialQuestion: initial || null,
    messages:Object.freeze(messages),
    conversationTruncated: actualTotal > messages.length
      || sourceRows.length > messages.length
      || boundedText(initialQuestion, 100000).length > initial.length,
    analyzedMessageCount,
    totalMessageCount,
    analyzedThroughSequence:messages.at(-1)?.sequence || 0,
  });
}

function profileFacts(profile = {}) {
  const facts = [];
  if (profile.gender) facts.push({ field:'gender', value:profile.gender, sourceCategory:'care_profile' });
  if (Number.isFinite(profile.weightKg)) facts.push({ field:'weight_kg', value:profile.weightKg, sourceCategory:'care_profile' });
  for (const value of Array.isArray(profile.chronicConditions) ? profile.chronicConditions.slice(0, 20) : []) {
    if (boundedText(value, 200)) facts.push({ field:'chronic_condition', value:boundedText(value, 200), sourceCategory:'care_profile' });
  }
  if (boundedText(profile.drugAllergies, 500)) {
    facts.push({ field:'drug_allergies', value:boundedText(profile.drugAllergies, 500), sourceCategory:'care_profile' });
  }
  if (boundedText(profile.foodAllergies, 500)) {
    facts.push({ field:'food_allergies', value:boundedText(profile.foodAllergies, 500), sourceCategory:'care_profile' });
  }
  return Object.freeze(facts.map(Object.freeze));
}

function vitalFacts(sets = []) {
  const facts = [];
  for (const set of sets.slice(0, 5)) {
    for (const observation of (set.observations || []).slice(0, 20 - facts.length)) {
      facts.push(Object.freeze({
        measurementType:observation.measurementType,
        numericValue:observation.numericValue,
        canonicalUnit:observation.canonicalUnit,
        context:observation.context || null,
        occurredAt:set.occurredAt,
        sourceCategory:'vital_sign',
      }));
    }
  }
  return Object.freeze(facts);
}

function labFacts(rows = []) {
  return Object.freeze(confirmedRows(rows).slice(0, MAX_RESEARCH_LABS).map((row) => {
    const projected = projectConfirmedLab(row);
    return Object.freeze({ ...projected, source:'lab_result', sourceCategory:'lab_result' });
  }));
}

function appointmentFacts(items = []) {
  return Object.freeze(items.slice(0, MAX_RESEARCH_APPOINTMENTS).map((item) => Object.freeze({
    hospital:boundedText(item.hospital, 240) || null,
    department:boundedText(item.department || item.clinicOrDepartment, 200) || null,
    datetime:item.datetime || null,
    reason:boundedText(item.reason || item.reasonForVisit, 500) || null,
    notes:boundedText(item.notes || item.note, 500) || null,
    sourceCategory:'appointment',
  })));
}

function privacyTerms(consultationCase, profile, conversation) {
  const raw = [
    consultationCase.case_id, consultationCase.care_profile_id,
    consultationCase.customer_line_user_id, profile.patientName,
  ];
  if (profile.patientName) raw.push(...String(profile.patientName).split(/\s+/));
  return Object.freeze({
    blockedTerms:Object.freeze([...new Set(raw.map((value) => boundedText(value, 200)).filter((value) => value.length >= 3))]),
    conversationTexts:Object.freeze([
      conversation.initialQuestion,
      ...conversation.messages.map((item) => item.text),
    ].filter(Boolean)),
  });
}

function createConsultationResearchContextBuilder(overrides = {}) {
  const repository = overrides.repository || createConsultationRepository();
  const accounts = overrides.pharmacistAccounts || createPharmacistAccountService({ repository });
  const authorize = overrides.authorizeCareProfileAccess || authorizeCareProfileAccess;
  const profileContext = overrides.buildCareProfileContext || buildCareProfileContext;
  const clinical = overrides.clinicalContextService || createPharmacistClinicalContextService(overrides.clinicalDependencies);
  const medicationDiff = overrides.compareLatestMedicationSnapshots || compareLatestMedicationSnapshots;
  const appointments = overrides.getUpcomingAppointmentSummary || getUpcomingAppointmentSummary;
  const labs = overrides.labRepository || createLabRepository(overrides.labRepositoryOptions);

  return async function buildConsultationResearchContext({ caseId, pharmacistLineUserId, now = new Date() } = {}) {
    const pharmacist = await accounts.requireActive(pharmacistLineUserId);
    const consultationCase = await repository.findCaseForRead(caseId);
    if (!consultationCase) throw new ConsultationDomainError('CASE_NOT_FOUND', 404);
    assertProvisionedConsultationCase(consultationCase);
    if (consultationCase.assigned_pharmacist_id !== pharmacist.pharmacistId) {
      throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED', 403);
    }
    const state = effectiveConsultationState(consultationCase, consultationCase.database_now || now);
    if (!['active', 'resolved'].includes(state)) {
      throw new ConsultationDomainError(state === 'closed' ? 'CONSULTATION_EXPIRED' : 'CONSULTATION_NOT_ACTIVE', 409);
    }
    const requester = { lineUserId:consultationCase.customer_line_user_id, requireActiveCenter:true };
    await authorize({
      lineUserId:requester.lineUserId, careProfileId:consultationCase.care_profile_id,
      permission:'view', requireActiveCenter:true,
    });
    const messageResult = await repository.listResearchMessages(caseId, { limit:MAX_RESEARCH_MESSAGES });
    const rows = Array.isArray(messageResult) ? messageResult : messageResult.rows;
    const totalCount = Array.isArray(messageResult) ? messageResult.length : messageResult.totalCount;
    const conversation = minimizeResearchConversation(consultationCase.initial_question, rows, { totalCount });
    const [profileEnvelope, clinicalContext, changeResult, labRows, upcoming] = await Promise.all([
      profileContext({
        careProfileId:consultationCase.care_profile_id, requester,
        purpose:'care_profile_summary', options:{ now:consultationCase.database_now || now },
      }),
      clinical.getContext({
        careProfileId:consultationCase.care_profile_id,
        customerLineUserId:consultationCase.customer_line_user_id,
        now:consultationCase.database_now || now,
      }),
      medicationDiff({ careProfileId:consultationCase.care_profile_id, requester }),
      labs.listRecentConfirmedObservations({
        careProfileId:consultationCase.care_profile_id, reportLimit:5, observationLimit:24,
      }),
      appointments({
        careProfileId:consultationCase.care_profile_id, requester,
        limit:MAX_RESEARCH_APPOINTMENTS, now:consultationCase.database_now || now,
      }),
    ]);
    const profile = profileEnvelope.context.profile;
    const currentMedications = (clinicalContext.currentMedications || []).slice(0, 30)
      .map((item) => medicationFact(item));
    const missingInformation = [];
    if (!currentMedications.length) missingInformation.push('CURRENT_MEDICATION_SNAPSHOT_MISSING');
    if (!boundedText(profile.drugAllergies, 500)) missingInformation.push('DRUG_ALLERGIES_NOT_RECORDED');
    if (!labFacts(labRows).length) missingInformation.push('CONFIRMED_LAB_MISSING');
    const triage = classifyConsultationSafety(consultationCase.initial_question || '');
    const context = Object.freeze({
      contextType:'pharmacist_clinical_research',
      contextVersion:'consultation-clinical-research-context-v1',
      contextTimestamp:new Date(consultationCase.database_now || now).toISOString(),
      state,
      triage:Object.freeze({ action:triage.action, category:triage.category, reasonCode:triage.reasonCode || null }),
      conversation,
      recordedFacts:profileFacts(profile),
      currentMedications:Object.freeze(currentMedications),
      medicationChanges:projectMedicationChanges(changeResult),
      vitalFacts:vitalFacts(clinicalContext.recentVitals || []),
      confirmedLabs:labFacts(labRows),
      appointments:appointmentFacts(upcoming),
      missingInformation:Object.freeze(missingInformation),
    });
    return Object.freeze({
      context,
      privacy:privacyTerms(consultationCase, profile, conversation),
      careProfileId:consultationCase.care_profile_id,
      pharmacistId:pharmacist.pharmacistId,
    });
  };
}

const buildConsultationResearchContext = createConsultationResearchContextBuilder();

module.exports = {
  MAX_RESEARCH_MESSAGES, MAX_RESEARCH_CONVERSATION_CHARS, MAX_RESEARCH_LABS,
  MAX_RESEARCH_APPOINTMENTS, boundedText, minimizeResearchConversation,
  profileFacts, vitalFacts, labFacts, appointmentFacts, privacyTerms,
  createConsultationResearchContextBuilder, buildConsultationResearchContext,
};
