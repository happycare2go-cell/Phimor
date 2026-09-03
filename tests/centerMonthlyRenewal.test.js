process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-renewal-key';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../backend/db');
const subscriptionService = require('../backend/services/subscriptionService');
const directoryService = require('../backend/services/adminCenterDirectoryService');
const lineClient = require('../backend/providers/lineClient');

const REFERENCE = new Date('2026-09-10T03:00:00.000Z');
const ACTIVE_END = '2026-09-15T03:00:00.000Z';
const ACTIVE_START = '2026-08-15T03:00:00.000Z';
const adminHtml = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'system-admin', 'index.html'), 'utf8');
let server;
let baseUrl;

before(async () => {
  const app = require('../backend/server');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  db.resetAll();
  lineClient.clearSentLog();
});

async function seedCenter({
  centerId='CTR-RENEW', status='active', packageType='monthly',
  startsAt=ACTIVE_START, expiresAt=ACTIVE_END,
} = {}) {
  const center = await db.Centers.insert({
    center_id:centerId, name:`ศูนย์ ${centerId}`, status, owner_line_id:`U-${centerId}`,
    subscription_required:true, subscription_package_type:packageType,
    subscription_start_at:startsAt, subscription_end_at:expiresAt,
    created_at:'2026-01-01T00:00:00.000Z',
  });
  await db.CenterStaff.insert({
    staff_id:`STF-${centerId}`, center_id:centerId, line_user_id:`U-${centerId}`,
    display_name:`เจ้าของ ${centerId}`, role:'owner', status:'active',
  });
  return center;
}

function addDays(value, days) {
  return new Date(new Date(value).getTime() + days * subscriptionService.DAY_MS).toISOString();
}

test('active monthly renewal supports +30, +60 and +90 days without discarding remaining time', async () => {
  for (const units of [1, 2, 3]) {
    db.resetAll();
    lineClient.clearSentLog();
    const center = await seedCenter({ centerId:`CTR-U${units}` });
    const result = await subscriptionService.renewMonthlySubscription({
      centerId:center.center_id, renewalUnits:units, actor:'admin:test', referenceDate:REFERENCE,
    });
    assert.equal(result.ok, true);
    assert.equal(result.renewal.baseAt, ACTIVE_END);
    assert.equal(result.renewal.startsAt, ACTIVE_START);
    assert.equal(result.renewal.expiresAt, addDays(ACTIVE_END, units * 30));
    assert.equal(result.renewal.renewalDays, units * 30);
    assert.equal(result.renewal.preservesCurrentPeriod, true);
  }
});

test('expired and not-configured monthly packages start from authoritative server time', async () => {
  const expired = await seedCenter({ centerId:'CTR-EXPIRED', expiresAt:'2026-09-01T03:00:00.000Z' });
  let result = await subscriptionService.renewMonthlySubscription({
    centerId:expired.center_id, renewalUnits:1, actor:'admin:test', referenceDate:REFERENCE,
  });
  assert.equal(result.renewal.startsAt, REFERENCE.toISOString());
  assert.equal(result.renewal.expiresAt, addDays(REFERENCE, 30));
  assert.equal(result.renewal.preservesCurrentPeriod, false);

  const unconfigured = await seedCenter({ centerId:'CTR-EMPTY', packageType:null, startsAt:null, expiresAt:null });
  result = await subscriptionService.renewMonthlySubscription({
    centerId:unconfigured.center_id, renewalUnits:1, actor:'admin:test', referenceDate:REFERENCE,
  });
  assert.equal(result.center.subscription_required, true);
  assert.equal(result.center.subscription_package_type, 'monthly');
  assert.equal(result.renewal.startsAt, REFERENCE.toISOString());
  assert.equal(result.renewal.expiresAt, addDays(REFERENCE, 30));
});

test('valid trial converts to monthly after preserving its remainder; expired trial starts now', async () => {
  const validTrial = await seedCenter({ centerId:'CTR-TRIAL', packageType:'trial' });
  let result = await subscriptionService.renewMonthlySubscription({
    centerId:validTrial.center_id, renewalUnits:1, actor:'admin:test', referenceDate:REFERENCE,
  });
  assert.equal(result.center.subscription_package_type, 'monthly');
  assert.equal(result.renewal.baseAt, ACTIVE_END);
  assert.equal(result.renewal.expiresAt, addDays(ACTIVE_END, 30));

  const expiredTrial = await seedCenter({
    centerId:'CTR-TRIAL-OLD', packageType:'trial',
    startsAt:'2026-08-01T03:00:00.000Z', expiresAt:'2026-09-01T03:00:00.000Z',
  });
  result = await subscriptionService.renewMonthlySubscription({
    centerId:expiredTrial.center_id, renewalUnits:1, actor:'admin:test', referenceDate:REFERENCE,
  });
  assert.equal(result.renewal.startsAt, REFERENCE.toISOString());
  assert.equal(result.renewal.expiresAt, addDays(REFERENCE, 30));
});

test('suspended Center chronology can renew but operational suspension remains authoritative', async () => {
  const center = await seedCenter({ centerId:'CTR-SUSPENDED', status:'suspended' });
  const result = await subscriptionService.renewMonthlySubscription({
    centerId:center.center_id, renewalUnits:1, actor:'admin:test', referenceDate:REFERENCE,
  });
  assert.equal(result.center.status, 'suspended');
  assert.equal(result.entitlement.allowed, false);
  assert.equal(result.entitlement.operationalStatus, 'suspended');
  assert.equal(result.entitlement.state, 'active');
});

test('monthly renewal units are bounded integers and fixed-duration semantics remain distinct from trial months', () => {
  for (const invalid of [0, -1, 4, 1.5, 'x', null, undefined]) {
    assert.throws(() => subscriptionService.normalizeRenewalUnits(invalid), /ระหว่าง 1 ถึง 3/);
  }
  const paid = subscriptionService.calculateMonthlyRenewal({
    subscription_start_at:null, subscription_end_at:null,
  }, 1, new Date('2026-01-31T03:00:00.000Z'));
  assert.equal(paid.expiresAt, '2026-03-02T03:00:00.000Z');
  assert.equal(
    subscriptionService.addBangkokCalendarMonth('2026-01-31T10:00:00+07:00').toISOString(),
    '2026-02-28T03:00:00.000Z',
  );
});

test('concurrent renewal intents serialize and do not silently lose either extension', async () => {
  const center = await seedCenter({ centerId:'CTR-RACE' });
  const [first, second] = await Promise.all([
    subscriptionService.renewMonthlySubscription({ centerId:center.center_id, renewalUnits:1, actor:'admin:one', referenceDate:REFERENCE }),
    subscriptionService.renewMonthlySubscription({ centerId:center.center_id, renewalUnits:1, actor:'admin:two', referenceDate:REFERENCE }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const stored = await db.Centers.findOne((item) => item.center_id === center.center_id);
  assert.equal(stored.subscription_end_at, addDays(ACTIVE_END, 60));
  const audits = await db.AuditLog.findWhere((item) => item.action === 'center.subscription_updated');
  assert.equal(audits.length, 2);
});

test('renewal updates entitlement and Admin directory classification from expired to active', async () => {
  const center = await seedCenter({ centerId:'CTR-PROJECTION', expiresAt:'2026-09-01T03:00:00.000Z' });
  const renewed = await subscriptionService.renewMonthlySubscription({
    centerId:center.center_id, renewalUnits:2, actor:'admin:test', referenceDate:REFERENCE,
  });
  assert.equal(renewed.entitlement.allowed, true);
  assert.equal(renewed.entitlement.state, 'active');
  assert.equal(renewed.entitlement.packageType, 'monthly');
  const directory = await directoryService.listAdminCenters({ search:'CTR-PROJECTION' }, { at:REFERENCE });
  assert.equal(directory.items[0].directoryStatus, 'active');
  assert.equal(directory.counts.active, 1);
  assert.equal(directory.counts.expired, 0);
});

test('renewal audit records safe chronology and intent metadata', async () => {
  const center = await seedCenter({ centerId:'CTR-AUDIT' });
  await subscriptionService.renewMonthlySubscription({
    centerId:center.center_id, renewalUnits:3, actor:'admin:key', referenceDate:REFERENCE,
  });
  const entry = await db.AuditLog.findOne((item) => item.action === 'center.subscription_updated');
  assert.equal(entry.actor_line_id, 'admin:key');
  assert.deepEqual(entry.meta, {
    centerId:center.center_id, packageType:'monthly', renewalUnits:3, renewalDays:90,
    previousEnd:ACTIVE_END, startsAt:ACTIVE_START, expiresAt:addDays(ACTIVE_END, 90),
  });
  assert.doesNotMatch(JSON.stringify(entry), /clinical|patient|LINE message|secret/i);
});

test('subscription Owner recipients include only active unique current memberships', async () => {
  const center = await seedCenter({ centerId:'CTR-OWNER-RECIPIENTS' });
  const activeOwnerId = `U${'a'.repeat(32)}`;
  const revokedOwnerId = `U${'b'.repeat(32)}`;
  await db.CenterStaff.insert({
    staff_id:'STF-ACTIVE-OWNER', center_id:center.center_id,
    line_user_id:activeOwnerId, role:'owner', status:'active',
  });
  await db.CenterStaff.insert({
    staff_id:'STF-ACTIVE-OWNER-DUP', center_id:center.center_id,
    line_user_id:activeOwnerId, role:'owner', status:'active',
  });
  await db.CenterStaff.insert({
    staff_id:'STF-REVOKED-OWNER', center_id:center.center_id,
    line_user_id:revokedOwnerId, role:'owner', status:'revoked',
  });
  const recipients = await subscriptionService.listActiveOwnerRecipients(center.center_id);
  assert.deepEqual(recipients.map((row) => row.line_user_id).sort(), [activeOwnerId, `U-${center.center_id}`].sort());

  lineClient.clearSentLog();
  await subscriptionService.setSubscription({
    centerId:center.center_id,
    startsAt:'2026-09-01T00:00:00.000Z', expiresAt:'2026-12-01T00:00:00.000Z',
    actor:'admin:test',
  });
  const pushes = lineClient.getSentLog().filter((entry) => entry.type === 'push');
  assert.equal(pushes.filter((entry) => entry.to === activeOwnerId).length, 1);
  assert.equal(pushes.some((entry) => entry.to === revokedOwnerId), false);
});

test('subscription expiry reminders exclude revoked historical Owner rows', async () => {
  const expiresAt = new Date(REFERENCE.getTime() + (2 * subscriptionService.DAY_MS)).toISOString();
  const center = await seedCenter({ centerId:'CTR-EXPIRY-OWNERS', expiresAt });
  const revokedOwnerId = `U${'c'.repeat(32)}`;
  await db.CenterStaff.insert({
    staff_id:'STF-OLD-OWNER', center_id:center.center_id,
    line_user_id:revokedOwnerId, role:'owner', status:'revoked',
  });
  lineClient.clearSentLog();
  await subscriptionService.sendExpiryReminders(REFERENCE);
  const pushes = lineClient.getSentLog().filter((entry) => entry.type === 'push');
  assert.equal(pushes.some((entry) => entry.to === revokedOwnerId), false);
  assert.equal(pushes.filter((entry) => entry.to === `U-${center.center_id}`).length, 1);
});

async function callAdmin(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers:{ 'Content-Type':'application/json', ...(options.headers || {}) },
  });
}

test('monthly renewal routes require System Admin and reject browser-authored expiry', async () => {
  const center = await seedCenter({ centerId:'CTR-ROUTE' });
  let response = await callAdmin(`/api/admin/centers/${center.center_id}/subscription/monthly-renew`, {
    method:'POST', body:JSON.stringify({ packageType:'monthly', renewalUnits:1 }),
  });
  assert.equal(response.status, 401);

  response = await callAdmin(`/api/admin/centers/${center.center_id}/subscription/monthly-renew`, {
    method:'POST', headers:{ 'X-Admin-Key':process.env.ADMIN_API_KEY },
    body:JSON.stringify({
      packageType:'monthly', renewalUnits:1,
      startsAt:'1900-01-01T00:00:00Z', expiresAt:'2999-01-01T00:00:00Z',
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /คำนวณโดยระบบ/);
  assert.equal((await db.Centers.findOne((item) => item.center_id === center.center_id)).subscription_end_at, ACTIVE_END);
});

test('authorized route accepts intent only, returns minimized result and reload truth classifies active', async () => {
  const center = await seedCenter({ centerId:'CTR-HTTP', expiresAt:'2020-01-01T00:00:00.000Z' });
  let response = await callAdmin(`/api/admin/centers/${center.center_id}/subscription/monthly-renewal-preview?renewalUnits=1`, {
    headers:{ 'X-Admin-Key':process.env.ADMIN_API_KEY },
  });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.renewalUnits, 1);
  assert.equal(preview.renewalDays, 30);

  response = await callAdmin(`/api/admin/centers/${center.center_id}/subscription/monthly-renew`, {
    method:'POST', headers:{ 'X-Admin-Key':process.env.ADMIN_API_KEY },
    body:JSON.stringify({ packageType:'monthly', renewalUnits:1 }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['entitlement','ok','renewal']);
  assert.equal(body.entitlement.state, 'active');
  assert.doesNotMatch(JSON.stringify(body), /owner_line_id|U-CTR-HTTP|subscription_updated_by/);
});

test('monthly Admin UX uses backend preview/intent, bounded 44px controls and no authoritative date body', () => {
  assert.match(adminHtml, /แพ็กเกจรายเดือน/);
  assert.match(adminHtml, /จำนวนเดือน/);
  assert.match(adminHtml, /ต่ออายุ: <strong id="renewalDays">\+30 วัน/);
  assert.match(adminHtml, /วันหมดอายุปัจจุบัน/);
  assert.match(adminHtml, /วันหมดอายุใหม่/);
  assert.match(adminHtml, /monthly-renewal-preview\?renewalUnits=/);
  assert.match(adminHtml, /body:JSON\.stringify\(\{packageType:'monthly',renewalUnits:Number\(renewalUnits\.value\)\}\)/);
  assert.match(adminHtml, /input,select,button\{[^}]*min-height:44px/);
  assert.match(adminHtml, /renewal-stepper button\{width:44px/);
  const monthlyBranch = adminHtml.slice(adminHtml.indexOf("if(monthly){await api"), adminHtml.indexOf("}else{const start="));
  assert.doesNotMatch(monthlyBranch, /startsAt|expiresAt|subscriptionStart|subscriptionEnd/);
  assert.match(adminHtml, /subscriptionDialog\.close\(\);await loadCenters\(\)/);
});
