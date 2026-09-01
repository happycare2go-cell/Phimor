const {createConsultationPaymentReconciliationService}=require('./consultationPaymentReconciliationService');
const {createConsultationExpirationService}=require('./consultationExpirationService');
const {createConsultationLifecycleNotificationService}=require('./consultationLifecycleNotificationService');

async function runLifecycleOperation(operation, action) {
  try {
    return await action();
  } catch (error) {
    if (error && typeof error === 'object') error.safeOperation=operation;
    throw error;
  }
}

function createConsultationLifecycleSchedulerService({
  reconciliation=createConsultationPaymentReconciliationService(),
  expiration=createConsultationExpirationService(),
  notifications=createConsultationLifecycleNotificationService(),
}={}) {
  async function runDueWork() {
    // Cross-instance ownership is enforced once at schedulerCoordinatorService.
    // Keeping the business operation lock-free avoids reserving a second pool
    // client while the outer scheduler advisory-lock session is still held.
    const payment=await runLifecycleOperation('payment_reconciliation',()=>reconciliation.sweepPendingOrders());
    const expired=await runLifecycleOperation('expiration_sweep',()=>expiration.sweepExpired());
    const notification=await runLifecycleOperation('lifecycle_notifications',()=>notifications.enqueueDueNotifications());
    return {payment,expired,notification};
  }
  return {runDueWork};
}

module.exports={runLifecycleOperation,createConsultationLifecycleSchedulerService};
