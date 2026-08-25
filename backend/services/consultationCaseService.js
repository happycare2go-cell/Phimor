const { randomUUID } = require('node:crypto');
const { withTransaction } = require('../db');
const { createConsultationRepository } = require('./consultationRepository');
const { createPharmacistAccountService } = require('./pharmacistAccountService');
const { materializeExpiredCaseInTransaction } = require('./consultationExpirationService');
const {
  CONSULTATION_DURATION_MINUTES,
  ConsultationDomainError,
  asInstant,
  effectiveConsultationState,
  assertProvisionedConsultationCase,
} = require('../domain/consultation');

function createConsultationCaseService({
  repository = createConsultationRepository(),
  transaction = withTransaction,
  pharmacistAccounts = null,
  eventId = () => `CEVT-${randomUUID()}`,
} = {}) {
  const accounts = pharmacistAccounts || createPharmacistAccountService({ repository });

  async function acceptCase({ caseId, pharmacistLineUserId } = {}) {
    if (typeof caseId !== 'string' || !caseId.trim()) {
      throw new ConsultationDomainError('CASE_REQUIRED');
    }
    return transaction(`consultation-accept:${caseId.trim()}`, async () => {
      const pharmacist = await accounts.requireActive(pharmacistLineUserId);
      const current = await repository.findCaseForUpdate(caseId.trim());
      if (!current) throw new ConsultationDomainError('CASE_NOT_FOUND', 404);
      assertProvisionedConsultationCase(current);
      if (current.state !== 'queued' || current.assigned_pharmacist_id) {
        throw new ConsultationDomainError('CASE_ALREADY_ACCEPTED', 409);
      }

      const accepted = await repository.acceptCase(current.case_id, pharmacist.pharmacistId);
      if (!accepted) throw new ConsultationDomainError('CASE_ALREADY_ACCEPTED', 409);
      const durationMs = asInstant(accepted.expires_at) - asInstant(accepted.accepted_at);
      if (durationMs !== CONSULTATION_DURATION_MINUTES * 60_000) {
        throw new ConsultationDomainError('INVALID_CONSULTATION_WINDOW', 500);
      }
      await repository.insertEvent({
        event_id: eventId(), case_id: accepted.case_id,
        event_type: 'accepted', actor_type: 'pharmacist',
        actor_id: pharmacist.pharmacistId,
        from_state: 'queued', to_state: 'active',
        metadata: {}, idempotency_key: `accepted:${accepted.case_id}`,
      });
      return accepted;
    });
  }

  async function resolveCase({caseId,pharmacistLineUserId}={}) {
    if (typeof caseId!=='string' || !caseId.trim()) throw new ConsultationDomainError('CASE_REQUIRED');
    const outcome=await transaction(`consultation-resolve:${caseId.trim()}`,async()=>{
      const pharmacist=await accounts.requireActive(pharmacistLineUserId);
      const current=await repository.findCaseForUpdate(caseId.trim());
      if (!current) throw new ConsultationDomainError('CASE_NOT_FOUND',404);
      assertProvisionedConsultationCase(current);
      if (current.assigned_pharmacist_id!==pharmacist.pharmacistId) {
        throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED',403);
      }
      if (effectiveConsultationState(current,current.database_now || new Date())==='closed') {
        if (current.state!=='closed') {
          await materializeExpiredCaseInTransaction({consultationCase:current,repository,eventId});
        }
        return {domainError:new ConsultationDomainError('CONSULTATION_EXPIRED',409)};
      }
      if (current.state==='resolved') return {case:current,duplicate:true};
      if (current.state!=='active') throw new ConsultationDomainError('CONSULTATION_NOT_ACTIVE',409);
      const resolved=await repository.updateCaseWorkflow(current.case_id,{state:'resolved',waitingOn:'none'});
      await repository.insertEvent({
        event_id:eventId(),case_id:current.case_id,event_type:'resolved',actor_type:'pharmacist',
        actor_id:pharmacist.pharmacistId,from_state:'active',to_state:'resolved',metadata:{},
        idempotency_key:`resolved:${current.case_id}:${resolved.resolved_at || resolved.updated_at}`,
      });
      return {case:resolved,duplicate:false};
    });
    if (outcome?.domainError) throw outcome.domainError;
    return outcome;
  }

  return { acceptCase,resolveCase };
}

const defaultService = createConsultationCaseService();
module.exports = {
  createConsultationCaseService,
  acceptConsultationCase: defaultService.acceptCase,
  resolveConsultationCase:defaultService.resolveCase,
};
