process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDatabasePoolConfig, getDatabasePoolMetrics,
  DEFAULT_DATABASE_POOL_MAX, DEFAULT_DATABASE_POOL_CONNECTION_TIMEOUT_MS,
} = require('../backend/db');
const { createDistributedJobLockService } = require('../backend/services/distributedJobLockService');
const { createSchedulerCoordinatorService } = require('../backend/services/schedulerCoordinatorService');
const {
  createReadinessService, runBoundedReadinessCheck,
} = require('../backend/services/readinessService');

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class DeterministicPool {
  constructor(max) {
    this.max = max;
    this.inUse = 0;
    this.waitingCount = 0;
    this.maxInUse = 0;
    this.schedulerLocks = 0;
    this.maxSchedulerLocks = 0;
    this.queries = [];
  }

  async acquire(kind) {
    if (this.inUse >= this.max) {
      this.waitingCount += 1;
      throw new Error('deterministic pool exhausted');
    }
    this.inUse += 1;
    if (kind === 'scheduler_lock') this.schedulerLocks += 1;
    this.maxInUse = Math.max(this.maxInUse, this.inUse);
    this.maxSchedulerLocks = Math.max(this.maxSchedulerLocks, this.schedulerLocks);
    let released = false;
    return {
      query:async (sql, params) => {
        this.queries.push({ kind, sql:String(sql), params });
        if (String(sql).includes('pg_try_advisory_lock')) return { rows:[{ acquired:true }] };
        if (String(sql).includes('pg_advisory_unlock')) return { rows:[{ pg_advisory_unlock:true }] };
        return { rows:[{ ok:true }] };
      },
      release:() => {
        if (released) return;
        released = true;
        this.inUse -= 1;
        if (kind === 'scheduler_lock') this.schedulerLocks -= 1;
      },
    };
  }
}

test('09:00 scheduler burst retains interactive pool capacity and drains deterministically', async () => {
  const pool = new DeterministicPool(10);
  const realtimeClient = await pool.acquire('realtime_listen');
  const lockService = createDistributedJobLockService({
    acquireClient:() => pool.acquire('scheduler_lock'),
  });
  const coordinator = createSchedulerCoordinatorService({
    lockService, logger:{ info() {}, error() {} },
  });
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const jobs = [
    'cardExpiry', 'pendingCardReminders', 'appointmentReminders',
    'appointmentWeeklySummary', 'centerTomorrowSummary', 'transportReminders',
    'subscriptionExpiry', 'notificationRetry', 'webhookInbox',
  ];
  const executed = [];
  const runs = jobs.map((jobName, index) => coordinator.run(jobName, async () => {
    const taskClient = await pool.acquire('scheduler_task');
    executed.push(jobName);
    try {
      if (index === 0) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      if (index === 1) throw Object.assign(new Error('bounded failure'), { code:'TEST_JOB_FAILED' });
      return jobName;
    } finally {
      taskClient.release();
    }
  }));

  const duplicate = await coordinator.run('cardExpiry', async () => {
    throw new Error('duplicate task must not run');
  });
  assert.deepEqual(duplicate, {
    acquired:false, skipped:true, reasonCode:'SCHEDULER_LOCAL_DUPLICATE',
  });

  await firstStarted.promise;
  assert.equal(pool.schedulerLocks, 1);
  assert.equal(coordinator.health().lane.queuedJobs, 8);
  const adminClient = await pool.acquire('interactive_admin');
  const adminResult = await adminClient.query('SELECT dashboard');
  assert.deepEqual(adminResult.rows, [{ ok:true }]);
  adminClient.release();
  assert.equal(pool.waitingCount, 0);
  assert.ok(pool.inUse < pool.max);

  releaseFirst.resolve();
  const results = await Promise.allSettled(runs);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 8);
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1);
  assert.deepEqual(executed, jobs);
  assert.equal(pool.maxSchedulerLocks, 1);
  assert.ok(pool.maxInUse <= 4, `expected at most realtime + lock + task + interactive, saw ${pool.maxInUse}`);
  assert.equal(coordinator.health().lane.activeJobName, null);
  assert.equal(coordinator.health().lane.queuedJobs, 0);
  assert.equal(coordinator.health().lane.localDuplicateSkips, 1);
  assert.equal(pool.queries.filter((item) => item.sql.includes('pg_try_advisory_lock')).length, jobs.length);
  assert.equal(pool.queries.filter((item) => item.sql.includes('pg_advisory_unlock')).length, jobs.length);
  realtimeClient.release();
  assert.equal(pool.inUse, 0);
});

test('database pool defaults are explicit, bounded, and expose aggregate metrics only', () => {
  const defaults = createDatabasePoolConfig({ DATABASE_URL:'postgres://not-printed' });
  assert.equal(defaults.max, DEFAULT_DATABASE_POOL_MAX);
  assert.equal(defaults.connectionTimeoutMillis, DEFAULT_DATABASE_POOL_CONNECTION_TIMEOUT_MS);
  const bounded = createDatabasePoolConfig({
    DATABASE_URL:'postgres://not-printed', DATABASE_POOL_MAX:'999',
    DATABASE_POOL_CONNECTION_TIMEOUT_MS:'0',
  });
  assert.equal(bounded.max, DEFAULT_DATABASE_POOL_MAX);
  assert.equal(bounded.connectionTimeoutMillis, DEFAULT_DATABASE_POOL_CONNECTION_TIMEOUT_MS);
  assert.deepEqual(getDatabasePoolMetrics({ totalCount:10, idleCount:2, waitingCount:3 }, defaults), {
    totalCount:10, idleCount:2, waitingCount:3, configuredMax:10,
  });
  assert.doesNotMatch(JSON.stringify(getDatabasePoolMetrics({}, defaults)), /postgres|DATABASE_URL|SELECT/i);
});

test('readiness timeout resolves as safe not-ready without waiting for a database client', async () => {
  let fireTimeout = null;
  const pending = new Promise(() => {});
  const checkPromise = runBoundedReadinessCheck(() => pending, {
    timeoutMs:2500,
    timeoutCode:'DATABASE_CHECK_TIMEOUT',
    failureCode:'DATABASE_UNAVAILABLE',
    schedule:(callback) => { fireTimeout = callback; return { unref() {} }; },
    cancel() {},
  });
  assert.equal(typeof fireTimeout, 'function');
  fireTimeout();
  assert.deepEqual(await checkPromise, { ok:false, errorCode:'DATABASE_CHECK_TIMEOUT' });
});

test('readiness skips secondary database checks after pool-capacity timeout', async () => {
  let fireTimeout = null;
  let secondaryCalls = 0;
  const service = createReadinessService({
    pingDatabase:() => new Promise(() => {}),
    notificationHealth:async () => { secondaryCalls += 1; },
    rateLimitHealth:async () => { secondaryCalls += 1; },
    plusPaymentHealth:async () => { secondaryCalls += 1; },
    getDatabasePoolMetrics:() => ({ totalCount:10, idleCount:0, waitingCount:1, configuredMax:10 }),
    schedulerHealth:() => ({ configuredJobs:16, lane:{ concurrency:1, activeJobName:'notificationRetry', queuedJobs:8, localDuplicateSkips:1 }, jobs:{} }),
    realtimeHealth:() => ({ configured:true, started:true, available:true }),
    missingEnvironment:() => [],
    timeoutMs:2500,
    schedule:(callback) => { fireTimeout = callback; return { unref() {} }; },
    cancel() {},
  });
  const resultPromise = service.check();
  assert.equal(typeof fireTimeout, 'function');
  fireTimeout();
  const result = await resultPromise;
  assert.equal(result.ready, false);
  assert.equal(result.database, false);
  assert.equal(result.databaseError, 'DATABASE_CHECK_TIMEOUT');
  assert.equal(result.databasePool.waitingCount, 1);
  assert.equal(result.consultationRealtime.available, true);
  assert.equal(secondaryCalls, 0);
  assert.doesNotMatch(JSON.stringify(result), /postgres|DATABASE_URL|SELECT|resident|LINE/i);
});
