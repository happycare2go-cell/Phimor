const { createDistributedJobLockService } = require('./distributedJobLockService');

const JOB_LOCK_KEYS = Object.freeze({
  cardExpiry: 'phimor:scheduler:card-expiry:v1',
  pendingCardReminders: 'phimor:scheduler:pending-card-reminders:v1',
  appointmentReminders: 'phimor:scheduler:appointment-reminders:v1',
  appointmentWeeklySummary: 'phimor:scheduler:appointment-weekly-summary:v1',
  centerTomorrowSummary: 'phimor:scheduler:center-tomorrow-summary:v1',
  transportReminders: 'phimor:scheduler:transport-reminders:v1',
  subscriptionExpiry: 'phimor:scheduler:subscription-expiry:v1',
  notificationRetry: 'phimor:scheduler:notification-retry:v1',
  webhookInbox: 'phimor:scheduler:webhook-inbox:v1',
  integrationInbox: 'phimor:scheduler:integration-inbox:v1',
  consultationLifecycle: 'phimor:scheduler:consultation-lifecycle:v1',
  plusPaymentReconciliation: 'phimor:scheduler:plus-payment-reconciliation:v1',
  centerStaffReconciliation: 'phimor:scheduler:center-staff-reconciliation:v1',
  sourceImageRetention: 'phimor:scheduler:source-image-retention:v1',
  sharedRateLimitCleanup: 'phimor:scheduler:shared-rate-limit-cleanup:v1',
  integrationAdapterRetention: 'phimor:scheduler:integration-adapter-retention:v1',
});

function safeErrorCode(error) {
  const value = String(error?.code || '').trim();
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'SCHEDULED_JOB_FAILED';
}

function safeDiagnosticValue(value, pattern, maxLength) {
  const text=typeof value==='string'?value.trim():'';
  return text.length<=maxLength&&pattern.test(text)?text:null;
}

function safeSchedulerError(error) {
  return {
    errorCode:safeErrorCode(error),
    postgresCode:safeDiagnosticValue(error?.code,/^[0-9A-Z]{5}$/,5),
    postgresRoutine:safeDiagnosticValue(error?.routine,/^[A-Za-z][A-Za-z0-9_]{0,79}$/,80),
    postgresConstraint:safeDiagnosticValue(error?.constraint,/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/,128),
    operation:safeDiagnosticValue(error?.safeOperation,/^[a-z][a-z0-9_]{0,63}$/,64),
  };
}

function createSchedulerCoordinatorService({
  lockService = createDistributedJobLockService(),
  now = () => new Date(),
  logger = console,
} = {}) {
  const states = new Map();

  function snapshot(jobName, patch) {
    const next = { jobName, ...(states.get(jobName) || {}), ...patch };
    states.set(jobName, next);
    return next;
  }

  async function run(jobName, task) {
    const lockKey = JOB_LOCK_KEYS[jobName];
    if (!lockKey || typeof task !== 'function') throw new Error('SCHEDULER_JOB_NOT_REGISTERED');
    const startedAt = now();
    snapshot(jobName, {
      status: 'running', startedAt: startedAt.toISOString(), completedAt: null,
      durationMs: null, errorCode: null, postgresCode:null, postgresRoutine:null,
      postgresConstraint:null, operation:null,
    });
    try {
      const result = await lockService.runWithLock(lockKey, task);
      const completedAt = now();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
      if (result.skipped) {
        snapshot(jobName, {
          status: 'skipped_due_to_lock', completedAt: completedAt.toISOString(), durationMs,
          lastSkippedAt: completedAt.toISOString(), errorCode: null,
        });
        logger.info?.('[Scheduler]', { jobName, status: 'skipped_due_to_lock', durationMs });
      } else {
        snapshot(jobName, {
          status: 'completed', completedAt: completedAt.toISOString(), durationMs,
          lastSucceededAt: completedAt.toISOString(), errorCode: null,
        });
        logger.info?.('[Scheduler]', { jobName, status: 'completed', durationMs });
      }
      return result;
    } catch (error) {
      const completedAt = now();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
      const diagnostic = safeSchedulerError(error);
      snapshot(jobName, {
        status: 'failed', completedAt: completedAt.toISOString(), durationMs,
        lastFailedAt: completedAt.toISOString(), ...diagnostic,
      });
      logger.error?.('[Scheduler]', {
        jobName, status:'failed', durationMs,
        ...Object.fromEntries(Object.entries(diagnostic).filter(([,value])=>value!==null)),
      });
      throw error;
    }
  }

  function health() {
    return {
      configuredJobs: Object.keys(JOB_LOCK_KEYS).length,
      jobs: Object.fromEntries([...states.entries()].map(([name, state]) => [name, { ...state }])),
    };
  }

  return { run, health };
}

module.exports = { JOB_LOCK_KEYS, createSchedulerCoordinatorService, safeErrorCode, safeSchedulerError };
