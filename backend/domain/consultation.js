const CONSULTATION_PRICE_MINOR = 10_000;
const CONSULTATION_CURRENCY = 'THB';
const CONSULTATION_DURATION_MINUTES = 1_440;
const CONSULTATION_MESSAGE_MAX_LENGTH = 4_000;

const ORDER_STATES = Object.freeze(['draft', 'payment_pending', 'paid', 'failed', 'expired']);
const PAYMENT_PROCESSING_STATES = Object.freeze([
  'received', 'verified', 'processed', 'retry_required', 'rejected', 'error',
]);
const CONSULTATION_STATES = Object.freeze(['queued', 'active', 'resolved', 'closed']);
const WAITING_ON_VALUES = Object.freeze(['none', 'customer', 'pharmacist']);
const MESSAGE_SENDER_TYPES = Object.freeze(['customer', 'pharmacist', 'system']);
const EVENT_ACTOR_TYPES = Object.freeze(['customer', 'pharmacist', 'system', 'payment', 'admin']);
const PHARMACIST_STATUSES = Object.freeze(['invited', 'active', 'suspended', 'inactive']);

const WAITING_ON_SEMANTICS = Object.freeze({
  pharmacist: 'next_expected_action_from_pharmacist',
  customer: 'next_expected_action_from_customer',
  none: 'no_pending_response_expectation',
});

class ConsultationDomainError extends Error {
  constructor(code, status = 400, message = 'ไม่สามารถดำเนินการคำปรึกษานี้ได้') {
    super(message);
    this.name = 'ConsultationDomainError';
    this.code = code;
    this.status = status;
  }
}

function normalizeQuestion(value) {
  if (typeof value !== 'string') throw new ConsultationDomainError('QUESTION_REQUIRED');
  const question = value.normalize('NFC').trim();
  if (!question) throw new ConsultationDomainError('QUESTION_REQUIRED');
  if (question.length > CONSULTATION_MESSAGE_MAX_LENGTH) throw new ConsultationDomainError('QUESTION_TOO_LONG');
  return question;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value)) {
    throw new ConsultationDomainError('INVALID_IDEMPOTENCY_KEY');
  }
  return value;
}

function asInstant(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ConsultationDomainError('INVALID_TIME');
  return date;
}

function effectiveConsultationState(consultationCase, at = new Date()) {
  if (!consultationCase) throw new ConsultationDomainError('CASE_NOT_FOUND', 404);
  if (consultationCase.state === 'closed') return 'closed';
  if (!consultationCase.expires_at) return consultationCase.state;
  return asInstant(at).getTime() >= asInstant(consultationCase.expires_at).getTime()
    ? 'closed' : consultationCase.state;
}

function assertFixedPurchase({ amountMinor, currency, durationMinutes }) {
  if (amountMinor !== CONSULTATION_PRICE_MINOR) throw new ConsultationDomainError('PAYMENT_AMOUNT_MISMATCH');
  if (currency !== CONSULTATION_CURRENCY) throw new ConsultationDomainError('PAYMENT_CURRENCY_MISMATCH');
  if (durationMinutes !== CONSULTATION_DURATION_MINUTES) throw new ConsultationDomainError('CONSULTATION_DURATION_MISMATCH');
}

function messageWorkflowTransition(currentState, senderType) {
  if (!['customer', 'pharmacist'].includes(senderType)) {
    throw new ConsultationDomainError('INVALID_MESSAGE_ACTOR');
  }
  return Object.freeze({
    state: currentState === 'resolved' ? 'active' : currentState,
    waitingOn: senderType === 'customer' ? 'pharmacist' : 'customer',
    reopened: currentState === 'resolved',
  });
}

function assertWaitingOnInvariant(state, waitingOn) {
  if ((state === 'queued' || state === 'resolved' || state === 'closed') && waitingOn !== 'none') {
    throw new ConsultationDomainError('INVALID_WAITING_ON_STATE');
  }
  if (state === 'active' && !['customer', 'pharmacist'].includes(waitingOn)) {
    throw new ConsultationDomainError('INVALID_WAITING_ON_STATE');
  }
}

function assertProvisionedConsultationCase(consultationCase) {
  if (!consultationCase
    || consultationCase.order_status !== 'paid'
    || consultationCase.provisioning_status !== 'provisioned') {
    throw new ConsultationDomainError('CONSULTATION_NOT_PROVISIONED', 409);
  }
}

module.exports = {
  CONSULTATION_PRICE_MINOR, CONSULTATION_CURRENCY, CONSULTATION_DURATION_MINUTES,
  CONSULTATION_MESSAGE_MAX_LENGTH, ORDER_STATES, PAYMENT_PROCESSING_STATES,
  CONSULTATION_STATES, WAITING_ON_VALUES, MESSAGE_SENDER_TYPES, EVENT_ACTOR_TYPES,
  PHARMACIST_STATUSES, WAITING_ON_SEMANTICS, ConsultationDomainError,
  normalizeQuestion, normalizeIdempotencyKey, asInstant,
  effectiveConsultationState, assertFixedPurchase,
  messageWorkflowTransition, assertWaitingOnInvariant,
  assertProvisionedConsultationCase,
};
