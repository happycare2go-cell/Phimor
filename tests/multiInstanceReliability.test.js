const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const db = require('../backend/db');
const lineClient = require('../backend/providers/lineClient');
const centerService = require('../backend/services/centerService');
const transportService = require('../backend/services/transportService');
const reminderService = require('../backend/services/reminderService');
const notificationService = require('../backend/services/notificationService');
const { createDistributedJobLockService } = require('../backend/services/distributedJobLockService');
const { createSchedulerCoordinatorService, JOB_LOCK_KEYS } = require('../backend/services/schedulerCoordinatorService');
const {
  createMemoryRateLimitRepository, createPostgresRateLimitRepository, createSharedRateLimitService,
  SharedRateLimitUnavailableError, hashIdentity,
} = require('../backend/services/sharedRateLimitService');

test.beforeEach(() => { db.resetAll(); lineClient.clearSentLog(); });

function contendedLockService() {
  let locked = false;
  return {
    async runWithLock(key, task) {
      if (locked) return { acquired:false, skipped:true };
      locked = true;
      try { return { acquired:true, skipped:false, result:await task() }; }
      finally { locked = false; }
    },
  };
}

test('two scheduler instances contend on one stable job key and the loser skips', async () => {
  const lockService = contendedLockService();
  const silent = { info() {}, error() {} };
  const first = createSchedulerCoordinatorService({ lockService, logger:silent });
  const second = createSchedulerCoordinatorService({ lockService, logger:silent });
  let runs = 0; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const owner = first.run('transportReminders', async () => { runs += 1; await gate; return 'done'; });
  await new Promise((resolve) => setImmediate(resolve));
  const loser = await second.run('transportReminders', async () => { runs += 1; });
  release();
  const winner = await owner;
  assert.equal(runs, 1);
  assert.equal(winner.acquired, true);
  assert.equal(loser.skipped, true);
  assert.equal(second.health().jobs.transportReminders.status, 'skipped_due_to_lock');
  assert.equal(JOB_LOCK_KEYS.transportReminders, 'phimor:scheduler:transport-reminders:v1');
  await assert.rejects(first.run('user-supplied-job', async () => {}), /SCHEDULER_JOB_NOT_REGISTERED/);
});

test('unrelated scheduled jobs retain distinct distributed keys but serialize in one local lane', async () => {
  const active = new Set();
  const lockService = {
    async runWithLock(key, task) {
      if (active.has(key)) return { acquired:false, skipped:true };
      active.add(key);
      try { return { acquired:true, skipped:false, result:await task() }; }
      finally { active.delete(key); }
    },
  };
  const coordinator = createSchedulerCoordinatorService({ lockService, logger:{ info() {}, error() {} } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started = 0;
  const first = coordinator.run('appointmentReminders', async () => { started += 1; await gate; });
  const second = coordinator.run('transportReminders', async () => { started += 1; await gate; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 1);
  assert.notEqual(JOB_LOCK_KEYS.appointmentReminders, JOB_LOCK_KEYS.transportReminders);
  assert.equal(coordinator.health().lane.concurrency, 1);
  assert.equal(coordinator.health().lane.queuedJobs, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(started, 2);
  assert.equal(results.every((result) => result.acquired), true);
});

test('scheduler lock releases after success and failure without logging task payload', async () => {
  const lockService = contendedLockService();
  const logs = [];
  const coordinator = createSchedulerCoordinatorService({
    lockService, logger:{ info:(label, meta) => logs.push({ label, meta }), error:(label, meta) => logs.push({ label, meta }) },
  });
  await coordinator.run('notificationRetry', async () => 'private-clinical-payload');
  await assert.rejects(coordinator.run('notificationRetry', async () => {
    const error = new Error('private message body'); error.code = 'QUEUE_TEMPORARILY_UNAVAILABLE'; throw error;
  }));
  const recovered = await coordinator.run('notificationRetry', async () => 'recovered');
  assert.equal(recovered.acquired, true);
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /private-clinical-payload|private message body/);
  assert.match(serialized, /QUEUE_TEMPORARILY_UNAVAILABLE/);
});

test('database session loss path releases the checked-out advisory-lock client', async () => {
  let released = 0; let calls = 0;
  const service = createDistributedJobLockService({ acquireClient:async () => ({
    async query() {
      calls += 1;
      if (calls === 1) return { rows:[{ acquired:true }] };
      throw Object.assign(new Error('connection lost'), { code:'57P01' });
    },
    release() { released += 1; },
  }) });
  await assert.rejects(service.runWithLock('phimor:scheduler:test:v1', async () => {
    throw Object.assign(new Error('connection lost'), { code:'57P01' });
  }), /connection lost/);
  assert.equal(released, 1);
});

async function setupTransportReminder() {
  const center = await centerService.createCenter({ name:'ศูนย์ทดสอบ', ownerLineId:'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId:center.center_id, groupId:'G_CENTER', requesterLineId:'U_OWNER' });
  const profile = await db.CareProfiles.insert({
    care_profile_id:'CP-MULTI', owner_line_id:'U_FAMILY', patient_name:'บุคคลตัวอย่าง',
    center_id:center.center_id, status:'linked',
  });
  const referenceDate = new Date('2026-08-28T08:00:00+07:00');
  const appointmentAt = new Date(referenceDate.getTime() + 4 * 60 * 60 * 1000);
  await db.Appointments.insert({ appointment_id:'AP-MULTI', care_profile_id:profile.care_profile_id,
    hospital:'โรงพยาบาลตัวอย่าง', datetime:appointmentAt.toISOString() });
  await transportService.createTransportPlan({ appointmentId:'AP-MULTI', careProfileId:profile.care_profile_id, centerId:center.center_id });
  return referenceDate;
}

test('transport reminder stage is claimed once under concurrent workers', async () => {
  const referenceDate = await setupTransportReminder();
  await Promise.all([
    transportService.remindPendingFamilyChoices(referenceDate),
    transportService.remindPendingFamilyChoices(referenceDate),
  ]);
  const family = lineClient.getSentLog().filter((entry) => entry.type === 'push' && entry.to === 'U_FAMILY');
  const center = lineClient.getSentLog().filter((entry) => entry.type === 'push' && entry.to === 'G_CENTER');
  assert.equal(family.length, 1);
  assert.equal(center.length, 1);
  const notices = await db.NotificationOutbox.findAll();
  assert.equal(notices.length, 2);
  assert.equal(new Set(notices.map((entry) => entry.dedupe_key)).size, 2);
});

test('transport reminder intent survives a crash before LINE delivery and is recovered once', async () => {
  const referenceDate = await setupTransportReminder();
  const originalDeliver = notificationService.deliver;
  notificationService.deliver = async () => { throw new Error('simulated process exit before provider call'); };
  try {
    await assert.rejects(
      transportService.remindPendingFamilyChoices(referenceDate),
      /simulated process exit/,
    );
  } finally {
    notificationService.deliver = originalDeliver;
  }

  const queued = await db.NotificationOutbox.findAll();
  assert.equal(queued.length, 2);
  assert.equal(queued.every((entry) => entry.status === 'pending'), true);
  assert.equal(lineClient.getSentLog().filter((entry) => entry.type === 'push').length, 0);

  const plan = (await db.TransportPlans.findAll())[0];
  assert.deepEqual(plan.reminder_stages_sent, ['stage_6h']);
  assert.equal((await transportService.remindPendingFamilyChoices(referenceDate)).reminded, 0);
  assert.equal((await db.NotificationOutbox.findAll()).length, 2);

  const recovered = await notificationService.processPending();
  assert.deepEqual(recovered, { processed:2, sent:2, failed:0 });
  assert.equal(lineClient.getSentLog().filter((entry) => entry.type === 'push').length, 2);
  assert.equal((await notificationService.processPending()).processed, 0);
});

async function setupSummary() {
  const center = await centerService.createCenter({ name:'ศูนย์ตัวอย่าง', ownerLineId:'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId:center.center_id, groupId:'G_CENTER', requesterLineId:'U_OWNER' });
  const resident = await db.Residents.insert({ resident_id:'R-MULTI', center_id:center.center_id,
    care_profile_id:'CP-SUMMARY', full_name:'บุคคลตัวอย่าง', status:'active' });
  await db.CareProfiles.insert({ care_profile_id:resident.care_profile_id, owner_line_id:'U_FAMILY',
    patient_name:'บุคคลตัวอย่าง', center_id:center.center_id, status:'linked' });
  const referenceDate = new Date('2026-08-30T08:00:00+07:00');
  const tomorrow = new Date(referenceDate.getTime() + 24 * 60 * 60 * 1000);
  await db.Appointments.insert({ appointment_id:'AP-SUMMARY', care_profile_id:resident.care_profile_id,
    hospital:'โรงพยาบาลตัวอย่าง', datetime:tomorrow.toISOString() });
  return referenceDate;
}

test('weekly and tomorrow Center summaries use persistent intent dedupe', async () => {
  const referenceDate = await setupSummary();
  await Promise.all([
    reminderService.sendWeeklySummary(referenceDate), reminderService.sendWeeklySummary(referenceDate),
    reminderService.sendTomorrowSummaryToCenters(referenceDate), reminderService.sendTomorrowSummaryToCenters(referenceDate),
  ]);
  const pushes = lineClient.getSentLog().filter((entry) => entry.type === 'push' && entry.to === 'G_CENTER');
  assert.equal(pushes.length, 2);
  const notices = await db.NotificationOutbox.findAll();
  assert.equal(notices.length, 2);
  assert.equal(notices.every((item) => !JSON.stringify(item.meta).includes('โรงพยาบาลตัวอย่าง')), true);
});

test('shared limiter is consistent across service instances and hashes identity', async () => {
  const repository = createMemoryRateLimitRepository();
  const first = createSharedRateLimitService({ repository });
  const second = createSharedRateLimitService({ repository });
  assert.equal((await first.checkAndRecord('Bearer super-secret', 2, 60000, { domain:'integration_client' })).allowed, true);
  assert.equal((await second.checkAndRecord('Bearer super-secret', 2, 60000, { domain:'integration_client' })).allowed, true);
  const blocked = await first.checkAndRecord('Bearer super-secret', 2, 60000, { domain:'integration_client' });
  assert.equal(blocked.allowed, false);
  assert.match(hashIdentity('integration_client', 'Bearer super-secret', 60000), /^[a-f0-9]{64}$/);
  const stored = JSON.stringify(repository.snapshot());
  assert.doesNotMatch(stored, /super-secret|Bearer/);
  assert.match(stored, /[a-f0-9]{64}/);
});

test('PostgreSQL limiter uses one atomic upsert and bounded indexed cleanup', async () => {
  const calls = [];
  const repository = createPostgresRateLimitRepository({ queryFn:async (sql, params) => {
    calls.push({ sql:String(sql), params });
    if (String(sql).includes('INSERT INTO')) return { rows:[{ request_count:1, window_expires_at:'2026-08-28T01:01:00Z' }] };
    return { rows:[], rowCount:3 };
  } });
  await repository.consume({ keyHash:'a'.repeat(64), domain:'generic_api', limit:5,
    windowMs:60000, at:new Date('2026-08-28T01:00:00Z') });
  await repository.cleanupExpired({ at:new Date('2026-08-28T02:00:00Z'), limit:1000 });
  assert.match(calls[0].sql, /ON CONFLICT \(key_hash\) DO UPDATE/);
  assert.match(calls[0].sql, /LEAST\(shared_rate_limit_windows\.request_count \+ 1/);
  assert.match(calls[1].sql, /LIMIT \$2/);
  assert.doesNotMatch(JSON.stringify(calls), /Bearer|super-secret|LINE-SECRET/);
});

test('shared limiter failure is fail-closed', async () => {
  const service = createSharedRateLimitService({ repository:{
    async consume() { throw new Error('database unavailable'); }, async cleanupExpired() { throw new Error('database unavailable'); },
  } });
  await assert.rejects(
    service.checkAndRecord('actor', 5, 60000, { domain:'generic_api' }),
    SharedRateLimitUnavailableError,
  );
  assert.deepEqual(await service.getHealth(), { available:false, shared:true });
});

test('migration 0014 is additive and creates indexed bounded rate-limit storage', async () => {
  const migration = require('../backend/migrations/0014_create_shared_rate_limit_windows');
  const sql = [];
  await migration.up({ query:async (statement) => { sql.push(String(statement)); return { rows:[] }; } });
  const joined = sql.join('\n');
  assert.equal(migration.version, '0014');
  assert.match(joined, /CREATE TABLE IF NOT EXISTS shared_rate_limit_windows/);
  assert.match(joined, /PRIMARY KEY/);
  assert.match(joined, /idx_shared_rate_limit_windows_expiry/);
  assert.doesNotMatch(joined, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/);
});
