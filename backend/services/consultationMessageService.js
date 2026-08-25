const { randomUUID } = require('node:crypto');
const { withTransaction } = require('../db');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { createConsultationRepository } = require('./consultationRepository');
const { createPharmacistAccountService } = require('./pharmacistAccountService');
const {
  ConsultationDomainError,
  normalizeQuestion,
  normalizeIdempotencyKey,
  effectiveConsultationState,
} = require('../domain/consultation');

function validateActor(actor) {
  if (!actor || !['customer', 'pharmacist'].includes(actor.type)) {
    throw new ConsultationDomainError('INVALID_MESSAGE_ACTOR');
  }
  if (typeof actor.lineUserId !== 'string' || !actor.lineUserId.trim()) {
    throw new ConsultationDomainError('UNAUTHENTICATED', 401);
  }
  return { type: actor.type, lineUserId: actor.lineUserId.trim() };
}

function createConsultationMessageService({
  repository = createConsultationRepository(),
  transaction = withTransaction,
  authorize = authorizeCareProfileAccess,
  pharmacistAccounts = null,
  messageId = () => `CMSG-${randomUUID()}`,
  eventId = () => `CEVT-${randomUUID()}`,
} = {}) {
  const accounts = pharmacistAccounts || createPharmacistAccountService({ repository });

  async function authorizeSender(consultationCase, actor) {
    if (actor.type === 'customer') {
      if (consultationCase.customer_line_user_id !== actor.lineUserId) {
        throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED', 403);
      }
      await authorize({
        lineUserId: actor.lineUserId,
        careProfileId: consultationCase.care_profile_id,
        permission: 'view', requireActiveCenter: true,
      });
      return actor.lineUserId;
    }
    const pharmacist = await accounts.requireActive(actor.lineUserId);
    if (consultationCase.assigned_pharmacist_id !== pharmacist.pharmacistId) {
      throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED', 403);
    }
    return pharmacist.pharmacistId;
  }

  async function closeExpired(consultationCase) {
    const closed = await repository.updateCaseWorkflow(consultationCase.case_id, {
      state: 'closed', waitingOn: 'none',
      closedAt: consultationCase.database_now,
      closeReason: 'expired',
    });
    await repository.insertEvent({
      event_id: eventId(), case_id: consultationCase.case_id,
      event_type: 'closed', actor_type: 'system', actor_id: null,
      from_state: consultationCase.state, to_state: 'closed',
      metadata: { reason: 'expired' },
      idempotency_key: `closed:expired:${consultationCase.case_id}`,
    });
    return closed;
  }

  async function sendMessage({ caseId, actor: actorInput, body, idempotencyKey } = {}) {
    if (typeof caseId !== 'string' || !caseId.trim()) throw new ConsultationDomainError('CASE_REQUIRED');
    const actor = validateActor(actorInput);
    const normalizedBody = normalizeQuestion(body);
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey);

    const outcome = await transaction(`consultation-message:${caseId.trim()}`, async () => {
      const consultationCase = await repository.findCaseForUpdate(caseId.trim());
      if (!consultationCase) throw new ConsultationDomainError('CASE_NOT_FOUND', 404);

      const senderId = await authorizeSender(consultationCase, actor);
      const existing = await repository.findMessageByIdempotency(consultationCase.case_id, normalizedKey);
      if (existing) {
        if (existing.sender_type !== actor.type || existing.sender_id !== senderId) {
          throw new ConsultationDomainError('IDEMPOTENCY_KEY_CONFLICT', 409);
        }
        return { message: existing, duplicate: true };
      }

      const effectiveState = effectiveConsultationState(
        consultationCase,
        consultationCase.database_now || new Date()
      );
      if (effectiveState === 'closed') {
        if (consultationCase.state !== 'closed') await closeExpired(consultationCase);
        return { domainError: new ConsultationDomainError('CONSULTATION_EXPIRED', 409) };
      }
      if (effectiveState === 'queued') throw new ConsultationDomainError('CONSULTATION_NOT_ACCEPTED', 409);

      const inserted = await repository.insertMessage({
        message_id: messageId(), case_id: consultationCase.case_id,
        sender_type: actor.type, sender_id: senderId,
        body: normalizedBody, idempotency_key: normalizedKey,
      });
      if (!inserted.message) throw new ConsultationDomainError('MESSAGE_INSERT_FAILED', 500);

      if (!inserted.duplicate) {
        const nextState = actor.type === 'customer' ? 'active' : consultationCase.state;
        const nextWaitingOn = actor.type === 'customer' ? 'pharmacist' : 'customer';
        await repository.updateCaseWorkflow(consultationCase.case_id, {
          state: nextState, waitingOn: nextWaitingOn,
        });
        if (consultationCase.state === 'resolved' && actor.type === 'customer') {
          await repository.insertEvent({
            event_id: eventId(), case_id: consultationCase.case_id,
            event_type: 'reopened', actor_type: 'customer', actor_id: senderId,
            from_state: 'resolved', to_state: 'active', metadata: {},
            idempotency_key: `reopened:message:${inserted.message.message_id}`,
          });
        }
      }
      return inserted;
    });
    if (outcome && outcome.domainError) throw outcome.domainError;
    return outcome;
  }

  return { sendMessage };
}

const defaultService = createConsultationMessageService();
module.exports = {
  validateActor,
  createConsultationMessageService,
  sendConsultationMessage: defaultService.sendMessage,
};
