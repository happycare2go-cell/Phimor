process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-resident-history-key';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../backend/db');
const subscriptionService = require('../backend/services/subscriptionService');
const directoryService = require('../backend/services/adminCenterDirectoryService');

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

beforeEach(() => db.resetAll());

async function seedCenter(centerId = 'CTR-HISTORY') {
  const center = await db.Centers.insert({
    center_id:centerId, name:'ศูนย์ทดสอบ', owner_line_id:'U-OWNER-RAW-1234', status:'active',
    subscription_required:false, created_at:'2026-01-01T00:00:00.000Z',
  });
  await db.CenterStaff.insert({
    staff_id:'STF-OWNER', center_id:centerId, line_user_id:'U-OWNER-RAW-1234',
    display_name:'เจ้าของศูนย์', role:'owner', status:'active',
  });
  return center;
}

async function addProfile({
  careProfileId, patientName, status='linked', emergencyName='', emergencyPhone='', familyPhone='',
} = {}) {
  return db.CareProfiles.insert({
    care_profile_id:careProfileId, patient_name:patientName, status,
    owner_line_id:'U-FAMILY-RAW-9876', emergency_contact_name:emergencyName,
    emergency_contact_phone:emergencyPhone, family_phone:familyPhone,
    blood_type:'AB', chronic_conditions:['ข้อมูลที่ห้ามแสดง'], drug_allergies:'ข้อมูลที่ห้ามแสดง',
  });
}

async function addResident({
  residentId, centerId='CTR-HISTORY', careProfileId=null, name, room=null, status='active',
  familyPhone=null, createdAt='2026-01-10T03:00:00.000Z', ...timestamps
}) {
  return db.Residents.insert({
    resident_id:residentId, center_id:centerId, care_profile_id:careProfileId,
    full_name:name, room, status, family_phone:familyPhone, created_at:createdAt, ...timestamps,
  });
}

test('active is the only current Resident state and current count excludes every ended state', async () => {
  await seedCenter();
  await addResident({ residentId:'R-ACTIVE', name:'ป้าศรี', room:'A101' });
  await addResident({ residentId:'R-DIS', name:'จำหน่ายแล้ว', status:'discharged' });
  await addResident({ residentId:'R-TRANSFER', name:'ย้ายแล้ว', status:'transferred' });
  await addResident({ residentId:'R-CANCEL', name:'ยกเลิกแล้ว', status:'cancelled' });
  await addResident({ residentId:'R-INACTIVE', name:'ไม่ได้พักแล้ว', status:'inactive' });
  await addResident({ residentId:'R-COMPLETE', name:'จบบริการแล้ว', status:'completed' });

  const result = await subscriptionService.getAdminCenterDetails('CTR-HISTORY');
  assert.deepEqual(result.currentResidents.map((row) => row.displayName), ['ป้าศรี']);
  assert.equal(result.counts.currentResidents, 1);
  assert.equal(result.counts.historicalResidents, 5);
  assert.equal(result.residents, undefined, 'unbounded compatibility Resident rows are not projected');
  assert.equal(result.profiles, undefined, 'Care Profile inventory is not exposed in ordinary Admin detail');
});

test('history contains discharged/transferred/cancelled residents once with safe Thai labels', async () => {
  await seedCenter();
  await addResident({ residentId:'R-DIS', name:'คุณหนึ่ง', status:'discharged' });
  await addResident({ residentId:'R-TRANSFER', name:'คุณสอง', status:'transferred' });
  await addResident({ residentId:'R-CANCEL', name:'คุณสาม', status:'cancelled' });
  const result = await subscriptionService.getAdminCenterDetails('CTR-HISTORY');
  assert.deepEqual(new Set(result.residentHistory.map((row) => row.statusLabel)), new Set([
    'สิ้นสุดการพัก', 'ย้ายสถานที่ดูแล', 'ยกเลิกการเข้าพัก',
  ]));
  assert.equal(result.currentResidents.length, 0);
  assert.equal(new Set(result.residentHistory.map((row) => row.displayName)).size, 3);
});

test('ordinary Admin Resident projection omits emergency and family contact details', async () => {
  await seedCenter();
  await addProfile({ careProfileId:'CP-EXPLICIT', patientName:'คุณหนึ่ง', emergencyName:'คุณลูก', emergencyPhone:'0811111111', familyPhone:'0822222222' });
  await addProfile({ careProfileId:'CP-FAMILY', patientName:'คุณสอง', familyPhone:'0833333333' });
  await addResident({ residentId:'R-1', careProfileId:'CP-EXPLICIT', name:'คุณหนึ่ง', room:'ห้อง 1', familyPhone:'0844444444' });
  await addResident({ residentId:'R-2', careProfileId:'CP-FAMILY', name:'คุณสอง', familyPhone:'0855555555' });
  await addResident({ residentId:'R-3', name:'คุณสาม', familyPhone:'0866666666' });
  await addResident({ residentId:'R-4', name:'คุณสี่' });

  const result = await subscriptionService.getAdminCenterDetails('CTR-HISTORY');
  const byName = new Map(result.currentResidents.map((row) => [row.displayName, row]));
  assert.deepEqual(byName.get('คุณหนึ่ง'), { displayName:'คุณหนึ่ง', room:'ห้อง 1' });
  assert.deepEqual(byName.get('คุณสอง'), { displayName:'คุณสอง', room:null });
  assert.deepEqual(byName.get('คุณสาม'), { displayName:'คุณสาม', room:null });
  assert.deepEqual(byName.get('คุณสี่'), { displayName:'คุณสี่', room:null });
  assert.doesNotMatch(JSON.stringify(result.currentResidents), /0811111111|0833333333|0866666666|emergency|familyPhone/i);
});

test('history retains former room and uses only authoritative lifecycle timestamps', async () => {
  await seedCenter();
  await addResident({
    residentId:'R-DIS', name:'คุณจำหน่าย', room:'A201', status:'discharged',
    createdAt:'2026-01-02T03:00:00.000Z', discharged_at:'2026-02-03T03:00:00.000Z',
  });
  await addResident({
    residentId:'R-TRANSFER', name:'คุณย้าย', room:'B202', status:'transferred',
    createdAt:'2026-03-04T03:00:00.000Z', transferred_at:'2026-04-05T03:00:00.000Z',
  });
  await addResident({
    residentId:'R-NO-END', name:'คุณไม่ระบุวัน', room:'C303', status:'cancelled',
    createdAt:'2026-05-06T03:00:00.000Z', updated_at:'2099-01-01T00:00:00.000Z',
  });
  const result = await subscriptionService.getAdminCenterDetails('CTR-HISTORY');
  const byName = new Map(result.residentHistory.map((row) => [row.displayName, row]));
  assert.equal(byName.get('คุณจำหน่าย').room, 'A201');
  assert.equal(byName.get('คุณจำหน่าย').startedAt, '2026-01-02T03:00:00.000Z');
  assert.equal(byName.get('คุณจำหน่าย').endedAt, '2026-02-03T03:00:00.000Z');
  assert.equal(byName.get('คุณย้าย').endedAt, '2026-04-05T03:00:00.000Z');
  assert.equal(byName.get('คุณไม่ระบุวัน').endedAt, null, 'generic updated_at is not a residency end date');
});

test('Resident status alone controls classification regardless of Care Profile status', async () => {
  await seedCenter();
  await addProfile({ careProfileId:'CP-INDEPENDENT', patientName:'โปรไฟล์อิสระ', status:'independent' });
  await addProfile({ careProfileId:'CP-LINKED', patientName:'โปรไฟล์เชื่อมอยู่', status:'linked' });
  await addResident({ residentId:'R-CURRENT', careProfileId:'CP-INDEPENDENT', name:'ผู้พักปัจจุบัน', status:'active' });
  await addResident({ residentId:'R-HISTORY', careProfileId:'CP-LINKED', name:'ผู้พักเดิม', status:'discharged' });
  const result = await subscriptionService.getAdminCenterDetails('CTR-HISTORY');
  assert.deepEqual(result.currentResidents.map((row) => row.displayName), ['ผู้พักปัจจุบัน']);
  assert.deepEqual(result.residentHistory.map((row) => row.displayName), ['ผู้พักเดิม']);
});

test('resident without Care Profile is projected safely without fabricated contact or dates', async () => {
  await seedCenter();
  await addResident({ residentId:'R-PLAIN', name:'ผู้พักไม่มีโปรไฟล์', room:null, createdAt:null });
  const result = await subscriptionService.getAdminCenterDetails('CTR-HISTORY');
  assert.deepEqual(result.currentResidents[0], {
    displayName:'ผู้พักไม่มีโปรไฟล์', room:null,
  });
});

test('new operational projection excludes clinical fields and raw LINE identifiers', async () => {
  await seedCenter();
  await addProfile({ careProfileId:'CP-PRIVATE', patientName:'คุณปลอดภัย', emergencyName:'ผู้ติดต่อ', emergencyPhone:'0811111111' });
  await addResident({ residentId:'R-PRIVATE', careProfileId:'CP-PRIVATE', name:'คุณปลอดภัย' });
  const result = await subscriptionService.getAdminCenterDetails('CTR-HISTORY');
  const projection = JSON.stringify({
    currentResidents:result.currentResidents, residentHistory:result.residentHistory, counts:result.counts,
  });
  assert.doesNotMatch(projection, /blood|chronic|allerg|medication|lab|vital|daily|doctor|consultation/i);
  assert.doesNotMatch(projection, /U-OWNER|U-FAMILY|line_user|group_id|care_profile_id|resident_id/i);
});

test('Admin detail route is Admin-only, bounded and excludes compatibility inventories', async () => {
  await seedCenter();
  await addResident({ residentId:'R-ACTIVE', name:'ผู้พักปัจจุบัน', status:'active' });
  await addResident({ residentId:'R-OLD', name:'ผู้พักเดิม', status:'discharged', discharged_at:'2026-01-20T00:00:00.000Z' });
  let response = await fetch(`${baseUrl}/api/admin/centers/CTR-HISTORY`);
  assert.equal(response.status, 401);
  response = await fetch(`${baseUrl}/api/admin/centers/CTR-HISTORY`, { headers:{ 'X-Admin-Key':'wrong' } });
  assert.equal(response.status, 401);
  response = await fetch(`${baseUrl}/api/admin/centers/CTR-HISTORY`, { headers:{ 'X-Admin-Key':process.env.ADMIN_API_KEY } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.currentResidents.length, 1);
  assert.equal(body.residentHistory.length, 1);
  assert.deepEqual(body.counts, { currentResidents:1, historicalResidents:1 });
  assert.equal(body.residents, undefined);
  assert.equal(body.profiles, undefined);
  assert.deepEqual(body.residentPagination.current, { page:1, limit:20, total:1, totalPages:1 });
  assert.deepEqual(body.residentPagination.history, { page:1, limit:20, total:1, totalPages:1 });
});

test('directory search and subscription filters keep the authoritative active-only resident count', async () => {
  await seedCenter();
  await addResident({ residentId:'R-ACTIVE', name:'ผู้พักปัจจุบัน', status:'active' });
  await addResident({ residentId:'R-OLD', name:'ผู้พักเดิม', status:'discharged' });
  const unfiltered = await directoryService.listAdminCenters({ search:'ศูนย์ทดสอบ', subscriptionStatus:'all' });
  assert.equal(unfiltered.items[0].activeResidentCount, 1);
  const filtered = await directoryService.listAdminCenters({
    search:'ศูนย์ทดสอบ', subscriptionStatus:unfiltered.items[0].directoryStatus,
  });
  assert.equal(filtered.items[0].activeResidentCount, 1);
  const details = await subscriptionService.getAdminCenterDetails('CTR-HISTORY');
  assert.equal(details.counts.currentResidents, 1);
  assert.equal(details.counts.historicalResidents, 1);
});

test('System Admin UI consumes backend classification and never guesses Resident status', () => {
  const detailSource = adminHtml.slice(adminHtml.indexOf('function currentResidentCard'), adminHtml.indexOf('async function start'));
  const cardSource = detailSource.slice(0, detailSource.indexOf('function setCenterDetailTab'));
  assert.match(detailSource, /d\.currentResidents\|\|\[\]/);
  assert.match(detailSource, /d\.residentHistory\|\|\[\]/);
  assert.match(detailSource, /d\.counts\|\|/);
  assert.doesNotMatch(cardSource, /resident\.status|status==='active'|careProfileLinked|careProfile\.status/);
  assert.doesNotMatch(detailSource, /current\s*=.*\.filter|history\s*=.*\.filter/);
  assert.doesNotMatch(detailSource, /\/care-profiles/);
  assert.match(adminHtml, /ผู้พักปัจจุบัน \$\{esc\(c\.activeResidentCount\)\} คน/);
});

test('current and history cards show minimized coordination fields without contact or technical state', () => {
  const detailSource = adminHtml.slice(adminHtml.indexOf('function currentResidentCard'), adminHtml.indexOf('async function start'));
  for (const label of ['ผู้พักปัจจุบัน', 'ประวัติผู้พัก', 'ห้อง:', 'ห้องเดิม:', 'ช่วงเวลาพัก:', 'สถานะ:']) {
    assert.match(detailSource, new RegExp(label));
  }
  assert.match(detailSource, /ไม่ระบุ/);
  assert.doesNotMatch(detailSource, /emergencyContact|familyPhone|โทร:|Care Profile|careProfileId|residentId|Group ID|link_status/);
});

test('active Center Staff Group is authoritative and Center detail exposes safe team summary', async () => {
  await seedCenter();
  await db.GroupBindings.insert({ binding_id:'GB-STAFF', kind:'center_staff', center_id:'CTR-HISTORY',
    line_group_id:'G-RAW-SECRET', status:'active' });
  await db.CenterStaff.insert({ staff_id:'STF-MANAGER', center_id:'CTR-HISTORY', line_user_id:'U-MANAGER-RAW',
    display_name:'ผู้จัดการหนึ่ง', role:'manager', status:'active' });
  const result = await subscriptionService.getAdminCenterDetails('CTR-HISTORY');
  assert.equal(result.groupReadiness.centerStaffGroupReady, true);
  assert.deepEqual(result.staffSummary, { total:2, owner:1, manager:1, staff:0 });
  assert.doesNotMatch(JSON.stringify(result), /G-RAW-SECRET|U-MANAGER-RAW|U-OWNER-RAW/);
});

test('mobile structure keeps history secondary, touch-safe and long names contained', () => {
  assert.match(adminHtml, /<details class="resident-history">/);
  assert.match(adminHtml, /resident-history summary\{[^}]*min-height:44px/);
  assert.match(adminHtml, /admin-resident-card\{[^}]*overflow-wrap:anywhere/);
  assert.match(adminHtml, /dialog\{[^}]*max-height:85vh;overflow:auto/);
  assert.match(adminHtml, /history\.map\(historyResidentCard\)/);
  assert.match(adminHtml, /current\.map\(currentResidentCard\)/);
});
