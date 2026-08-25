const { randomUUID } = require('node:crypto');
const { withTransaction } = require('../db');
const { createConsultationRepository } = require('./consultationRepository');
const {
  CONSULTATION_PRICE_MINOR, CONSULTATION_CURRENCY, CONSULTATION_DURATION_MINUTES,
  ConsultationDomainError, assertFixedPurchase,
} = require('../domain/consultation');

function normalizeVerifiedPayment(event = {}) {
  if (event.verified !== true || event.signatureVerified !== true) {
    throw new ConsultationDomainError('PAYMENT_NOT_VERIFIED', 403);
  }
  const required = ['provider', 'providerEventId', 'orderId'];
  for (const field of required) {
    if (typeof event[field] !== 'string' || !event[field].trim()) {
      throw new ConsultationDomainError('INVALID_PAYMENT_EVENT');
    }
  }
  if (event.eventType !== 'payment_succeeded') throw new ConsultationDomainError('PAYMENT_NOT_SUCCESSFUL');
  const paidAt = new Date(event.paidAt || Date.now());
  if (Number.isNaN(paidAt.getTime())) throw new ConsultationDomainError('INVALID_PAYMENT_TIME');
  return Object.freeze({
    provider: event.provider.trim(), providerEventId: event.providerEventId.trim(),
    providerPaymentId: typeof event.providerPaymentId === 'string' ? event.providerPaymentId.trim() : null,
    orderId: event.orderId.trim(), amountMinor: event.amountMinor,
    currency: event.currency, eventType: 'payment_succeeded',
    paidAt: paidAt.toISOString(),
    payloadHash: typeof event.payloadHash === 'string' && /^[a-f0-9]{64}$/i.test(event.payloadHash)
      ? event.payloadHash.toLowerCase() : null,
  });
}

function assertDuplicatePaymentMatches(transactionRecord, payment) {
  if (!transactionRecord
    || transactionRecord.order_id !== payment.orderId
    || transactionRecord.provider !== payment.provider
    || transactionRecord.amount_minor !== payment.amountMinor
    || transactionRecord.currency !== payment.currency) {
    throw new ConsultationDomainError('PAYMENT_EVENT_CONFLICT', 409);
  }
}

function createConsultationPaymentService({
  repository = createConsultationRepository(), transaction = withTransaction,
  paymentTransactionId = () => `PAYTX-${randomUUID()}`,
  caseId = () => `CCASE-${randomUUID()}`,
  eventId = () => `CEVT-${randomUUID()}`,
} = {}) {
  async function provisionVerifiedPayment(input) {
    const payment = normalizeVerifiedPayment(input);
    assertFixedPurchase({
      amountMinor: payment.amountMinor, currency: payment.currency,
      durationMinutes: CONSULTATION_DURATION_MINUTES,
    });
    return transaction(`consultation-payment:${payment.orderId}`, async () => {
      const order = await repository.findOrderForUpdate(payment.orderId);
      if (!order) throw new ConsultationDomainError('ORDER_NOT_FOUND', 404);
      assertFixedPurchase({
        amountMinor: order.amount_minor, currency: order.currency,
        durationMinutes: order.duration_minutes,
      });
      if (payment.amountMinor !== order.amount_minor) throw new ConsultationDomainError('PAYMENT_AMOUNT_MISMATCH');
      if (payment.currency !== order.currency) throw new ConsultationDomainError('PAYMENT_CURRENCY_MISMATCH');

      const paymentRecord = await repository.insertPaymentTransaction({
        payment_transaction_id: paymentTransactionId(), order_id: order.order_id,
        provider: payment.provider, provider_event_id: payment.providerEventId,
        provider_payment_id: payment.providerPaymentId, event_type: payment.eventType,
        amount_minor: payment.amountMinor, currency: payment.currency,
        payload_hash: payment.payloadHash,
      });
      if (paymentRecord.duplicate) assertDuplicatePaymentMatches(paymentRecord.transaction, payment);

      const existingCase = await repository.findCaseByOrderId(order.order_id);
      if (paymentRecord.duplicate && existingCase && order.status === 'paid') {
        return { order, consultationCase: existingCase, duplicate: true };
      }

      const paidOrder = order.status === 'paid' ? order : await repository.markOrderPaid(order.order_id, payment.paidAt);
      if (!paidOrder) throw new ConsultationDomainError('ORDER_PAYMENT_UPDATE_FAILED', 500);
      const created = await repository.createQueuedCase({
        case_id: caseId(), order_id: order.order_id,
        care_profile_id: order.care_profile_id,
        customer_line_user_id: order.customer_line_user_id,
      });
      if (!created.consultationCase) throw new ConsultationDomainError('CASE_PROVISIONING_FAILED', 500);
      await repository.insertEvent({
        event_id: eventId(), case_id: created.consultationCase.case_id,
        event_type: 'queued', actor_type: 'payment', actor_id: payment.provider,
        from_state: null, to_state: 'queued',
        metadata: { orderId: order.order_id },
        idempotency_key: `payment:${payment.provider}:${payment.providerEventId}`,
      });
      const provisionedOrder = await repository.markOrderProvisioned(order.order_id);
      await repository.updatePaymentTransaction(paymentRecord.transaction.payment_transaction_id, {
        processing_status: 'processed', processed_at: new Date().toISOString(), failure_code: null,
      });
      return {
        order: provisionedOrder || paidOrder,
        consultationCase: created.consultationCase,
        duplicate: !created.created || paymentRecord.duplicate,
      };
    });
  }

  return { provisionVerifiedPayment };
}

const defaultService = createConsultationPaymentService();
module.exports = {
  normalizeVerifiedPayment, assertDuplicatePaymentMatches, createConsultationPaymentService,
  provisionVerifiedConsultationPayment: defaultService.provisionVerifiedPayment,
  CONSULTATION_PRICE_MINOR, CONSULTATION_CURRENCY,
};
