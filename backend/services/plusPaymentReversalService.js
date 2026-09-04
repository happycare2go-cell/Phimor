const { randomUUID } = require('node:crypto');
const { withTransaction } = require('../db');
const {
  PLUS_PAYMENT_REVERSAL_MODES,
  normalizePlusPaymentReversalMode,
} = require('../config/plusPaymentReversal');
const { PlusPaymentError } = require('../domain/plusPayment');
const { createPlusPaymentRepository } = require('./plusPaymentRepository');

const REVERSAL_EVENT_TYPES = Object.freeze({
  refund: 'payment_refund_reported',
  partial_refund: 'payment_partial_refund_reported',
  void: 'payment_void_reported',
  reversal: 'payment_reversal_reported',
  dispute: 'payment_dispute_reported',
  chargeback: 'payment_chargeback_reported',
});

function normalizeRequiredText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeVerifiedReversalEvent(input = {}) {
  const event = {};
  for (const field of [
    'provider', 'providerEventId', 'providerPaymentId', 'providerCheckoutId', 'orderId',
  ]) {
    event[field] = normalizeRequiredText(input[field]);
    if (!event[field]) throw new PlusPaymentError('INVALID_PAYMENT_REVERSAL_EVENT');
  }
  if (!/^[a-z0-9_-]{1,64}$/i.test(event.provider)
    || event.providerEventId.length > 160 || event.providerPaymentId.length > 160
    || event.providerCheckoutId.length > 160 || event.orderId.length > 80
    || [event.providerEventId, event.providerPaymentId, event.providerCheckoutId, event.orderId]
      .some((value) => !/^[\x21-\x7e]+$/.test(value))) {
    throw new PlusPaymentError('INVALID_PAYMENT_REVERSAL_EVENT');
  }
  event.reversalType = normalizeRequiredText(input.reversalType).toLowerCase();
  event.eventType = REVERSAL_EVENT_TYPES[event.reversalType];
  if (!event.eventType) throw new PlusPaymentError('UNSUPPORTED_PAYMENT_REVERSAL_EVENT');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new PlusPaymentError('INVALID_PAYMENT_REVERSAL_AMOUNT');
  }
  event.amountMinor = input.amountMinor;
  event.currency = normalizeRequiredText(input.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(event.currency)) throw new PlusPaymentError('INVALID_PAYMENT_REVERSAL_CURRENCY');
  if (input.verified !== true || input.signatureVerified !== true) {
    throw new PlusPaymentError('PAYMENT_NOT_VERIFIED', 403);
  }
  event.payloadHash = typeof input.payloadHash === 'string' && /^[a-f0-9]{64}$/i.test(input.payloadHash)
    ? input.payloadHash.toLowerCase() : null;
  return Object.freeze(event);
}

function assertSameReversal(record, event) {
  if (!record || record.order_id !== event.orderId || record.provider !== event.provider
    || record.provider_event_id !== event.providerEventId
    || record.provider_payment_id !== event.providerPaymentId
    || record.provider_checkout_id !== event.providerCheckoutId
    || record.event_type !== event.eventType || record.amount_minor !== event.amountMinor
    || record.currency !== event.currency) {
    throw new PlusPaymentError('PAYMENT_EVENT_CONFLICT', 409);
  }
}

function createPlusPaymentReversalService({
  repository = createPlusPaymentRepository(),
  transaction = withTransaction,
  reversalMode = () => process.env.PLUS_PAYMENT_REVERSAL_MODE,
  paymentTransactionId = () => `PLUSREV-${randomUUID()}`,
  operationalLogger = console.info,
} = {}) {
  async function recordVerifiedReversalForManualReview(input) {
    const event = normalizeVerifiedReversalEvent(input);
    if (normalizePlusPaymentReversalMode(reversalMode()) !== PLUS_PAYMENT_REVERSAL_MODES.MANUAL_REVIEW) {
      throw new PlusPaymentError('PAYMENT_REVERSAL_MODE_NOT_CONFIGURED', 503);
    }

    return transaction(`plus-payment-event:${event.provider}:${event.providerEventId}`, async () => {
      const order = await repository.findOrderForUpdate(event.orderId);
      if (!order) throw new PlusPaymentError('PLUS_ORDER_NOT_FOUND', 404);
      if (order.provider !== event.provider) throw new PlusPaymentError('PAYMENT_PROVIDER_MISMATCH', 409);
      if (order.provider_checkout_id !== event.providerCheckoutId) {
        throw new PlusPaymentError('PAYMENT_CHECKOUT_MISMATCH', 409);
      }
      const original = await repository.findSuccessfulPaymentTransaction(event.orderId);
      if (!original) throw new PlusPaymentError('ORIGINAL_SUCCESSFUL_PAYMENT_NOT_FOUND', 409);
      if (original.provider !== event.provider
        || original.provider_payment_id !== event.providerPaymentId
        || original.provider_checkout_id !== event.providerCheckoutId) {
        throw new PlusPaymentError('PAYMENT_REVERSAL_ORIGINAL_MISMATCH', 409);
      }
      if (original.currency !== event.currency || event.amountMinor > original.amount_minor) {
        throw new PlusPaymentError('PAYMENT_REVERSAL_AMOUNT_MISMATCH', 409);
      }
      const result = await repository.ingestPaymentTransaction({
        payment_transaction_id: paymentTransactionId(),
        order_id: event.orderId,
        provider: event.provider,
        provider_event_id: event.providerEventId,
        provider_payment_id: event.providerPaymentId,
        provider_checkout_id: event.providerCheckoutId,
        event_type: event.eventType,
        amount_minor: event.amountMinor,
        currency: event.currency,
        payload_hash: event.payloadHash,
        provider_paid_at: null,
        failure_code: 'MANUAL_REVIEW_REQUIRED',
      });
      if (result.duplicate) assertSameReversal(result.transaction, event);
      if (!result.duplicate && typeof operationalLogger === 'function') {
        operationalLogger({
          event: 'plus_payment_reversal_manual_review_required',
          eventType: event.eventType,
          policyMode: PLUS_PAYMENT_REVERSAL_MODES.MANUAL_REVIEW,
        });
      }
      return Object.freeze({
        status: 'manual_review_required',
        duplicate: result.duplicate,
        eventType: event.eventType,
        entitlementChanged: false,
      });
    });
  }

  return { recordVerifiedReversalForManualReview };
}

module.exports = {
  REVERSAL_EVENT_TYPES,
  normalizeVerifiedReversalEvent,
  assertSameReversal,
  createPlusPaymentReversalService,
};
