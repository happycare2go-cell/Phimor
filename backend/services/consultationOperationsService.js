const { randomUUID } = require('node:crypto');
const { withTransaction } = require('../db');
const { createConsultationRepository } = require('./consultationRepository');
const { createPharmacistAccountService } = require('./pharmacistAccountService');
const {
  ConsultationDomainError,effectiveConsultationState,assertProvisionedConsultationCase,
}=require('../domain/consultation');

function createConsultationOperationsService({
  repository=createConsultationRepository(),transaction=withTransaction,
  pharmacistAccounts=null,eventId=()=>`CEVT-${randomUUID()}`,
}={}) {
  const accounts=pharmacistAccounts || createPharmacistAccountService({repository});

  async function reassignCase({caseId,toPharmacistLineUserId,operationalActorId}={}) {
    if (typeof caseId!=='string' || !caseId.trim()) throw new ConsultationDomainError('CASE_REQUIRED');
    if (typeof operationalActorId!=='string' || !operationalActorId.trim()) {
      throw new ConsultationDomainError('TRUSTED_OPERATIONAL_ACTOR_REQUIRED',403);
    }
    return transaction(`consultation-reassign:${caseId.trim()}`,async()=>{
      const target=await accounts.requireActive(toPharmacistLineUserId);
      const current=await repository.findCaseForUpdate(caseId.trim());
      if (!current) throw new ConsultationDomainError('CASE_NOT_FOUND',404);
      assertProvisionedConsultationCase(current);
      if (!current.assigned_pharmacist_id) throw new ConsultationDomainError('CASE_NOT_ASSIGNED',409);
      if (effectiveConsultationState(current,current.database_now || new Date())==='closed') {
        throw new ConsultationDomainError('CONSULTATION_EXPIRED',409);
      }
      if (current.assigned_pharmacist_id===target.pharmacistId) {
        return {case:current,duplicate:true};
      }
      const reassigned=await repository.reassignCase(current.case_id,target.pharmacistId);
      await repository.insertEvent({
        event_id:eventId(),case_id:current.case_id,event_type:'reassigned',actor_type:'admin',
        actor_id:operationalActorId.trim(),from_state:current.state,to_state:current.state,
        metadata:{fromPharmacistId:current.assigned_pharmacist_id,toPharmacistId:target.pharmacistId},
        idempotency_key:null,
      });
      return {case:reassigned,duplicate:false};
    });
  }

  return {reassignCase};
}

module.exports={createConsultationOperationsService};
