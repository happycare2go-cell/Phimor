// tests/adminRoutes.test.js — ทดสอบ Endpoint สำหรับทีมงานสร้างศูนย์ (FR-A1)
//
// หมายเหตุ: ไม่ Reload server.js module ระหว่าง Test เพราะ middleware/adminAuth.js
// อ่าน process.env.ADMIN_API_KEY สดทุกครั้งที่มี Request เข้ามาอยู่แล้ว (ไม่ได้ Cache ค่าไว้ตอน Import)
// การ delete require.cache แล้ว require ใหม่จึงไม่จำเป็น และเคยทำให้ Test ค้างมาก่อน

const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const db = require('../backend/db');

let server, baseUrl, app;
const REAL_ADMIN_KEY = 'test-admin-key-12345';

before(async () => {
  process.env.ADMIN_API_KEY = REAL_ADMIN_KEY; // ตั้งค่าก่อน require ครั้งแรกครั้งเดียวพอ
  app = require('../backend/server');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => db.resetAll());

async function callAdmin(path, opts = {}) {
  return fetch(`${baseUrl}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
}

test('สร้างศูนย์โดยไม่มี Admin Key ต้องถูกปฏิเสธ 401', async () => {
  const res = await callAdmin('/api/admin/centers', {
    method: 'POST', body: JSON.stringify({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' }),
  });
  assert.strictEqual(res.status, 401);
});

test('สร้างศูนย์ด้วย Admin Key ผิด ต้องถูกปฏิเสธ 401', async () => {
  const res = await callAdmin('/api/admin/centers', {
    method: 'POST', headers: { 'X-Admin-Key': 'wrong-key' },
    body: JSON.stringify({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' }),
  });
  assert.strictEqual(res.status, 401);
});

test('reliability operations projection is Admin-only and contains counts without payload bodies', async () => {
  const originalSchedulerHealth = app.locals.schedulerHealth;
  app.locals.notificationService = { async getHealth() { return { pending:2, deadLetters:1, oldestPendingAt:null }; } };
  app.locals.integrationEventService = { async listOperationalStatus() {
    return { items:[
      { eventStatus:'retrying' }, { eventStatus:'dead' }, { eventStatus:'pending_subject_mapping' },
    ], summary:{ group_binding_mismatch:1 } };
  } };
  app.locals.schedulerHealth = () => ({ configuredJobs:1, jobs:{ notificationRetry:{ status:'completed' } } });
  let response = await callAdmin('/api/admin/operations/reliability');
  assert.strictEqual(response.status, 401);
  response = await callAdmin('/api/admin/operations/reliability', { headers:{ 'X-Admin-Key':REAL_ADMIN_KEY } });
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.deepStrictEqual(body.integration.states, { retrying:1, dead:1, pending_subject_mapping:1 });
  assert.strictEqual(body.notifications.deadLetters, 1);
  assert.strictEqual(body.scheduler.jobs.notificationRetry.status, 'completed');
  assert.doesNotMatch(JSON.stringify(body), /clinical|message body|LINE-SECRET|Bearer/i);
  delete app.locals.notificationService;
  delete app.locals.integrationEventService;
  app.locals.schedulerHealth = originalSchedulerHealth;
});

test('สร้างศูนย์ด้วย Admin Key ที่ถูกต้อง ต้องสำเร็จและคืนขั้นตอนถัดไป', async () => {
  const res = await callAdmin('/api/admin/centers', {
    method: 'POST', headers: { 'X-Admin-Key': REAL_ADMIN_KEY },
    body: JSON.stringify({ name: 'ศูนย์สุขสบาย', ownerLineId: 'U_OWNER_1' }),
  });
  assert.strictEqual(res.status, 201);
  const body = await res.json();
  assert.ok(body.centerId);
  assert.strictEqual(body.name, 'ศูนย์สุขสบาย');
  assert.strictEqual(body.ownerLineId, 'U_OWNER_1');
  assert.ok(Array.isArray(body.nextSteps) && body.nextSteps.length > 0);

  const centers = await db.Centers.findAll();
  assert.strictEqual(centers.length, 1);
});

test('ผูกบัญชี LINE เป็นผู้ดูแลครั้งแรกด้วย Admin Key แล้วใช้ LINE identity เข้า Admin API ได้', async () => {
  const lineUserId = 'U_SYSTEM_ADMIN';
  const bootstrap = await callAdmin('/api/admin/bootstrap', {
    method: 'POST',
    headers: { 'X-Admin-Key': REAL_ADMIN_KEY, 'X-Line-User-Id': lineUserId },
    body: '{}',
  });
  assert.strictEqual(bootstrap.status, 200);
  assert.strictEqual((await db.AdminUsers.findAll()).length, 1);

  const res = await callAdmin('/api/admin/centers', { headers: { 'X-Line-User-Id': lineUserId } });
  assert.strictEqual(res.status, 200);
});

test('บัญชี LINE ที่ยังไม่ถูกผูกเป็นผู้ดูแลต้องเข้า Admin API ไม่ได้', async () => {
  const res = await callAdmin('/api/admin/centers', { headers: { 'X-Line-User-Id': 'U_NOT_ADMIN' } });
  assert.strictEqual(res.status, 401);
});

test('สร้างศูนย์โดยไม่ระบุชื่อ ต้องถูกปฏิเสธ 400', async () => {
  const res = await callAdmin('/api/admin/centers', {
    method: 'POST', headers: { 'X-Admin-Key': REAL_ADMIN_KEY },
    body: JSON.stringify({ ownerLineId: 'U_OWNER' }),
  });
  assert.strictEqual(res.status, 400);
});

test('สร้างศูนย์โดยไม่ระบุ ownerLineId ต้องถูกปฏิเสธ 400', async () => {
  const res = await callAdmin('/api/admin/centers', {
    method: 'POST', headers: { 'X-Admin-Key': REAL_ADMIN_KEY },
    body: JSON.stringify({ name: 'ศูนย์ทดสอบ' }),
  });
  assert.strictEqual(res.status, 400);
});

test('GET /api/admin/centers คืนรายชื่อศูนย์ทั้งหมดพร้อมสถานะการผูกกลุ่ม', async () => {
  await callAdmin('/api/admin/centers', { method: 'POST', headers: { 'X-Admin-Key': REAL_ADMIN_KEY }, body: JSON.stringify({ name: 'ศูนย์ A', ownerLineId: 'U_A' }) });
  await callAdmin('/api/admin/centers', { method: 'POST', headers: { 'X-Admin-Key': REAL_ADMIN_KEY }, body: JSON.stringify({ name: 'ศูนย์ B', ownerLineId: 'U_B' }) });

  const res = await callAdmin('/api/admin/centers', { headers: { 'X-Admin-Key': REAL_ADMIN_KEY } });
  const body = await res.json();
  assert.strictEqual(body.centers.length, 2);
  assert.strictEqual(body.centers[0].centerStaffGroupReady, false, 'ยังไม่ผูกกลุ่มทีมงาน ต้องแสดง false');
  assert.equal(body.centers[0].capabilityReadiness.state, 'not_configured');
  assert.deepStrictEqual(body.centers, body.items, 'centers ต้องยังเป็น compatibility alias ของ items');
  assert.strictEqual(body.pagination.page, 1);
  assert.strictEqual(body.pagination.limit, 20);
});

test('dashboard projection is Admin-only, bounded and contains aggregate values only', async () => {
  app.locals.adminDashboardService = { async getDashboard() {
    return {
      centers:{ total:4, active:2, trial:1, nearExpiry:1, expired:1, suspended:0, notConfigured:0 },
      integrations:{ total:2, active:1, suspended:1, revoked:0, ready:1, notReady:1 },
      exceptions:{ pendingSubjectMapping:1, groupBindingMissing:1, groupBindingMismatch:0,
        identityAmbiguity:0, dsrAwaitingAction:1, accessRequests:0, integrationFailures:0,
        notificationDeadLetters:0, schedulerFailures:0 },
      platform:{ configuredSchedulerJobs:15, schedulerFailures:0, warningCount:0, state:'operational' },
    };
  } };
  let response = await callAdmin('/api/admin/dashboard');
  assert.equal(response.status, 401);
  response = await callAdmin('/api/admin/dashboard', { headers:{ 'X-Admin-Key':REAL_ADMIN_KEY } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.centers.total, 4);
  assert.equal(body.integrations.ready, 1);
  assert.equal(body.exceptions.dsrAwaitingAction, 1);
  assert.doesNotMatch(JSON.stringify(body), /patient|medication|vital|lab|line_user|group_id|credential|payload/i);
  delete app.locals.adminDashboardService;
});

test('Admin Center directory searches names server-side, filters authoritative states and returns search-scoped counts', async () => {
  const seed = async (center) => {
    await db.Centers.insert(center);
    await db.CenterStaff.insert({
      staff_id:`S-${center.center_id}`, center_id:center.center_id,
      line_user_id:center.owner_line_id, role:'owner', status:'active',
    });
  };
  await seed({ center_id:'C-A', name:'Happy Home Chiang Mai', owner_line_id:'U-A', status:'active', subscription_required:true, subscription_package_type:'monthly', subscription_start_at:'2020-01-01T00:00:00Z', subscription_end_at:'2099-01-01T00:00:00Z' });
  await seed({ center_id:'C-B', name:'Happy Home ทดลอง', owner_line_id:'U-B', status:'active', subscription_required:true, subscription_package_type:'trial', subscription_start_at:'2020-01-01T00:00:00Z', subscription_end_at:'2099-01-01T00:00:00Z' });
  await seed({ center_id:'C-C', name:'ศูนย์อื่น', owner_line_id:'U-C', status:'suspended', subscription_required:true, subscription_package_type:'monthly', subscription_start_at:'2020-01-01T00:00:00Z', subscription_end_at:'2099-01-01T00:00:00Z' });
  let response = await callAdmin('/api/admin/centers?search=happy%20HOME&subscriptionStatus=trial&page=1&limit=1', { headers:{ 'X-Admin-Key':REAL_ADMIN_KEY } });
  assert.strictEqual(response.status, 200);
  let body = await response.json();
  assert.deepStrictEqual(body.items.map((item) => item.centerId), ['C-B']);
  assert.strictEqual(body.pagination.total, 1);
  assert.strictEqual(body.counts.all, 2, 'counts ต้องนับ search scope ก่อนเลือก chip');
  assert.strictEqual(body.counts.active, 1);
  assert.strictEqual(body.counts.trial, 1);
  assert.doesNotMatch(JSON.stringify(body), /blood_group|chronic_conditions|allergies/);

  response = await callAdmin('/api/admin/centers?subscriptionStatus=suspended', { headers:{ 'X-Admin-Key':REAL_ADMIN_KEY } });
  body = await response.json();
  assert.deepStrictEqual(body.items.map((item) => item.centerId), ['C-C']);
  assert.strictEqual(body.items[0].operationalStatus, 'suspended');
  assert.strictEqual(body.items[0].directoryStatus, 'suspended');
  assert.strictEqual(body.items[0].subscription.state, 'active');
});

test('Admin Center directory rejects overlong search and unknown status safely', async () => {
  let response = await callAdmin(`/api/admin/centers?search=${'x'.repeat(101)}`, { headers:{ 'X-Admin-Key':REAL_ADMIN_KEY } });
  assert.strictEqual(response.status, 400);
  assert.doesNotMatch(await response.text(), /SELECT|postgres|stack/i);
  response = await callAdmin('/api/admin/centers?subscriptionStatus=paid-ish', { headers:{ 'X-Admin-Key':REAL_ADMIN_KEY } });
  assert.strictEqual(response.status, 400);
});

test('ถ้าไม่ได้ตั้งค่า ADMIN_API_KEY บน Server ต้องปิดกั้นทุกคำขอด้วย 503 (กันลืมตั้งค่าตอน Deploy)', async () => {
  const prevKey = process.env.ADMIN_API_KEY;
  delete process.env.ADMIN_API_KEY; // จำลองว่าลืมตั้งค่าตอน Deploy — middleware อ่านค่านี้สดทุกครั้ง ไม่ต้อง Reload

  const res = await callAdmin('/api/admin/centers', {
    method: 'POST', headers: { 'X-Admin-Key': 'anything' },
    body: JSON.stringify({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_X' }),
  });
  assert.strictEqual(res.status, 503, 'ต้องปิดกั้นทันทีถ้าไม่ได้ตั้งค่า Key ไว้ ห้ามเปิดช่องให้ผ่านฟรี');

  process.env.ADMIN_API_KEY = prevKey; // คืนค่าเดิมให้ Test อื่นทำงานต่อได้ปกติ
});

test('Admin ดูรายชื่อทีมงานของศูนย์ได้ พร้อมชื่อบทบาทภาษาไทย (ใช้ช่วยหา LINE User ID)', async () => {
  const centerService = require('../backend/services/centerService');
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.appointManager({ centerId: center.center_id, targetLineId: 'U_MGR', requesterLineId: 'U_OWNER' });
  await centerService.recordStaffFromGroup(null, null); // ไม่มีผล
  await db.CenterStaff.insert({ staff_id: 'STF-X', center_id: center.center_id, line_user_id: 'U_STAFF', role: 'staff', assigned_at: db.now(), auto_registered: true });

  const res = await callAdmin(`/api/admin/centers/${center.center_id}/staff`, { headers: { 'X-Admin-Key': REAL_ADMIN_KEY } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.staff.length, 3);

  const roles = body.staff.map((s) => s.roleLabel);
  assert.ok(roles.includes('เจ้าของศูนย์'));
  assert.ok(roles.includes('ผู้จัดการ'));
  assert.ok(roles.includes('พนักงาน'));
});

test('Admin หมุน API Key ใหม่ได้ และกุญแจเดิมถูกเพิกถอนทันที', async () => {
  const centerService = require('../backend/services/centerService');
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const oldKey = center.external_api_key;

  const res = await callAdmin(`/api/admin/centers/${center.center_id}/rotate-key`, {
    method: 'POST', headers: { 'X-Admin-Key': REAL_ADMIN_KEY },
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.notStrictEqual(body.newApiKey, oldKey);
  assert.ok(body.warning.includes('เพิกถอน'));

  const foundByOld = await centerService.findCenterByApiKey(oldKey);
  assert.strictEqual(foundByOld, null, 'กุญแจเดิมต้องใช้ไม่ได้อีก');
});

test('Admin ปิดใช้งานศูนย์ได้ และพนักงานของศูนย์นั้นส่งรูปไม่ได้อีก', async () => {
  const centerService = require('../backend/services/centerService');
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G_SUS', requesterLineId: 'U_OWNER' });
  await centerService.recordStaffFromGroup('G_SUS', 'U_STAFF_SUS');

  // ก่อนปิด — หาศูนย์เจอปกติ
  let found = await centerService.findCenterByStaffUser('U_STAFF_SUS');
  assert.ok(found, 'ก่อนปิดใช้งานต้องหาศูนย์เจอ');

  const res = await callAdmin(`/api/admin/centers/${center.center_id}/status`, {
    method: 'POST', headers: { 'X-Admin-Key': REAL_ADMIN_KEY }, body: JSON.stringify({ status: 'suspended' }),
  });
  assert.strictEqual(res.status, 200);

  // หลังปิด — พนักงานส่งรูปไม่ได้เพราะหาศูนย์ไม่เจอ
  found = await centerService.findCenterByStaffUser('U_STAFF_SUS');
  assert.strictEqual(found, null, 'ปิดใช้งานแล้วพนักงานต้องส่งรูปไม่ได้');

  // เปิดกลับได้
  await callAdmin(`/api/admin/centers/${center.center_id}/status`, {
    method: 'POST', headers: { 'X-Admin-Key': REAL_ADMIN_KEY }, body: JSON.stringify({ status: 'active' }),
  });
  found = await centerService.findCenterByStaffUser('U_STAFF_SUS');
  assert.ok(found, 'เปิดกลับแล้วต้องใช้งานได้ตามปกติ');
});

test('Admin ส่ง status ที่ไม่ถูกต้อง ต้องถูกปฏิเสธ', async () => {
  const centerService = require('../backend/services/centerService');
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const res = await callAdmin(`/api/admin/centers/${center.center_id}/status`, {
    method: 'POST', headers: { 'X-Admin-Key': REAL_ADMIN_KEY }, body: JSON.stringify({ status: 'deleted' }),
  });
  assert.strictEqual(res.status, 400);
});
