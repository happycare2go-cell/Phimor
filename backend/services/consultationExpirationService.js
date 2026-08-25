const { randomUUID } = require('node:crypto');
const { withTransaction } = require('../db');
const { createConsultationRepository } = require('./consultationRepository');
const { effectiveConsultationState, ConsultationDomainError } = require('../domain/consultation');

async function materializeExpiredCaseInTransaction({consultationCase,repository,eventId}) {
  if (!consultationCase) throw new ConsultationDomainError('CASE_NOT_FOUND',404);
  if (consultationCase.state==='closed') return {case:consultationCase,changed:false};
  const databaseNow=consultationCase.database_now || new Date().toISOString();
  if (effectiveConsultationState(consultationCase,databaseNow)!=='closed') {
    return {case:consultationCase,changed:false};
  }
  const closed=await repository.updateCaseWorkflow(consultationCase.case_id,{
    state:'closed',waitingOn:'none',closedAt:databaseNow,closeReason:'expired',
  });
  await repository.insertEvent({
    event_id:eventId(),case_id:consultationCase.case_id,event_type:'closed',
    actor_type:'system',actor_id:null,from_state:consultationCase.state,to_state:'closed',
    metadata:{reason:'expired'},idempotency_key:`closed:expired:${consultationCase.case_id}`,
  });
  return {case:closed,changed:true};
}

function createConsultationExpirationService({
  repository=createConsultationRepository(),transaction=withTransaction,
  eventId=()=>`CEVT-${randomUUID()}`,
}={}) {
  async function materializeCase(caseId) {
    if (typeof caseId!=='string' || !caseId.trim()) throw new ConsultationDomainError('CASE_REQUIRED');
    return transaction(`consultation-expire:${caseId.trim()}`,async()=>{
      const consultationCase=await repository.findCaseForUpdate(caseId.trim());
      return materializeExpiredCaseInTransaction({consultationCase,repository,eventId});
    });
  }

  async function sweepExpired({limit=100}={}) {
    const bounded=Number.isSafeInteger(Number(limit)) ? Math.min(500,Math.max(1,Number(limit))) : 100;
    const caseIds=await repository.listExpiredCaseIds(bounded);
    let closed=0;
    for (const caseId of caseIds) {
      const result=await materializeCase(caseId);
      if (result.changed) closed+=1;
    }
    return {scanned:caseIds.length,closed};
  }

  return {materializeCase,sweepExpired};
}

module.exports={materializeExpiredCaseInTransaction,createConsultationExpirationService};
