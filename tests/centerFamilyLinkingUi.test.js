const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const centerHtml = fs.readFileSync(path.join(root, 'liff-app', 'center-admin', 'index.html'), 'utf8');
const familyHtml = fs.readFileSync(path.join(root, 'liff-app', 'family', 'index.html'), 'utf8');

function source(html, name, nextName) {
  const start = html.indexOf(`function ${name}`);
  const end = nextName ? html.indexOf(`function ${nextName}`, start + 1) : html.length;
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return html.slice(start, end);
}

test('Center Resident onboarding presents two distinct actions and Flow A has no person form', () => {
  assert.match(centerHtml, /เพิ่มผู้พัก \/ ผู้ใช้บริการ/);
  assert.match(centerHtml, /เชื่อม Care Profile ที่มีอยู่แล้ว/);
  assert.match(centerHtml, /สำหรับครอบครัวที่ใช้พี่หมออยู่แล้ว/);
  assert.match(centerHtml, /สร้าง Care Profile ใหม่/);
  assert.match(centerHtml, /สำหรับผู้ที่ยังไม่มี Care Profile/);
  const start = centerHtml.indexOf('id="existingProfileLinkPanel"');
  const end = centerHtml.indexOf('id="newCareProfilePanel"', start);
  const existingPanel = centerHtml.slice(start, end);
  assert.doesNotMatch(existingPanel, /id="newFullName"|id="newPhone"|<input|<textarea/);
  assert.match(existingPanel, /ยังไม่สร้างผู้พัก และไม่ต้องกรอกชื่อหรือเบอร์โทร/);
});

test('Center Flow A generates one seven-day link while Flow B reuses Resident and Center-managed profile APIs', () => {
  const existing = source(centerHtml, 'createExistingProfileLink', 'askConfirm');
  assert.match(existing, /\/api\/center\/care-profile-link-requests/);
  assert.match(existing, /ลิงก์ใช้ได้ 7 วัน และเชื่อมได้ 1 Care Profile/);
  assert.match(existing, /คัดลอกลิงก์/);
  assert.doesNotMatch(existing, /fullName|familyPhone|patientName/);
  const add = source(centerHtml, 'addResident', 'openEditResident');
  assert.match(add, /\/api\/residents/);
  assert.match(add, /openCreateCareProfile\(result\.residentId\)/);
  assert.doesNotMatch(add, /accessRequestSent|findProfileByPhone|เจอ Care Profile เดิม/);
  assert.match(centerHtml, /\/api\/residents\/\$\{cpResidentId\.value\}\/care-profile/);
  assert.match(centerHtml, /\/api\/residents\/\$\{residentId\}\/invite/);
});

test('Family Access inbox has one anonymous consent lifecycle with single selection and distinct close/decline', () => {
  const render = source(familyHtml, 'renderAccessRequests', 'closeAccessRequestView');
  assert.match(render, /anonymous_existing_profile_link/);
  assert.match(render, /role="radiogroup"/);
  assert.match(render, /type="radio"/);
  assert.match(render, /เลือก 1 Care Profile/);
  assert.match(render, /กลับ \/ ปิด/);
  assert.match(render, /ปฏิเสธ/);
  assert.match(render, /ยืนยันเชื่อม/);
  const close = source(familyHtml, 'closeAccessRequestView', 'approveAnonymousAccess');
  assert.doesNotMatch(close, /api\(|fetch\(|respond/);
  const decline = source(familyHtml, 'declineAccessRequest', 'respondAccess');
  assert.match(decline, /approved:false/);
  assert.match(decline, /askConfirm/);
});

test('Family anonymous link supports first-open bootstrap and later owner-wide Access resume without browser persistence', () => {
  assert.match(familyHtml, /centerLink/);
  const dashboard = source(familyHtml, 'loadDashboard', 'selectProfile');
  assert.match(dashboard, /\/api\/access-links\/.*\/open/);
  assert.match(dashboard, /history\.replaceState\(\{\},'',location\.pathname\)/);
  const loadAccess = source(familyHtml, 'loadAccessRequests', 'renderAccessRequests');
  assert.match(loadAccess, /\/api\/access-requests/);
  assert.match(loadAccess, /request\.requestKind==='anonymous_existing_profile_link'/);
  assert.doesNotMatch(familyHtml, /localStorage|sessionStorage/);
  assert.doesNotMatch(familyHtml, /centerLink.*localStorage|careProfileId.*localStorage/i);
});

test('Family linking UI prevents stale/double submission and keeps mobile actions accessible', () => {
  const approve = source(familyHtml, 'approveAnonymousAccess', 'declineAccessRequest');
  assert.match(approve, /ACTIVE_ACCESS_SUBMISSIONS\.has/);
  assert.match(approve, /ACTIVE_ACCESS_SUBMISSIONS\.add/);
  assert.match(approve, /button\.disabled=true/);
  assert.match(approve, /finally\{ACTIVE_ACCESS_SUBMISSIONS\.delete/);
  assert.match(approve, /button\.disabled=false/);
  assert.match(familyHtml, /const token=\+\+DASHBOARD_GENERATION/);
  assert.match(familyHtml, /if\(token!==DASHBOARD_GENERATION\)return/);
  assert.match(familyHtml, /\.access-profile-option\{[^}]*min-height:48px/);
  assert.match(familyHtml, /\.access-request-actions \.btn\{min-height:44px\}/);
  assert.match(familyHtml, /#view-access\{padding-bottom:max\(24px,env\(safe-area-inset-bottom\)\)/);
  assert.match(familyHtml, /\.toast\{[^}]*z-index:99;pointer-events:none/);
  assert.match(familyHtml, /\.modal-bg\{[^}]*z-index:100/);
});

test('Flow B claim copy distinguishes accepting the same Center-created Care Profile and decline is server-authoritative', () => {
  assert.match(familyHtml, /รับ Care Profile ที่ศูนย์สร้างไว้/);
  assert.match(familyHtml, /รับสิทธิ์ใน Care Profile เดิม/);
  const close = source(familyHtml, 'closeCenterInvite', 'declineCenterInvite');
  assert.doesNotMatch(close, /api\(|fetch\(/);
  const decline = source(familyHtml, 'declineCenterInvite', 'saveAppointment');
  assert.match(decline, /\/api\/invite\/.*\/decline/);
  assert.match(decline, /confirmed:true/);
  assert.match(decline, /askConfirm/);
  assert.match(decline, /INVITE_SUBMISSION_ACTIVE/);
  assert.match(familyHtml, /function setCenterInviteBusy/);
});
