process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../backend/db');
const directory = require('../backend/services/adminCenterDirectoryService');
const subscription = require('../backend/services/subscriptionService');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'system-admin', 'index.html'), 'utf8');

test.beforeEach(() => db.resetAll());

test('directory uses one batched PostgreSQL projection for Residents, GroupBinding and capabilities', () => {
  assert.match(directory.DIRECTORY_SQL, /resident_counts AS/);
  assert.match(directory.DIRECTORY_SQL, /staff_groups AS/);
  assert.match(directory.DIRECTORY_SQL, /capability_counts AS/);
  assert.doesNotMatch(directory.DIRECTORY_SQL, /patient_name|emergency|medication|vital|lab|daily_care|line_group_id/i);
});

test('directory projects authoritative group readiness without exposing raw Group ID', async () => {
  await db.Centers.insert({ center_id:'CTR-A', name:'ศูนย์เอ', owner_line_id:'U-RAW-0001', status:'active', subscription_required:false });
  await db.CenterStaff.insert({ staff_id:'STF-A', center_id:'CTR-A', line_user_id:'U-RAW-0001', display_name:'เจ้าของเอ', role:'owner' });
  await db.GroupBindings.insert({ binding_id:'GB-A', kind:'center_staff', center_id:'CTR-A', line_group_id:'G-SECRET', status:'active' });
  const result = await directory.listAdminCenters({ page:1, limit:20 });
  assert.equal(result.items[0].centerStaffGroupReady, true);
  assert.equal(result.items[0].ownerIdentity, 'เจ้าของเอ');
  assert.doesNotMatch(JSON.stringify(result), /G-SECRET|U-RAW-0001/);
});

test('Center detail pagination remains bounded and current/history stay separate', async () => {
  await db.Centers.insert({ center_id:'CTR-A', name:'ศูนย์เอ', owner_line_id:'U-OWNER', status:'active', subscription_required:false });
  for (let index = 0; index < 55; index += 1) await db.Residents.insert({
    resident_id:`R-${index}`, center_id:'CTR-A', full_name:`ผู้พัก ${String(index).padStart(2, '0')}`,
    status:index < 30 ? 'active' : 'discharged', room:`A${index}`,
  });
  const result = await subscription.getAdminCenterDetails('CTR-A', { currentPage:2, historyPage:2, limit:20 });
  assert.equal(result.currentResidents.length, 10);
  assert.equal(result.residentHistory.length, 5);
  assert.equal(result.residentPagination.current.total, 30);
  assert.equal(result.residentPagination.history.total, 25);
  assert.equal(result.residents, undefined);
});

test('destination-native Center detail exposes seven operational sections at mobile-safe sizes', () => {
  for (const label of ['ภาพรวม','แพ็กเกจ','ความสามารถ','ผู้พัก','ทีมงานและสิทธิ์','กลุ่ม LINE','Audit / Advanced']) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /data-center-detail-tab/);
  assert.match(html, /data-center-detail-section/);
  assert.match(html, /admin-center-detail__tab\{[^}]*flex:0 0 auto/);
  assert.match(html, /@media\(max-width:600px\)\{\.admin-center-detail__facts\{grid-template-columns:1fr\}/);
  assert.doesNotMatch(html.slice(html.indexOf('function currentResidentCard'), html.indexOf('async function start')), /emergencyContactName|emergencyContactPhone|familyPhone/);
});
