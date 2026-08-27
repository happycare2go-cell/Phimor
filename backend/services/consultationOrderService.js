const { randomUUID } = require('node:crypto');
const { withTransaction } = require('../db');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { createConsultationRepository } = require('./consultationRepository');
const { classifyConsultationSafety } = require('./consultationSafetyService');
const {
  CONSULTATION_PRICE_MINOR, CONSULTATION_CURRENCY, CONSULTATION_DURATION_MINUTES,
  ConsultationDomainError, normalizeQuestion,
} = require('../domain/consultation');

function validateTerms(termsAccepted, termsVersion) {
  if (termsAccepted !== true) throw new ConsultationDomainError('TERMS_ACCEPTANCE_REQUIRED');
  if (typeof termsVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(termsVersion)) {
    throw new ConsultationDomainError('INVALID_TERMS_VERSION');
  }
  return termsVersion;
}

function createConsultationOrderService({
  repository = createConsultationRepository(),
  authorize = authorizeCareProfileAccess,
  transaction = withTransaction,
  now = () => new Date().toISOString(),
  orderId = () => `CORD-${randomUUID()}`,
  safetyClassifier = classifyConsultationSafety,
} = {}) {
  function staleDraft(order, referenceTime) {
    if (order?.status !== 'draft' || !order.created_at) return false;
    const created = new Date(order.created_at).getTime();
    const reference = new Date(referenceTime).getTime();
    return Number.isFinite(created) && Number.isFinite(reference)
      && reference - created >= 10 * 60 * 1000;
  }

  function expiredPending(order, referenceTime) {
    if (order?.status !== 'payment_pending' || !order.payment_due_at) return false;
    const due = new Date(order.payment_due_at).getTime();
    const reference = new Date(referenceTime).getTime();
    return Number.isFinite(due) && Number.isFinite(reference) && due <= reference;
  }

  async function createDraft({
    lineUserId, careProfileId, initialQuestion, termsAccepted, termsVersion,
  } = {}) {
    if (typeof lineUserId !== 'string' || !lineUserId.trim()) throw new ConsultationDomainError('UNAUTHENTICATED', 401);
    if (typeof careProfileId !== 'string' || !careProfileId.trim()) throw new ConsultationDomainError('CARE_PROFILE_REQUIRED');
    const question = normalizeQuestion(initialQuestion);
    const safety = safetyClassifier(question);
    if (safety.action === 'emergency_block') {
      throw new ConsultationDomainError('EMERGENCY_BLOCKED', 409, safety.message);
    }
    if (safety.action !== 'pharmacist_consultation_eligible') {
      throw new ConsultationDomainError('CONSULTATION_SCOPE_UNSUPPORTED', 409);
    }
    const acceptedVersion = validateTerms(termsAccepted, termsVersion);
    return transaction(`consultation-order:${lineUserId.trim()}:${careProfileId.trim()}`, async () => {
      await authorize({
        lineUserId: lineUserId.trim(), careProfileId: careProfileId.trim(),
        permission: 'view', requireActiveCenter: true,
      });
      let existing = typeof repository.findActiveCheckoutForUpdate==='function'
        ? await repository.findActiveCheckoutForUpdate(lineUserId.trim(), careProfileId.trim()) : null;
      if (staleDraft(existing, now()) || expiredPending(existing, now())) {
        if (typeof repository.markOrderExpired==='function') await repository.markOrderExpired(existing.order_id);
        existing = null;
      }
      if (existing) return { ...existing, checkout_reused:true };

      const created = await repository.createOrder({
        order_id: orderId(), customer_line_user_id: lineUserId.trim(),
        care_profile_id: careProfileId.trim(), initial_question: question,
        amount_minor: CONSULTATION_PRICE_MINOR, currency: CONSULTATION_CURRENCY,
        duration_minutes: CONSULTATION_DURATION_MINUTES,
        terms_version: acceptedVersion, terms_accepted_at: now(),
      });
      if (created) return { ...created, checkout_reused:false };
      existing = typeof repository.findActiveCheckoutForUpdate==='function'
        ? await repository.findActiveCheckoutForUpdate(lineUserId.trim(), careProfileId.trim()) : null;
      if (!existing) throw new ConsultationDomainError('CHECKOUT_RESERVATION_FAILED', 409);
      return { ...existing, checkout_reused:true };
    });
  }

  return { createDraft };
}

const defaultService = createConsultationOrderService();
module.exports = {
  validateTerms, createConsultationOrderService,
  createConsultationDraftOrder: defaultService.createDraft,
};
