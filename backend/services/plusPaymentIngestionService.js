const { randomUUID } = require('node:crypto');
const { withTransaction } = require('../db');
const { createPlusPaymentRepository } = require('./plusPaymentRepository');
const { createPlusPaymentEntitlementService } = require('./plusPaymentEntitlementService');
const { PLUS_PRICE_MINOR, PLUS_CURRENCY, PlusPaymentError } = require('../domain/plusPayment');

const TERMINAL_CODES = new Set([
  'PAYMENT_NOT_VERIFIED', 'PAYMENT_AMOUNT_MISMATCH', 'PAYMENT_CURRENCY_MISMATCH',
  'PAYMENT_EVENT_CONFLICT', 'PAYMENT_PROVIDER_MISMATCH', 'PAYMENT_CHECKOUT_MISMATCH',
]);

function normalizePlusPaymentEvent(event = {}) {
  for (const field of ['provider', 'providerEventId', 'providerPaymentId', 'providerCheckoutId', 'orderId']) {
    if (typeof event[field] !== 'string' || !event[field].trim()) throw new PlusPaymentError('INVALID_PAYMENT_EVENT');
  }
  if (!['payment_succeeded', 'payment_failed', 'payment_pending', 'payment_unknown'].includes(event.eventType)) {
    throw new PlusPaymentError('UNSUPPORTED_PAYMENT_EVENT');
  }
  const paidAt = event.paidAt ? new Date(event.paidAt) : null;
  if (paidAt && Number.isNaN(paidAt.getTime())) throw new PlusPaymentError('INVALID_PAYMENT_TIME');
  return Object.freeze({
    provider: event.provider.trim(), providerEventId: event.providerEventId.trim(),
    providerPaymentId: event.providerPaymentId.trim(), providerCheckoutId: event.providerCheckoutId.trim(),
    orderId: event.orderId.trim(), amountMinor: event.amountMinor,
    currency: String(event.currency || '').trim().toUpperCase(), eventType: event.eventType,
    verified: event.verified === true, signatureVerified: event.signatureVerified === true,
    paidAt: paidAt?.toISOString() || null,
    payloadHash: typeof event.payloadHash === 'string' && /^[a-f0-9]{64}$/i.test(event.payloadHash)
      ? event.payloadHash.toLowerCase() : null,
  });
}

function assertSamePayment(record, event) {
  if (!record || record.order_id !== event.orderId || record.provider !== event.provider
    || record.provider_event_id !== event.providerEventId
    || record.provider_payment_id !== event.providerPaymentId
    || record.provider_checkout_id !== event.providerCheckoutId
    || record.event_type !== event.eventType || record.amount_minor !== event.amountMinor
    || record.currency !== event.currency) throw new PlusPaymentError('PAYMENT_EVENT_CONFLICT', 409);
}

function createPlusPaymentIngestionService({
  repository = createPlusPaymentRepository(),
  transaction = withTransaction,
  entitlementService = null,
  paymentTransactionId = () => `PLUSPAY-${randomUUID()}`,
} = {}) {
  const entitlements = entitlementService || createPlusPaymentEntitlementService({ repository, transaction });

  async function ingestVerifiedEvent(input) {
    const event = normalizePlusPaymentEvent(input);
    if (!event.verified || !event.signatureVerified) throw new PlusPaymentError('PAYMENT_NOT_VERIFIED', 403);
    const result = await transaction(`plus-payment-event:${event.provider}:${event.providerEventId}`, () =>
      repository.ingestPaymentTransaction({
        payment_transaction_id: paymentTransactionId(), order_id: event.orderId,
        provider: event.provider, provider_event_id: event.providerEventId,
        provider_payment_id: event.providerPaymentId, provider_checkout_id: event.providerCheckoutId,
        event_type: event.eventType, amount_minor: event.amountMinor, currency: event.currency,
        payload_hash: event.payloadHash, provider_paid_at: event.paidAt,
      }));
    if (result.duplicate) assertSamePayment(result.transaction, event);
    return { event, transaction: result.transaction, duplicate: result.duplicate };
  }

  async function processIngestedEvent({ event, transaction: paymentTransaction, duplicate }) {
    if (paymentTransaction.processing_status === 'processed') {
      return { status: 'processed', duplicate: true, order: await repository.findOrder(event.orderId) };
    }
    try {
      if (event.amountMinor !== PLUS_PRICE_MINOR) throw new PlusPaymentError('PAYMENT_AMOUNT_MISMATCH', 409);
      if (event.currency !== PLUS_CURRENCY) throw new PlusPaymentError('PAYMENT_CURRENCY_MISMATCH', 409);
      if (event.eventType !== 'payment_succeeded') {
        if (event.eventType === 'payment_failed') await repository.markPaymentFailed(event.orderId);
        await repository.updatePaymentTransaction(paymentTransaction.payment_transaction_id, {
          status: 'processed', failureCode: event.eventType === 'payment_failed' ? 'PAYMENT_FAILED' : 'NO_STATE_CHANGE',
        });
        return { status: event.eventType === 'payment_failed' ? 'failed' : 'pending', duplicate };
      }
      const result = await entitlements.grantVerifiedPayment(event);
      await repository.updatePaymentTransaction(paymentTransaction.payment_transaction_id, {
        status: 'processed', failureCode: null,
      });
      return { status: 'processed', duplicate: duplicate || result.duplicate, ...result };
    } catch (error) {
      const terminal = TERMINAL_CODES.has(error?.code);
      await repository.updatePaymentTransaction(paymentTransaction.payment_transaction_id, {
        status: terminal ? 'rejected' : 'retry_required',
        failureCode: /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.code || '') ? error.code : 'PLUS_PAYMENT_PROCESSING_ERROR',
      });
      return { status: terminal ? 'rejected' : 'retry_required', errorCode: error?.code || 'PLUS_PAYMENT_PROCESSING_ERROR' };
    }
  }

  async function ingestAndProcess(event) {
    const durable = await ingestVerifiedEvent(event);
    return processIngestedEvent(durable);
  }

  return { ingestVerifiedEvent, processIngestedEvent, ingestAndProcess };
}

module.exports = {
  TERMINAL_CODES, normalizePlusPaymentEvent, assertSamePayment,
  createPlusPaymentIngestionService,
};
