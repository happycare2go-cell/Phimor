const { randomUUID } = require('node:crypto');
const { withTransaction } = require('../db');
const { createConsultationRepository } = require('./consultationRepository');
const { createConsultationPaymentService } = require('./consultationPaymentService');
const {
  ConsultationDomainError, CONSULTATION_PRICE_MINOR, CONSULTATION_CURRENCY,
} = require('../domain/consultation');

const PAYMENT_EVENT_TYPES = Object.freeze([
  'payment_succeeded', 'payment_failed', 'payment_pending', 'payment_unknown',
]);
const NON_RETRYABLE_CODES = new Set([
  'PAYMENT_NOT_VERIFIED', 'PAYMENT_AMOUNT_MISMATCH', 'PAYMENT_CURRENCY_MISMATCH',
  'PAYMENT_EVENT_CONFLICT', 'PAYMENT_PROVIDER_MISMATCH', 'PAYMENT_CHECKOUT_MISMATCH',
  'PAYMENT_REFERENCE_REQUIRED',
]);

function normalizeIncomingPaymentEvent(event = {}) {
  for (const field of ['provider','providerEventId','orderId']) {
    if (typeof event[field] !== 'string' || !event[field].trim()) {
      throw new ConsultationDomainError('INVALID_PAYMENT_EVENT');
    }
  }
  if (!PAYMENT_EVENT_TYPES.includes(event.eventType)) {
    throw new ConsultationDomainError('UNSUPPORTED_PAYMENT_EVENT');
  }
  const paidAt = event.paidAt ? new Date(event.paidAt) : null;
  if (paidAt && Number.isNaN(paidAt.getTime())) throw new ConsultationDomainError('INVALID_PAYMENT_TIME');
  return Object.freeze({
    provider:event.provider.trim(),
    providerEventId:event.providerEventId.trim(),
    providerPaymentId:typeof event.providerPaymentId === 'string' ? event.providerPaymentId.trim() || null : null,
    providerCheckoutId:typeof event.providerCheckoutId === 'string' ? event.providerCheckoutId.trim() || null : null,
    orderId:event.orderId.trim(),
    amountMinor:event.amountMinor,
    currency:typeof event.currency === 'string' ? event.currency.trim().toUpperCase() : event.currency,
    eventType:event.eventType,
    verified:event.verified === true,
    signatureVerified:event.signatureVerified === true,
    paidAt:paidAt ? paidAt.toISOString() : null,
    payloadHash:typeof event.payloadHash === 'string' && /^[a-f0-9]{64}$/i.test(event.payloadHash)
      ? event.payloadHash.toLowerCase() : null,
  });
}

function assertIncomingEventMatches(record, event) {
  if (!record
    || record.provider !== event.provider
    || record.provider_event_id !== event.providerEventId
    || record.order_id !== event.orderId
    || record.amount_minor !== event.amountMinor
    || record.currency !== event.currency
    || record.event_type !== event.eventType
    || record.provider_payment_id !== event.providerPaymentId) {
    throw new ConsultationDomainError('PAYMENT_EVENT_CONFLICT', 409);
  }
}

function createConsultationPaymentIngestionService({
  repository = createConsultationRepository(),
  transaction = withTransaction,
  provisioner = null,
  paymentTransactionId = () => `PAYTX-${randomUUID()}`,
} = {}) {
  const paymentService = provisioner || createConsultationPaymentService({ repository, transaction });

  async function ingestVerifiedEvent(eventInput) {
    const event = normalizeIncomingPaymentEvent(eventInput);
    return transaction(`consultation-payment-event:${event.provider}:${event.providerEventId}`, async () => {
      const result = await repository.ingestPaymentTransaction({
        payment_transaction_id:paymentTransactionId(),
        order_id:event.orderId,
        provider:event.provider,
        provider_event_id:event.providerEventId,
        provider_payment_id:event.providerPaymentId,
        provider_checkout_id:event.providerCheckoutId,
        event_type:event.eventType,
        processing_status:event.signatureVerified ? 'verified' : 'rejected',
        amount_minor:event.amountMinor,
        currency:event.currency,
        signature_verified:event.signatureVerified,
        payload_hash:event.payloadHash,
        provider_paid_at:event.paidAt,
      });
      if (result.duplicate) assertIncomingEventMatches(result.transaction, event);
      if (!event.verified || !event.signatureVerified) {
        if (!result.duplicate || result.transaction.signature_verified !== true) {
          await repository.updatePaymentTransaction(result.transaction.payment_transaction_id, {
            processing_status:'rejected', processed_at:new Date().toISOString(),
            failure_code:'INVALID_PAYMENT_SIGNATURE',
          });
        }
        return { event, transaction:result.transaction, duplicate:result.duplicate,
          status:'rejected', errorCode:'INVALID_PAYMENT_SIGNATURE' };
      }
      const transactionRecord = result.duplicate && result.transaction.signature_verified !== true
        ? await repository.markPaymentTransactionVerified(result.transaction.payment_transaction_id)
        : result.transaction;
      return { event, transaction:transactionRecord, duplicate:result.duplicate, status:'verified' };
    });
  }

  async function markProcessingResult(paymentTransactionIdValue, status, failureCode = null) {
    return transaction(`consultation-payment-transaction:${paymentTransactionIdValue}`, () =>
      repository.updatePaymentTransaction(paymentTransactionIdValue, {
        processing_status:status,
        processed_at:['processed','rejected'].includes(status) ? new Date().toISOString() : null,
        failure_code:failureCode,
      }));
  }

  async function processNonSuccess(event, transactionRecord) {
    return transaction(`consultation-payment:${event.orderId}`, async () => {
      const order = await repository.findOrderForUpdate(event.orderId);
      if (!order) {
        await repository.updatePaymentTransaction(transactionRecord.payment_transaction_id, {
          processing_status:'retry_required', processed_at:null, failure_code:'ORDER_NOT_FOUND',
        });
        return { status:'retry_required', errorCode:'ORDER_NOT_FOUND' };
      }
      if (order.provider && order.provider !== event.provider) {
        await repository.updatePaymentTransaction(transactionRecord.payment_transaction_id, {
          processing_status:'rejected', processed_at:new Date().toISOString(), failure_code:'PAYMENT_PROVIDER_MISMATCH',
        });
        return { status:'rejected', errorCode:'PAYMENT_PROVIDER_MISMATCH' };
      }
      if (order.provider_checkout_id && order.provider_checkout_id !== event.providerCheckoutId) {
        await repository.updatePaymentTransaction(transactionRecord.payment_transaction_id, {
          processing_status:'rejected', processed_at:new Date().toISOString(), failure_code:'PAYMENT_CHECKOUT_MISMATCH',
        });
        return { status:'rejected', errorCode:'PAYMENT_CHECKOUT_MISMATCH' };
      }
      if (event.amountMinor !== order.amount_minor || event.amountMinor !== CONSULTATION_PRICE_MINOR) {
        await repository.updatePaymentTransaction(transactionRecord.payment_transaction_id, {
          processing_status:'rejected', processed_at:new Date().toISOString(), failure_code:'PAYMENT_AMOUNT_MISMATCH',
        });
        return { status:'rejected', errorCode:'PAYMENT_AMOUNT_MISMATCH' };
      }
      if (event.currency !== order.currency || event.currency !== CONSULTATION_CURRENCY) {
        await repository.updatePaymentTransaction(transactionRecord.payment_transaction_id, {
          processing_status:'rejected', processed_at:new Date().toISOString(), failure_code:'PAYMENT_CURRENCY_MISMATCH',
        });
        return { status:'rejected', errorCode:'PAYMENT_CURRENCY_MISMATCH' };
      }
      if (order.status === 'paid') {
        await repository.updatePaymentTransaction(transactionRecord.payment_transaction_id, {
          processing_status:'processed', processed_at:new Date().toISOString(), failure_code:'IGNORED_AFTER_PAID',
        });
        return { status:'ignored', reasonCode:'PAID_ORDER_NOT_DOWNGRADED', order };
      }
      if (event.eventType === 'payment_failed') await repository.markOrderPaymentFailed(order.order_id);
      await repository.updatePaymentTransaction(transactionRecord.payment_transaction_id, {
        processing_status:'processed', processed_at:new Date().toISOString(),
        failure_code:event.eventType === 'payment_failed' ? 'PAYMENT_FAILED' : 'NO_STATE_CHANGE',
      });
      return { status:event.eventType === 'payment_failed' ? 'failed' : 'ignored', order };
    });
  }

  async function processIngestedEvent({ event, transaction:transactionRecord, status }) {
    if (status === 'rejected') return { status, errorCode:'INVALID_PAYMENT_SIGNATURE' };
    if (transactionRecord.processing_status === 'processed') {
      const order = await repository.findOrder(event.orderId);
      const consultationCase = await repository.findCaseByOrderId(event.orderId);
      return { status:'processed', duplicate:true, order, consultationCase };
    }
    if (event.eventType !== 'payment_succeeded') return processNonSuccess(event, transactionRecord);
    try {
      const result = await paymentService.provisionVerifiedPayment({
        ...event, verified:true, signatureVerified:true,
        paidAt:event.paidAt || transactionRecord.provider_paid_at || transactionRecord.received_at,
      });
      return { status:'processed', ...result };
    } catch (error) {
      const retryable = !NON_RETRYABLE_CODES.has(error?.code);
      await markProcessingResult(
        transactionRecord.payment_transaction_id,
        retryable ? 'retry_required' : 'rejected',
        error?.code || 'PAYMENT_PROCESSING_ERROR'
      );
      return { status:retryable ? 'retry_required' : 'rejected', errorCode:error?.code || 'PAYMENT_PROCESSING_ERROR' };
    }
  }

  async function ingestAndProcess({ provider, eventEnvelope }) {
    if (!provider || typeof provider.verifyWebhook !== 'function') {
      throw new ConsultationDomainError('PAYMENT_PROVIDER_REQUIRED');
    }
    const verified = await provider.verifyWebhook(eventEnvelope);
    const ingested = await ingestVerifiedEvent(verified);
    return processIngestedEvent(ingested);
  }

  async function processStoredEvent({ provider, providerEventId }) {
    const record = await repository.findPaymentTransaction(provider, providerEventId);
    if (!record) throw new ConsultationDomainError('PAYMENT_EVENT_NOT_FOUND', 404);
    const event = normalizeIncomingPaymentEvent({
      verified:record.signature_verified, signatureVerified:record.signature_verified,
      provider:record.provider, providerEventId:record.provider_event_id,
      providerPaymentId:record.provider_payment_id, orderId:record.order_id,
      providerCheckoutId:record.provider_checkout_id,
      amountMinor:record.amount_minor, currency:record.currency,
      eventType:record.event_type, paidAt:record.provider_paid_at || record.received_at,
      payloadHash:record.payload_hash,
    });
    return processIngestedEvent({event, transaction:record, status:record.processing_status});
  }

  return { ingestVerifiedEvent, processIngestedEvent, ingestAndProcess, processStoredEvent };
}

module.exports = {
  PAYMENT_EVENT_TYPES, NON_RETRYABLE_CODES,
  normalizeIncomingPaymentEvent, assertIncomingEventMatches,
  createConsultationPaymentIngestionService,
};
