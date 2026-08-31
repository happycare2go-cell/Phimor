const {createDistributedJobLockService}=require('./distributedJobLockService');
const {createConsultationPaymentReconciliationService}=require('./consultationPaymentReconciliationService');
const {createConsultationExpirationService}=require('./consultationExpirationService');
const {createConsultationLifecycleNotificationService}=require('./consultationLifecycleNotificationService');

const CONSULTATION_LIFECYCLE_JOB_LOCK='phimor:consultation-payment-lifecycle-v1';

async function runLifecycleOperation(operation, action) {
  try {
    return await action();
  } catch (error) {
    if (error && typeof error === 'object') error.safeOperation=operation;
    throw error;
  }
}

function createConsultationLifecycleSchedulerService({
  lockService=createDistributedJobLockService(),
  reconciliation=createConsultationPaymentReconciliationService(),
  expiration=createConsultationExpirationService(),
  notifications=createConsultationLifecycleNotificationService(),
}={}) {
  async function runDueWork() {
    return lockService.runWithLock(CONSULTATION_LIFECYCLE_JOB_LOCK,async()=>{
      const payment=await runLifecycleOperation('payment_reconciliation',()=>reconciliation.sweepPendingOrders());
      const expired=await runLifecycleOperation('expiration_sweep',()=>expiration.sweepExpired());
      const notification=await runLifecycleOperation('lifecycle_notifications',()=>notifications.enqueueDueNotifications());
      return {payment,expired,notification};
    });
  }
  return {runDueWork};
}

module.exports={CONSULTATION_LIFECYCLE_JOB_LOCK,runLifecycleOperation,createConsultationLifecycleSchedulerService};
