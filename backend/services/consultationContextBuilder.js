const { CareProfiles, MedicationSnapshots, Appointments } = require('../db');
const { AI_VERSIONS } = require('../config/aiVersions');
const { createConsultationRepository } = require('./consultationRepository');
const { createPharmacistAccountService } = require('./pharmacistAccountService');
const {
  ConsultationDomainError, effectiveConsultationState, assertProvisionedConsultationCase,
} = require('../domain/consultation');
const {
  isEligibleCurrentSnapshot, loadSnapshotMedications,
} = require('./medicationRetrievalService');
const {
  normalizeMedication, matchNormalized,
} = require('./medicationDiffService');
const { isUpcomingAppointment, projectAppointmentSummary } = require('./appointmentSummaryService');
const { classifyConsultationSafety } = require('./consultationSafetyService');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { createPharmacistClinicalContextService } = require('./pharmacistClinicalContextService');

const DEFAULT_MESSAGE_WINDOW = 12;
const MAX_CONVERSATION_CHARACTERS = 6000;
const MEDICATION_PATTERN = /(ยา|medication|dose|ขนาด|กิน|รับประทาน)/i;
const APPOINTMENT_PATTERN = /(นัด|appointment|พบแพทย์|โรงพยาบาล)/i;

function source(category, recordedAt = null, referenceId = null) {
  return Object.freeze({ category, recordedAt:recordedAt || null, referenceId:referenceId || null });
}

function fact(field, value, sourceValue) {
  return Object.freeze({ field, value, source:sourceValue });
}

function minimizeConversation(initialQuestion, rows, maxCharacters = MAX_CONVERSATION_CHARACTERS) {
  let remaining=Math.max(0,Math.min(Number(maxCharacters)||MAX_CONVERSATION_CHARACTERS,MAX_CONVERSATION_CHARACTERS));
  const rawQuestion=String(initialQuestion || '').trim();
  const question=rawQuestion.slice(0,Math.min(4000,remaining));
  remaining-=question.length;
  const windowedRows=rows.slice(-DEFAULT_MESSAGE_WINDOW);
  const selected=[];
  for (const row of [...windowedRows].reverse()) {
    if (!['customer','pharmacist'].includes(row.sender_type) || remaining<=0) continue;
    const body=String(row.body || '').trim();
    if (!body) continue;
    const text=body.slice(Math.max(0,body.length-remaining));
    remaining-=text.length;
    selected.push(Object.freeze({
      role:row.sender_type, text, sequence:Number(row.message_sequence),
      createdAt:row.created_at || null, source:source('consultation_message',row.created_at,row.message_id),
    }));
  }
  selected.reverse();
  return Object.freeze({
    initialQuestion:question ? fact('initial_question',question,source('consultation_message')) : null,
    messages:Object.freeze(selected),
    truncated:rawQuestion.length>question.length
      || rows.some((row)=>!selected.some((item)=>item.sequence===Number(row.message_sequence)))
      || rows.reduce((sum,row)=>sum+String(row.body||'').length,0)>maxCharacters,
  });
}

function medicationProjection(item, snapshot) {
  return Object.freeze({
    name:item.name || '', strength:item.strength || '', dose:item.dose || '',
    instruction:item.instruction || '', amount:item.amount ?? null, unit:item.unit ?? null,
    frequency:item.frequency ?? null, timing:item.timing ?? null, route:item.route ?? null,
    condition:item.condition || '',
    source:source('medication_snapshot',snapshot.recorded_at || snapshot._createdAt,snapshot.snapshot_id),
  });
}

function conciseDiff(previousSnapshot, currentSnapshot, previousItems, currentItems) {
  const previous=previousItems.map(normalizeMedication);
  const current=currentItems.map(normalizeMedication);
  const matched=matchNormalized(previous,current);
  const name=(item)=>({name:item.original.name,strength:item.original.strength,dose:item.original.dose,instruction:item.original.instruction});
  const changes={
    added:[...matched.unmatchedCurrent].map((index)=>name(current[index])),
    removed:[...matched.unmatchedPrevious].map((index)=>name(previous[index])),
    doseChanged:[], instructionChanged:[], warnings:matched.warnings,
    source:source('medication_diff',currentSnapshot.recorded_at || currentSnapshot._createdAt,
      `${previousSnapshot.snapshot_id}:${currentSnapshot.snapshot_id}`),
  };
  for (const pair of matched.pairs) {
    const before=previous[pair.previousIndex]; const after=current[pair.currentIndex];
    if (before.normalized.strength!==after.normalized.strength || before.normalized.dose!==after.normalized.dose) {
      changes.doseChanged.push({before:name(before),after:name(after)});
    }
    if (before.normalized.instruction!==after.normalized.instruction) {
      changes.instructionChanged.push({before:name(before),after:name(after)});
    }
  }
  return Object.freeze(changes);
}

function createConsultationContextBuilder({
  repository=createConsultationRepository(), pharmacistAccounts=null,
  careProfiles=CareProfiles, medicationSnapshots=MedicationSnapshots, appointments=Appointments,
  loadMedications=loadSnapshotMedications, authorize=authorizeCareProfileAccess,
  clinicalContextService=null,
}={}) {
  const accounts=pharmacistAccounts || createPharmacistAccountService({repository});
  const clinicalService=clinicalContextService
    || (medicationSnapshots===MedicationSnapshots && loadMedications===loadSnapshotMedications
      ? createPharmacistClinicalContextService() : null);
  return async function buildConsultationContext({caseId,pharmacistLineUserId,now=new Date()}={}) {
    const pharmacist=await accounts.requireActive(pharmacistLineUserId);
    const consultationCase=await repository.findCaseForRead(caseId);
    if (!consultationCase) throw new ConsultationDomainError('CASE_NOT_FOUND',404);
    assertProvisionedConsultationCase(consultationCase);
    if (consultationCase.assigned_pharmacist_id!==pharmacist.pharmacistId) {
      throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED',403);
    }
    const state=effectiveConsultationState(consultationCase,consultationCase.database_now || now);
    if (!['active','resolved'].includes(state)) {
      throw new ConsultationDomainError(state==='closed'?'CONSULTATION_EXPIRED':'CONSULTATION_NOT_ACTIVE',409);
    }
    await authorize({
      lineUserId:consultationCase.customer_line_user_id,
      careProfileId:consultationCase.care_profile_id,
      permission:'view',
      requireActiveCenter:true,
    });
    const profile=await careProfiles.findOne((item)=>item.care_profile_id===consultationCase.care_profile_id);
    if (!profile || ['inactive','revoked','deleted'].includes(profile.status)) {
      throw new ConsultationDomainError('CARE_PROFILE_NOT_FOUND',404);
    }
    const messageRows=await repository.listRecentMessages(caseId,{limit:DEFAULT_MESSAGE_WINDOW});
    const conversation=minimizeConversation(consultationCase.initial_question,messageRows);
    const relevanceText=[consultationCase.initial_question,...messageRows.map((item)=>item.body)].join(' ');
    const triage=classifyConsultationSafety(consultationCase.initial_question || '');
    const medicationRelevant=MEDICATION_PATTERN.test(relevanceText);
    const clinical=medicationRelevant&&clinicalService ? await clinicalService.getContext({
      careProfileId:consultationCase.care_profile_id,
      customerLineUserId:consultationCase.customer_line_user_id,
      now:consultationCase.database_now || now,
    }) : null;
    const { compareSnapshotAuthority }=require('./medicationRetrievalService');
    const snapshots=medicationRelevant&&!clinical ? (await medicationSnapshots.findWhere((item)=>
      item.care_profile_id===consultationCase.care_profile_id && isEligibleCurrentSnapshot(item)))
      .sort(compareSnapshotAuthority) : [];
    const currentSnapshot=clinical?.medicationSnapshot?.snapshotId ? {
      snapshot_id:clinical.medicationSnapshot.snapshotId,
      version_no:clinical.medicationSnapshot.versionNo,
      recorded_at:clinical.medicationSnapshot.recordedAt,
    } : (snapshots[0] || null);
    const currentLoaded=clinical ? {medications:clinical.currentMedications}
      : (currentSnapshot ? await loadMedications(currentSnapshot) : {medications:[]});
    let medicationChanges=null;
    if (clinical?.recentMedicationChanges?.length) {
      medicationChanges=Object.freeze({items:clinical.recentMedicationChanges,
        source:source('medication_diff',clinical.medicationSnapshot.recordedAt,clinical.medicationSnapshot.snapshotId)});
    } else if (medicationRelevant && snapshots[1] && currentSnapshot) {
      const previousLoaded=await loadMedications(snapshots[1]);
      medicationChanges=conciseDiff(snapshots[1],currentSnapshot,previousLoaded.medications,currentLoaded.medications);
    }
    let relevantAppointments=[];
    if (APPOINTMENT_PATTERN.test(relevanceText)) {
      relevantAppointments=(await appointments.findWhere((item)=>item.care_profile_id===consultationCase.care_profile_id))
        .filter((item)=>isUpcomingAppointment(item,new Date(consultationCase.database_now || now)))
        .sort((a,b)=>new Date(a.datetime)-new Date(b.datetime)).slice(0,3)
        .map((item)=>Object.freeze({...projectAppointmentSummary(item),source:source('appointment',item._updatedAt||item._createdAt,item.appointment_id)}));
    }
    const recordedFacts=[];
    if (profile.drug_allergies) recordedFacts.push(fact('drug_allergies',profile.drug_allergies,source('care_profile',profile._updatedAt)));
    const conditions=Array.isArray(profile.chronic_conditions)
      ? profile.chronic_conditions.filter((item)=>typeof item==='string'&&item.trim()).slice(0,50) : [];
    if (conditions.length) recordedFacts.push(fact('chronic_conditions',conditions,source('care_profile',profile._updatedAt)));
    const missingInformation=[];
    if (medicationRelevant && !currentSnapshot) missingInformation.push('NO_CURRENT_MEDICATION_SNAPSHOT');
    if (!profile.drug_allergies) missingInformation.push('DRUG_ALLERGIES_NOT_RECORDED');
    return Object.freeze({
      schemaVersion:AI_VERSIONS.consultationContext,
      purpose:'pharmacist_assistance', generatedAt:new Date(now).toISOString(),
      contextTimestamp:new Date(consultationCase.database_now || now).toISOString(),
      case:Object.freeze({caseId:consultationCase.case_id,state,topicCategory:triage.category,triageCategory:triage.action}),
      conversation, recordedFacts:Object.freeze(recordedFacts),
      currentMedications:Object.freeze(currentLoaded.medications.map((item)=>medicationProjection(item,currentSnapshot))),
      medicationChanges,
      vitalFacts:Object.freeze((clinical?.recentVitals||[]).map((set)=>Object.freeze({
        occurredAt:set.occurredAt, linkedHealthReport:set.linkedHealthReport,
        observations:set.observations.map((item)=>Object.freeze({...item,source:source('vital_sign',set.occurredAt)})),
      }))),
      contextVersion:clinical?.contextVersion || null,
      appointments:Object.freeze(relevantAppointments),
      missingInformation:Object.freeze(missingInformation),
    });
  };
}

const buildConsultationContext=createConsultationContextBuilder();
module.exports={
  DEFAULT_MESSAGE_WINDOW,MAX_CONVERSATION_CHARACTERS,MEDICATION_PATTERN,APPOINTMENT_PATTERN,
  source,fact,minimizeConversation,medicationProjection,conciseDiff,
  createConsultationContextBuilder,buildConsultationContext,
};
