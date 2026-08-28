const {createDistributedJobLockService}=require('./distributedJobLockService');
const {createConsultationPaymentReconciliationService}=require('./consultationPaymentReconciliationService');
const {createConsultationExpirationService}=require('./consultationExpirationService');
const {createConsultationLifecycleNotificationService}=require('./consultationLifecycleNotificationService');

const CONSULTATION_LIFECYCLE_JOB_LOCK='phimor:consultation-payment-lifecycle-v1';

function createConsultationLifecycleSchedulerService({
  lockService=createDistributedJobLockService(),
  reconciliation=createConsultationPaymentReconciliationService(),
  expiration=createConsultationExpirationService(),
  notifications=createConsultationLifecycleNotificationService(),
}={}) {
  async function runDueWork() {
    return lockService.runWithLock(CONSULTATION_LIFECYCLE_JOB_LOCK,async()=>{
      const payment=await reconciliation.sweepPendingOrders();
      const expired=await expiration.sweepExpired();
      const notification=await notifications.enqueueDueNotifications();
      return {payment,expired,notification};
    });
  }
  return {runDueWork};
}

module.exports={CONSULTATION_LIFECYCLE_JOB_LOCK,createConsultationLifecycleSchedulerService};
