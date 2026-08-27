const notificationService=require('./notificationService');
const {createConsultationRepository}=require('./consultationRepository');
const {buildConsultationNotificationIntent}=require('./consultationNotificationEventService');

const LIFF_ID_PATTERN=/^[0-9A-Za-z][0-9A-Za-z_-]{2,127}$/;
const NEAR_EXPIRY_MILESTONE_MINUTES=120;

function liffUrl(liffId) {
  const clean=typeof liffId==='string'?liffId.trim():'';
  return LIFF_ID_PATTERN.test(clean)?`https://liff.line.me/${clean}`:null;
}

function lifecycleMessages(type,url) {
  if (!url) return null;
  const text={
    pharmacist_accepted:'เภสัชกรรับเคสแล้ว เปิดห้องแชทได้\n',
    new_consultation_message:'มีข้อความใหม่ในห้องปรึกษาเภสัชกร\n',
    consultation_expiring_soon:'การปรึกษาเภสัชกรเหลือเวลาอีกประมาณ 2 ชั่วโมง\n',
    consultation_closed:'การปรึกษาเภสัชกรสิ้นสุดแล้ว คุณยังเปิดอ่านข้อความย้อนหลังได้\n',
  }[type];
  return text?[{type:'text',text:`${text}${url}`}]:null;
}

function createConsultationLifecycleNotificationService({
  repository=createConsultationRepository(),enqueue=notificationService.enqueue,
  env=process.env,now=()=>new Date(),
}={}) {
  const familyUrl=()=>liffUrl(env.LIFF_ID_FAMILY);
  const pharmacistUrl=()=>liffUrl(env.LIFF_ID_PHARMACIST);
  const referenceDate=()=>{const value=now();return value instanceof Date?value:new Date(value);};
  async function enqueueIntent({intent,to,recipientRole,messages,kind}) {
    if (!to||!messages) return {status:'skipped'};
    const recipientSuffix=recipientRole.startsWith('pharmacist:')?recipientRole:'customer';
    const result=await enqueue({
      dedupeKey:`${intent.dedupeKey}:${recipientSuffix}`,to,messages,kind,
      meta:{caseId:intent.caseId,recipientRole:recipientRole.startsWith('pharmacist:')?'pharmacist':'customer'},
    });
    return result?.duplicate?{status:'duplicate'}:result?.ok?{status:'queued'}:{status:'skipped'};
  }

  async function enqueueDueNotifications({sinceHours=48,messageLimit=100}={}) {
    const since=new Date(referenceDate().getTime()-Math.max(1,Number(sinceHours)||48)*3600000).toISOString();
    const [accepted,closed,nearExpiry,unread]=await Promise.all([
      repository.listAcceptedNotificationCandidates(since),
      repository.listClosedNotificationCandidates(since),
      repository.listNearExpiryNotificationCandidates(NEAR_EXPIRY_MILESTONE_MINUTES),
      repository.listUnreadMessageNotificationCandidates(messageLimit),
    ]);
    const outcomes=[];
    for (const row of accepted) {
      const intent=buildConsultationNotificationIntent({type:'pharmacist_accepted',caseId:row.case_id});
      outcomes.push(await enqueueIntent({intent,to:row.customer_line_user_id,recipientRole:'customer',
        messages:lifecycleMessages('pharmacist_accepted',familyUrl()),kind:'consultation_accepted'}));
    }
    for (const row of unread) {
      const intent=buildConsultationNotificationIntent({type:'new_consultation_message',caseId:row.case_id,
        messageSequence:Number(row.message_sequence)});
      const pharmacistRecipient=row.waiting_on==='pharmacist';
      outcomes.push(await enqueueIntent({intent,
        to:pharmacistRecipient?row.pharmacist_line_user_id:row.customer_line_user_id,
        recipientRole:pharmacistRecipient?`pharmacist:${row.pharmacist_id}`:'customer',
        messages:lifecycleMessages('new_consultation_message',pharmacistRecipient?pharmacistUrl():familyUrl()),
        kind:'consultation_new_message'}));
    }
    for (const row of nearExpiry) {
      const intent=buildConsultationNotificationIntent({type:'consultation_expiring_soon',caseId:row.case_id,
        milestoneMinutes:NEAR_EXPIRY_MILESTONE_MINUTES});
      outcomes.push(await enqueueIntent({intent,to:row.customer_line_user_id,recipientRole:'customer',
        messages:lifecycleMessages('consultation_expiring_soon',familyUrl()),kind:'consultation_expiring_soon'}));
    }
    for (const row of closed) {
      const intent=buildConsultationNotificationIntent({type:'consultation_closed',caseId:row.case_id});
      outcomes.push(await enqueueIntent({intent,to:row.customer_line_user_id,recipientRole:'customer',
        messages:lifecycleMessages('consultation_closed',familyUrl()),kind:'consultation_closed'}));
    }
    return outcomes.reduce((summary,item)=>{
      summary[item.status]=(summary[item.status]||0)+1;return summary;
    },{queued:0,duplicate:0,skipped:0});
  }

  return {enqueueDueNotifications};
}

module.exports={LIFF_ID_PATTERN,NEAR_EXPIRY_MILESTONE_MINUTES,liffUrl,lifecycleMessages,
  createConsultationLifecycleNotificationService};
