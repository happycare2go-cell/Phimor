const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const centerHtml = fs.readFileSync(path.join(__dirname, '../liff-app/center-admin/index.html'), 'utf8');
const familyHtml = fs.readFileSync(path.join(__dirname, '../liff-app/family/index.html'), 'utf8');
const webhookSource = fs.readFileSync(path.join(__dirname, '../backend/routes/webhook.js'), 'utf8');

test('Center UI keeps Family group binding and ownership claim as separate operational sections', () => {
  assert.match(centerHtml, /<h4>กลุ่มครอบครัว<\/h4>/);
  assert.match(centerHtml, /ยังไม่ได้เชื่อมกลุ่มครอบครัว/);
  assert.match(centerHtml, /เชื่อมกลุ่มครอบครัวแล้ว/);
  assert.match(centerHtml, /สร้างรหัสผูกกลุ่มครอบครัว/);
  assert.match(centerHtml, /<h4>เจ้าของ Care Profile<\/h4>/);
  assert.match(centerHtml, /ยังไม่มีเจ้าของข้อมูลหลัก/);
  assert.match(centerHtml, /ญาติรับสิทธิ์เจ้าของข้อมูลแล้ว/);
  assert.match(centerHtml, /สร้างลิงก์ส่งสิทธิ์ให้ญาติ/);
});

test('Center code UI is one-time, in-memory, 15-minute copy UX and has mobile touch sizing', () => {
  assert.match(centerHtml, /CENTER_GROUP_CODE_DISPLAY = new Map\(\)/);
  assert.match(centerHtml, /family-group-binding-token/);
  assert.match(centerHtml, /หมดอายุ/);
  assert.match(centerHtml, /ภายใน 15 นาที/);
  assert.match(centerHtml, /ใช้รหัสนี้เฉพาะในกลุ่มครอบครัวของผู้พักรายนี้/);
  assert.match(centerHtml, /รหัสใช้ได้ครั้งเดียวและหมดอายุใน 15 นาที/);
  assert.match(centerHtml, /การเชื่อมกลุ่มไม่โอนสิทธิ์เจ้าของ Care Profile/);
  assert.match(centerHtml, /ต้องส่งลิงก์สิทธิ์ให้ญาติยืนยันแยกต่างหาก/);
  assert.match(centerHtml, /คัดลอกรหัส/);
  assert.match(centerHtml, /\.resident-care-section \.btn\{[^}]*min-height:44px/);
  assert.match(centerHtml, /@media\(max-width:430px\)/);
  assert.match(centerHtml, /\.toast\{[^}]*pointer-events:none;z-index:99/);
  assert.match(centerHtml, /\.modal-bg\{[^}]*z-index:100/);
  assert.match(centerHtml, /pagehide[^\n]*CENTER_GROUP_CODE_DISPLAY\.clear\(\)/);
  assert.match(centerHtml, /selectCenter\(centerId\)[\s\S]*?CENTER_GROUP_CODE_DISPLAY\.clear\(\)/);
  assert.doesNotMatch(centerHtml, /localStorage[^\n]*CENTER_GROUP|sessionStorage[^\n]*CENTER_GROUP/);
});

test('Family connected state is source-agnostic and hides duplicate owner-code issuance', () => {
  assert.match(familyHtml, /active\?'เชื่อมกลุ่มครอบครัวแล้ว':'ยังไม่ได้เชื่อมกลุ่มครอบครัว'/);
  assert.match(familyHtml, /familyBindingAction'\)\.hidden=active\|\|!isOwner/);
  assert.match(familyHtml, /if\(currentProfile\.familyGroup\?\.active\)return toast\('Care Profile นี้เชื่อมกลุ่มครอบครัวแล้ว'\)/);
});

test('ownership claim bearer is removed from browser history after authenticated invite bootstrap', () => {
  const start = familyHtml.indexOf("if (INVITE_TOKEN) {");
  const end = familyHtml.indexOf("if (SHARE_TOKEN)", start);
  const claimBootstrap = familyHtml.slice(start, end);
  assert.match(claimBootstrap, /await api\('\/api\/invite\/'/);
  assert.match(claimBootstrap, /history\.replaceState\(\{\},'',location\.pathname\)/);
  assert.doesNotMatch(claimBootstrap, /localStorage|sessionStorage/);
});

test('LINE webhook recognizes the distinct CGROUP namespace and returns safe copy', () => {
  assert.match(webhookSource, /CGROUP-\[A-F0-9\]\{32\}/);
  assert.match(webhookSource, /✅ เชื่อมกลุ่มนี้กับ Care Profile เรียบร้อยแล้ว/);
  assert.match(webhookSource, /STAFF-xxxxxx, FAMILY-xxxxxx หรือ CGROUP-xxxxxx/);
});
