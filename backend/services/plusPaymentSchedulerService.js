const { createPlusPaymentReconciliationService } = require('./plusPaymentReconciliationService');
const { loadFeatureFlags } = require('../config/featureFlags');
const { paymentAvailable } = require('./plusPaymentOrderService');

function createPlusPaymentSchedulerService({
  reconciliation = createPlusPaymentReconciliationService(),
  flagsLoader = loadFeatureFlags,
} = {}) {
  async function runDueWork() {
    if (!paymentAvailable(flagsLoader())) {
      return { acquired: false, skipped: true, reasonCode: 'PLUS_PAYMENT_DISABLED' };
    }
    // Distributed ownership is provided by schedulerCoordinatorService at the
    // server registration boundary. Keeping this service lock-free avoids a
    // second PostgreSQL session lock around the same logical job.
    return reconciliation.sweepPendingOrders();
  }
  return { runDueWork };
}

module.exports = { createPlusPaymentSchedulerService };
