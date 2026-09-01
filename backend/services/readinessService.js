const DEFAULT_READINESS_TIMEOUT_MS = 2500;

function readinessTimeoutMs(env = process.env) {
  const parsed = Number(env.READINESS_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed >= 250 && parsed <= 10000
    ? parsed : DEFAULT_READINESS_TIMEOUT_MS;
}

function safeReadinessErrorCode(error, fallback = 'READINESS_CHECK_FAILED') {
  const value = String(error?.code || '').trim();
  return /^[0-9A-Z_]{2,48}$/.test(value) ? value : fallback;
}

function runBoundedReadinessCheck(action, {
  timeoutMs,
  timeoutCode,
  failureCode,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) cancel(timer);
      resolve(result);
    };
    timer = schedule(() => finish({ ok:false, errorCode:timeoutCode }), Math.max(1, timeoutMs));
    timer?.unref?.();
    Promise.resolve().then(action).then(
      (value) => finish({ ok:true, value }),
      (error) => finish({ ok:false, errorCode:safeReadinessErrorCode(error, failureCode) }),
    );
  });
}

function createReadinessService({
  pingDatabase,
  notificationHealth,
  rateLimitHealth,
  plusPaymentHealth,
  plusPaymentConfigured = () => false,
  getDatabasePoolMetrics = () => ({ totalCount:0, idleCount:0, waitingCount:0, configuredMax:0 }),
  schedulerHealth = () => ({ configuredJobs:0, lane:{ concurrency:1, activeJobName:null, queuedJobs:0, localDuplicateSkips:0 }, jobs:{} }),
  realtimeHealth = () => ({ configured:false, started:false }),
  missingEnvironment = () => [],
  timeoutMs = readinessTimeoutMs(),
  clock = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (![pingDatabase, notificationHealth, rateLimitHealth, plusPaymentHealth].every((item) => typeof item === 'function')) {
    throw new Error('READINESS_DEPENDENCIES_REQUIRED');
  }

  const bounded = (action, options, duration) => runBoundedReadinessCheck(action, {
    ...options, timeoutMs:Math.max(1, duration), schedule, cancel,
  });

  async function check() {
    const startedAt = clock();
    const deadline = startedAt + timeoutMs;
    const databaseCheck = await bounded(pingDatabase, {
      timeoutCode:'DATABASE_CHECK_TIMEOUT', failureCode:'DATABASE_UNAVAILABLE',
    }, timeoutMs);
    const databasePool = getDatabasePoolMetrics();
    const missing = missingEnvironment();
    const scheduler = schedulerHealth();
    const consultationRealtime = realtimeHealth();

    if (!databaseCheck.ok) {
      return {
        ready:false, database:false, databaseError:databaseCheck.errorCode,
        missingEnvironment:missing, rateLimits:{ available:false, shared:true },
        plusPaymentStorage:{ available:false, configured:plusPaymentConfigured() === true },
        notifications:{ unavailable:true }, scheduler, consultationRealtime, databasePool,
      };
    }

    const remaining = Math.max(1, deadline - clock());
    const [notificationsCheck, rateLimitsCheck, plusPaymentCheck] = await Promise.all([
      bounded(notificationHealth, {
        timeoutCode:'NOTIFICATION_HEALTH_TIMEOUT', failureCode:'NOTIFICATION_HEALTH_UNAVAILABLE',
      }, remaining),
      bounded(rateLimitHealth, {
        timeoutCode:'RATE_LIMIT_HEALTH_TIMEOUT', failureCode:'RATE_LIMIT_HEALTH_UNAVAILABLE',
      }, remaining),
      bounded(plusPaymentHealth, {
        timeoutCode:'PLUS_PAYMENT_HEALTH_TIMEOUT', failureCode:'PLUS_PAYMENT_HEALTH_UNAVAILABLE',
      }, remaining),
    ]);

    const notifications = notificationsCheck.ok ? notificationsCheck.value : { unavailable:true };
    const rateLimits = rateLimitsCheck.ok ? rateLimitsCheck.value : { available:false, shared:true };
    const plusPaymentStorage = plusPaymentCheck.ok
      ? plusPaymentCheck.value : { available:false, configured:true };
    const ready = rateLimits?.available === true
      && plusPaymentStorage?.available === true && missing.length === 0;
    return {
      ready, database:true, databaseError:null, missingEnvironment:missing,
      rateLimits, plusPaymentStorage, notifications, scheduler, consultationRealtime, databasePool,
    };
  }

  return { check };
}

module.exports = {
  DEFAULT_READINESS_TIMEOUT_MS,
  readinessTimeoutMs,
  safeReadinessErrorCode,
  runBoundedReadinessCheck,
  createReadinessService,
};
