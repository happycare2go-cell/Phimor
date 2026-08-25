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
      return repository.createOrder({
        order_id: orderId(), customer_line_user_id: lineUserId.trim(),
        care_profile_id: careProfileId.trim(), initial_question: question,
        amount_minor: CONSULTATION_PRICE_MINOR, currency: CONSULTATION_CURRENCY,
        duration_minutes: CONSULTATION_DURATION_MINUTES,
        terms_version: acceptedVersion, terms_accepted_at: now(),
      });
    });
  }

  return { createDraft };
}

const defaultService = createConsultationOrderService();
module.exports = {
  validateTerms, createConsultationOrderService,
  createConsultationDraftOrder: defaultService.createDraft,
};
