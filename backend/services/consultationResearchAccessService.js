const { createConsultationRepository } = require('./consultationRepository');
const { createPharmacistAccountService } = require('./pharmacistAccountService');
const {
  ConsultationDomainError, effectiveConsultationState, assertProvisionedConsultationCase,
} = require('../domain/consultation');

function createConsultationResearchAccessService(overrides = {}) {
  const repository = overrides.repository || createConsultationRepository();
  const accounts = overrides.pharmacistAccounts || createPharmacistAccountService({ repository });

  return async function requireConsultationResearchAccess({ caseId, pharmacistLineUserId, now = new Date() } = {}) {
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
    return Object.freeze({
      pharmacistId:pharmacist.pharmacistId,
      state,
      databaseNow:consultationCase.database_now || now,
    });
  };
}

const requireConsultationResearchAccess = createConsultationResearchAccessService();

module.exports = { createConsultationResearchAccessService, requireConsultationResearchAccess };
