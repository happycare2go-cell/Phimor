const { ConsultationDomainError,asInstant } = require('../domain/consultation');

const CONSULTATION_NOTIFICATION_TYPES=Object.freeze([
  'consultation_queued','pharmacist_accepted','new_consultation_message',
  'consultation_expiring_soon','consultation_closed',
]);
const NEAR_EXPIRY_MINUTES=Object.freeze([120,30]);

function buildConsultationNotificationIntent({type,caseId,milestoneMinutes=null,messageSequence=null}={}) {
  if (!CONSULTATION_NOTIFICATION_TYPES.includes(type)) throw new ConsultationDomainError('INVALID_NOTIFICATION_TYPE');
  if (typeof caseId!=='string' || !caseId.trim()) throw new ConsultationDomainError('CASE_REQUIRED');
  if (type==='consultation_expiring_soon' && !NEAR_EXPIRY_MINUTES.includes(milestoneMinutes)) {
    throw new ConsultationDomainError('INVALID_EXPIRY_MILESTONE');
  }
  if (type==='new_consultation_message'
      && (!Number.isSafeInteger(Number(messageSequence)) || Number(messageSequence)<1)) {
    throw new ConsultationDomainError('INVALID_MESSAGE_SEQUENCE');
  }
  const suffix=type==='consultation_expiring_soon' ? milestoneMinutes
    : type==='new_consultation_message' ? Number(messageSequence) : null;
  return Object.freeze({
    kind:'consultation_notification',eventType:type,caseId:caseId.trim(),
    milestoneMinutes:type==='consultation_expiring_soon' ? milestoneMinutes : null,
    messageSequence:type==='new_consultation_message' ? Number(messageSequence) : null,
    dedupeKey:suffix!==null
      ? `consultation:${caseId}:${type}:${suffix}`
      : `consultation:${caseId}:${type}`,
  });
}

function getNearExpiryMilestones(expiresAt) {
  const expires=asInstant(expiresAt);
  return NEAR_EXPIRY_MINUTES.map((minutes)=>Object.freeze({
    milestoneMinutes:minutes,
    notifyAt:new Date(expires.getTime()-minutes*60_000).toISOString(),
  }));
}

module.exports={
  CONSULTATION_NOTIFICATION_TYPES,NEAR_EXPIRY_MINUTES,
  buildConsultationNotificationIntent,getNearExpiryMilestones,
};
