const { createConsultationPaymentProvider } = require('../providers/consultationPaymentProviderFactory');
const { createPlusPaymentRepository } = require('./plusPaymentRepository');
const { createPlusPaymentIngestionService } = require('./plusPaymentIngestionService');
const { PlusPaymentError } = require('../domain/plusPayment');

function createPlusPaymentReconciliationService({
  repository = createPlusPaymentRepository(),
  ingestion = null,
  providerFactory = createConsultationPaymentProvider,
  now = () => new Date(),
  operationalLogger = console.error,
} = {}) {
  const processor = ingestion || createPlusPaymentIngestionService({ repository });
  const referenceDate = () => { const value = now(); return value instanceof Date ? value : new Date(value); };
  const nextAttemptAt = (attempts) => new Date(referenceDate().getTime()
    + Math.min(15, Math.max(2, 2 ** Math.min(4, Math.max(1, Number(attempts) || 1)))) * 60_000).toISOString();

  async function reconcileOrder({ orderId, provider = null } = {}) {
    const order = await repository.findOrder(orderId);
    if (!order) throw new PlusPaymentError('PLUS_ORDER_NOT_FOUND', 404);
    if (order.status === 'paid' && order.fulfillment_status === 'granted') {
      return { status: 'processed', duplicate: true, order };
    }
    const paymentProvider = provider || providerFactory();
    const payment = await paymentProvider.retrievePayment({
      providerCheckoutId: order.provider_checkout_id,
    });
    if (payment.orderId !== order.order_id || payment.purpose !== 'phimor_plus') {
      throw new PlusPaymentError('PAYMENT_ORDER_MISMATCH', 409);
    }
    return processor.ingestAndProcess(payment);
  }

  async function sweepPendingOrders({ limit = 25 } = {}) {
    const ids = await repository.listOrdersDueForReconciliation(Math.min(100, Math.max(1, Number(limit) || 25)));
    const summary = { scanned: ids.length, processed: 0, pending: 0, failed: 0, expired: 0 };
    for (const orderId of ids) {
      const claimed = await repository.markReconciliationAttempt(orderId, { nextAttemptAt: nextAttemptAt(1) });
      if (!claimed) continue;
      try {
        const result = await reconcileOrder({ orderId });
        const current = await repository.findOrder(orderId);
        if (current?.status === 'payment_pending' && current.payment_due_at
            && new Date(current.payment_due_at).getTime() <= referenceDate().getTime()) {
          await repository.markPaymentExpired(orderId); summary.expired += 1; continue;
        }
        const terminal = current?.status === 'failed' || current?.status === 'expired'
          || (current?.status === 'paid' && current?.fulfillment_status === 'granted');
        await repository.finishReconciliation(orderId, {
          nextAttemptAt: terminal ? null : nextAttemptAt(claimed.reconciliation_attempts), errorCode: null,
        });
        if (result.status === 'processed') summary.processed += 1; else summary.pending += 1;
      } catch (error) {
        summary.failed += 1;
        const code = /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.code || '')
          ? error.code : 'PLUS_RECONCILIATION_UNAVAILABLE';
        await repository.finishReconciliation(orderId, {
          nextAttemptAt: nextAttemptAt(claimed.reconciliation_attempts), errorCode: code,
        });
        try { operationalLogger({ event: 'plus_payment_reconciliation_failed', safeErrorCode: code }); } catch (_) { /* no-op */ }
      }
    }
    return summary;
  }

  return { reconcileOrder, sweepPendingOrders };
}

module.exports = { createPlusPaymentReconciliationService };
