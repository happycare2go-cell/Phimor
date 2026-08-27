const { withTransaction } = require('../db');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { createConsultationRepository } = require('./consultationRepository');
const { createPharmacistAccountService } = require('./pharmacistAccountService');
const { consultationRealtimeBus } = require('./consultationRealtimeBus');
const { ConsultationDomainError, assertProvisionedConsultationCase } = require('../domain/consultation');

function normalizeReadSequence(value) {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new ConsultationDomainError('INVALID_READ_SEQUENCE');
  }
  return sequence;
}

function createConsultationReadReceiptService({
  repository = createConsultationRepository(),
  transaction = withTransaction,
  authorize = authorizeCareProfileAccess,
  pharmacistAccounts = null,
  realtime = consultationRealtimeBus,
} = {}) {
  const accounts = pharmacistAccounts || createPharmacistAccountService({ repository });

  async function authorizeReader(consultationCase, actor) {
    if (actor.type === 'customer') {
      if (consultationCase.customer_line_user_id !== actor.lineUserId) {
        throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED', 403);
      }
      await authorize({
        lineUserId: actor.lineUserId,
        careProfileId: consultationCase.care_profile_id,
        permission: 'view',
        requireActiveCenter: true,
      });
      return;
    }
    if (actor.type === 'pharmacist') {
      const pharmacist = await accounts.requireActive(actor.lineUserId);
      if (consultationCase.assigned_pharmacist_id !== pharmacist.pharmacistId) {
        throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED', 403);
      }
      return;
    }
    throw new ConsultationDomainError('INVALID_MESSAGE_ACTOR');
  }

  async function markRead({ caseId, actor, sequence: inputSequence } = {}) {
    if (typeof caseId !== 'string' || !caseId.trim()) throw new ConsultationDomainError('CASE_REQUIRED');
    if (!actor || !['customer', 'pharmacist'].includes(actor.type)
        || typeof actor.lineUserId !== 'string' || !actor.lineUserId.trim()) {
      throw new ConsultationDomainError('UNAUTHENTICATED', 401);
    }
    const sequence = normalizeReadSequence(inputSequence);
    const outcome = await transaction(`consultation-read:${caseId.trim()}`, async () => {
      const consultationCase = await repository.findCaseForUpdate(caseId.trim());
      if (!consultationCase) throw new ConsultationDomainError('CASE_NOT_FOUND', 404);
      assertProvisionedConsultationCase(consultationCase);
      await authorizeReader(consultationCase, actor);
      if (consultationCase.state === 'queued') {
        throw new ConsultationDomainError('CONSULTATION_NOT_ACCEPTED', 409);
      }
      const lastSequence = await repository.getLastMessageSequence(consultationCase.case_id);
      if (sequence > lastSequence) throw new ConsultationDomainError('CONSULTATION_READ_SEQUENCE_AHEAD', 409);
      const field = actor.type === 'customer'
        ? 'customer_last_read_sequence' : 'pharmacist_last_read_sequence';
      const previous = Number(consultationCase[field] || 0);
      const next = Math.max(previous, sequence);
      const updated = next === previous
        ? consultationCase
        : await repository.updateReadSequence(consultationCase.case_id, actor.type, next);
      return { caseId: consultationCase.case_id, reader: actor.type, sequence: next, changed: next > previous, updated };
    });
    if (outcome.changed) {
      try {
        await realtime.publish({
          eventType: 'read.updated',
          caseId: outcome.caseId,
          reader: outcome.reader,
          sequence: outcome.sequence,
        });
      } catch (_) { /* read persistence remains authoritative */ }
    }
    return Object.freeze({ reader: outcome.reader, sequence: outcome.sequence, changed: outcome.changed });
  }

  return { markRead };
}

module.exports = { normalizeReadSequence, createConsultationReadReceiptService };
