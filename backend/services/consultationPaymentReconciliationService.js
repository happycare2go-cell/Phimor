const { withTransaction } = require('../db');
const { createConsultationRepository } = require('./consultationRepository');
const { createConsultationPaymentIngestionService } = require('./consultationPaymentIngestionService');
const { ConsultationDomainError } = require('../domain/consultation');

function createConsultationPaymentReconciliationService({
  repository = createConsultationRepository(),
  transaction = withTransaction,
  ingestionService = null,
} = {}) {
  const ingestion = ingestionService || createConsultationPaymentIngestionService({repository,transaction});

  async function reconcileOrder({ orderId, provider } = {}) {
    if (!orderId || !provider || typeof provider.retrievePayment !== 'function') {
      throw new ConsultationDomainError('RECONCILIATION_INPUT_REQUIRED');
    }
    const initialOrder = await repository.findOrder(orderId);
    if (!initialOrder) throw new ConsultationDomainError('ORDER_NOT_FOUND', 404);
    const existingCase = await repository.findCaseByOrderId(orderId);
    if (initialOrder.status === 'paid' && initialOrder.provisioning_status === 'provisioned' && existingCase) {
      return { status:'processed', duplicate:true, order:initialOrder, consultationCase:existingCase };
    }

    const payment = await provider.retrievePayment({
      orderId,
      providerCheckoutId:initialOrder.provider_checkout_id,
    });
    await transaction(`consultation-reconcile:${orderId}`, async () => {
      const order = await repository.findOrderForUpdate(orderId);
      if (!order) throw new ConsultationDomainError('ORDER_NOT_FOUND', 404);
      if (payment.orderId !== order.order_id) throw new ConsultationDomainError('PAYMENT_ORDER_MISMATCH', 409);
      if (order.provider && payment.provider !== order.provider) throw new ConsultationDomainError('PAYMENT_PROVIDER_MISMATCH', 409);
      if (order.provider_checkout_id && payment.providerCheckoutId !== order.provider_checkout_id) {
        throw new ConsultationDomainError('PAYMENT_CHECKOUT_MISMATCH', 409);
      }
      if (typeof payment.providerPaymentId !== 'string' || !payment.providerPaymentId.trim()) {
        throw new ConsultationDomainError('PAYMENT_REFERENCE_REQUIRED', 409);
      }
      const latest = await repository.findLatestPaymentTransactionForOrder(orderId);
      if (latest?.provider_payment_id && latest.provider_payment_id !== payment.providerPaymentId) {
        throw new ConsultationDomainError('PAYMENT_REFERENCE_MISMATCH', 409);
      }
    });
    const ingested = await ingestion.ingestVerifiedEvent(payment);
    return ingestion.processIngestedEvent(ingested);
  }

  return { reconcileOrder };
}

module.exports = { createConsultationPaymentReconciliationService };
