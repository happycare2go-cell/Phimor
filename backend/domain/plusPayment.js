const PLUS_PLAN_ID = 'plus_30d_v1';
const PLUS_PRICE_MINOR = 5_900;
const PLUS_CURRENCY = 'THB';
const PLUS_DURATION_DAYS = 30;
const PLUS_DURATION_MINUTES = PLUS_DURATION_DAYS * 24 * 60;

const PLUS_ORDER_STATES = Object.freeze([
  'draft', 'payment_pending', 'paid', 'failed', 'expired', 'cancelled',
]);
const PLUS_FULFILLMENT_STATES = Object.freeze(['pending', 'granted', 'error']);
const PLUS_RETURN_TARGETS = Object.freeze([
  'lab_explanation',
  'doctor_question_prep',
  'doctor_visit_organization',
  'plus_home',
]);

class PlusPaymentError extends Error {
  constructor(code, status = 400, message = 'ไม่สามารถดำเนินการพี่หมอ Plus ได้') {
    super(message);
    this.name = 'PlusPaymentError';
    this.code = code;
    this.status = status;
  }
}

function normalizeReturnTarget(value) {
  const target = typeof value === 'string' ? value.trim() : '';
  if (!PLUS_RETURN_TARGETS.includes(target)) throw new PlusPaymentError('INVALID_RETURN_TARGET');
  return target;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value)) {
    throw new PlusPaymentError('INVALID_IDEMPOTENCY_KEY');
  }
  return value;
}

function assertFixedPlusPurchase({ planId, amountMinor, currency }) {
  if (planId !== PLUS_PLAN_ID) throw new PlusPaymentError('PLUS_PLAN_MISMATCH');
  if (amountMinor !== PLUS_PRICE_MINOR) throw new PlusPaymentError('PAYMENT_AMOUNT_MISMATCH');
  if (currency !== PLUS_CURRENCY) throw new PlusPaymentError('PAYMENT_CURRENCY_MISMATCH');
}

function addEntitlementDays(value, days = PLUS_DURATION_DAYS) {
  const start = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(start.getTime())) throw new PlusPaymentError('INVALID_PAYMENT_TIME');
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
}

module.exports = {
  PLUS_PLAN_ID,
  PLUS_PRICE_MINOR,
  PLUS_CURRENCY,
  PLUS_DURATION_DAYS,
  PLUS_DURATION_MINUTES,
  PLUS_ORDER_STATES,
  PLUS_FULFILLMENT_STATES,
  PLUS_RETURN_TARGETS,
  PlusPaymentError,
  normalizeReturnTarget,
  normalizeIdempotencyKey,
  assertFixedPlusPurchase,
  addEntitlementDays,
};
