const { withTransaction } = require('../db');
const notificationService = require('./notificationService');
const { createConsultationRepository } = require('./consultationRepository');
const { buildConsultationNotificationIntent } = require('./consultationNotificationEventService');

const PHARMACIST_LIFF_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z_-]{2,127}$/;
const QUEUED_NOTIFICATION_TEXT = 'มี Consult Case ใหม่รอรับเคส\nกรุณาเปิด Pharmacist Console เพื่อตรวจสอบ';

function pharmacistConsoleUrl(env = process.env) {
  const liffId = typeof env.LIFF_ID_PHARMACIST === 'string' ? env.LIFF_ID_PHARMACIST.trim() : '';
  return PHARMACIST_LIFF_ID_PATTERN.test(liffId) ? `https://liff.line.me/${liffId}` : null;
}

function queuedNotificationMessages(url) {
  if (!url) return null;
  return Object.freeze([{ type:'text', text:`${QUEUED_NOTIFICATION_TEXT}\n${url}` }]);
}

function eligiblePharmacist(row) {
  return Boolean(row?.status === 'active' && row.license_verified_at
    && typeof row.line_user_id === 'string' && row.line_user_id.trim()
    && typeof row.pharmacist_id === 'string' && row.pharmacist_id.trim());
}

function createConsultationPharmacistNotificationService({
  repository = createConsultationRepository(),
  enqueue = notificationService.enqueue,
  transaction = withTransaction,
  env = process.env,
} = {}) {
  async function notifyQueuedCase({ caseId } = {}) {
    const intent = buildConsultationNotificationIntent({type:'consultation_queued',caseId});
    const url = pharmacistConsoleUrl(env);
    const messages = queuedNotificationMessages(url);
    if (!messages) return {status:'configuration_unavailable',queued:0,duplicate:0};

    const rows = await repository.listEligiblePharmacists();
    const recipients = rows.filter(eligiblePharmacist);
    let queued=0;let duplicate=0;let skipped=rows.length-recipients.length;
    for (const pharmacist of recipients) {
      const dedupeKey=`${intent.dedupeKey}:pharmacist:${pharmacist.pharmacist_id}`;
      const result=await transaction(`notification-outbox:${dedupeKey}`,()=>enqueue({
        dedupeKey,to:pharmacist.line_user_id.trim(),messages,
        kind:'consultation_queued',meta:{caseId:intent.caseId,pharmacistId:pharmacist.pharmacist_id},
      }));
      if (result?.duplicate) duplicate+=1;
      else if (result?.ok) queued+=1;
      else skipped+=1;
    }
    return {status:'ready',queued,duplicate,skipped};
  }

  return { notifyQueuedCase };
}

module.exports={
  PHARMACIST_LIFF_ID_PATTERN,QUEUED_NOTIFICATION_TEXT,
  pharmacistConsoleUrl,queuedNotificationMessages,eligiblePharmacist,
  createConsultationPharmacistNotificationService,
};
