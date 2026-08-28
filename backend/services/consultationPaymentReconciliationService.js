const { withTransaction } = require('../db');
const { createConsultationRepository } = require('./consultationRepository');
const { createConsultationPaymentIngestionService } = require('./consultationPaymentIngestionService');
const { ConsultationDomainError } = require('../domain/consultation');
const { createConsultationPaymentProvider } = require('../providers/consultationPaymentProviderFactory');
const { createConsultationPharmacistNotificationService } = require('./consultationPharmacistNotificationService');

function createConsultationPaymentReconciliationService({
  repository = createConsultationRepository(),
  transaction = withTransaction,
  ingestionService = null,
  providerFactory = createConsultationPaymentProvider,
  pharmacistNotifications = null,
  operationalLogger = console.error,
  now = () => new Date(),
} = {}) {
  const notifications=pharmacistNotifications || createConsultationPharmacistNotificationService({repository});
  const ingestion = ingestionService || createConsultationPaymentIngestionService({
    repository,transaction,pharmacistNotifications:notifications,operationalLogger,
  });
  const referenceDate=()=>{const value=now();return value instanceof Date?value:new Date(value);};

  async function recoverQueuedNotification(consultationCase) {
    if (!consultationCase?.case_id) return;
    try { await notifications.notifyQueuedCase({caseId:consultationCase.case_id}); }
    catch (_) {
      try {
        if (typeof operationalLogger==='function') operationalLogger({
          event:'consultation_notification_reconciliation_failed',
          safeErrorCode:'CONSULTATION_NOTIFICATION_ENQUEUE_FAILED',
        });
      } catch (_) { /* reconciliation result remains authoritative */ }
    }
  }

  async function reconcileOrder({ orderId, provider } = {}) {
    if (!orderId) throw new ConsultationDomainError('RECONCILIATION_INPUT_REQUIRED');
    const initialOrder = await repository.findOrder(orderId);
    if (!initialOrder) throw new ConsultationDomainError('ORDER_NOT_FOUND', 404);
    const existingCase = await repository.findCaseByOrderId(orderId);
    if (initialOrder.status === 'paid' && initialOrder.provisioning_status === 'provisioned' && existingCase) {
      await recoverQueuedNotification(existingCase);
      return { status:'processed', duplicate:true, order:initialOrder, consultationCase:existingCase };
    }

    const paymentProvider=provider || providerFactory();
    if (!paymentProvider || typeof paymentProvider.retrievePayment !== 'function') {
      throw new ConsultationDomainError('RECONCILIATION_INPUT_REQUIRED');
    }

    const payment = await paymentProvider.retrievePayment({
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

  function nextAttemptAt(attempts) {
    const minutes=Math.min(15,Math.max(2,2 ** Math.min(4,Math.max(1,Number(attempts)||1))));
    return new Date(referenceDate().getTime()+minutes*60_000).toISOString();
  }

  async function sweepPendingOrders({limit=25}={}) {
    const bounded=Number.isSafeInteger(Number(limit)) ? Math.min(100,Math.max(1,Number(limit))) : 25;
    const staleDrafts=typeof repository.expireStaleDraftOrders==='function'
      ? await repository.expireStaleDraftOrders(10) : [];
    const orderIds=await repository.listOrdersDueForReconciliation(bounded);
    let processed=0;let pending=0;let failed=0;let expired=0;
    for (const orderId of orderIds) {
      const claimed=await repository.markOrderReconciliationAttempt(orderId,{nextAttemptAt:nextAttemptAt(1)});
      if (!claimed) continue;
      try {
        await reconcileOrder({orderId});
        const current=await repository.findOrder(orderId);
        if (current?.status==='payment_pending' && current.payment_due_at
            && new Date(current.payment_due_at).getTime()<=referenceDate().getTime()) {
          await repository.markOrderExpired(orderId);expired+=1;processed+=1;continue;
        }
        const terminal=current?.status==='failed'||current?.status==='expired'
          || (current?.status==='paid'&&current?.provisioning_status==='provisioned');
        await repository.finishOrderReconciliation(orderId,{
          nextAttemptAt:terminal?null:nextAttemptAt(claimed.reconciliation_attempts),
          errorCode:null,
        });
        if (terminal) processed+=1; else pending+=1;
      } catch (error) {
        failed+=1;
        const code=/^[A-Z][A-Z0-9_]{2,79}$/.test(error?.code||'') ? error.code : 'RECONCILIATION_UNAVAILABLE';
        await repository.finishOrderReconciliation(orderId,{
          nextAttemptAt:nextAttemptAt(claimed.reconciliation_attempts),errorCode:code,
        });
        try { if (typeof operationalLogger==='function') operationalLogger({
          event:'consultation_payment_reconciliation_failed',safeErrorCode:code,
        }); } catch (_) { /* payment state remains authoritative */ }
      }
    }
    return {scanned:orderIds.length,processed,pending,failed,expired,staleDrafts:staleDrafts.length};
  }

  return { reconcileOrder,sweepPendingOrders };
}

module.exports = { createConsultationPaymentReconciliationService };
