// tests/richMenuService.test.js — ทดสอบการสร้างและเชื่อม Rich Menu

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../backend/db');
const richMenuService = require('../backend/services/richMenuService');
const centerService = require('../backend/services/centerService');
const lineClient = require('../backend/providers/lineClient');

beforeEach(() => {
  db.resetAll();
  lineClient.clearSentLog();
});

test('ensureMenu สร้างเมนูใหม่ครั้งแรก และคืน richMenuId เดิมถ้าเรียกซ้ำ (Idempotent)', async () => {
  const id1 = await richMenuService.ensureMenu(richMenuService.CENTER_ADMIN_KEY);
  const id2 = await richMenuService.ensureMenu(richMenuService.CENTER_ADMIN_KEY);
  assert.strictEqual(id1, id2, 'เรียกซ้ำต้องได้ ID เดิม ไม่สร้างเมนูซ้ำ');

  const created = lineClient.getSentLog().filter((s) => s.type === 'richmenu_create');
  assert.strictEqual(created.length, 1, 'ต้องเรียก API สร้างแค่ครั้งเดียวเท่านั้น');
});

test('ensureMenu อัปโหลดภาพให้ Rich Menu หลังสร้างเสร็จเสมอ', async () => {
  await richMenuService.ensureMenu(richMenuService.FAMILY_KEY);
  const uploaded = lineClient.getSentLog().find((s) => s.type === 'richmenu_upload_image');
  assert.ok(uploaded);
  assert.ok(uploaded.size > 0, 'ต้องมีขนาดไฟล์จริง ไม่ใช่ภาพว่างเปล่า');
});

test('setupAllMenus ตั้งเมนูฝั่งครอบครัวเป็นค่าเริ่มต้น', async () => {
  const { centerMenuId, familyMenuId } = await richMenuService.setupAllMenus();
  assert.ok(centerMenuId);
  assert.ok(familyMenuId);

  const setDefault = lineClient.getSentLog().find((s) => s.type === 'richmenu_set_default');
  assert.strictEqual(setDefault.richMenuId, familyMenuId, 'ต้องตั้งเมนูฝั่งครอบครัวเป็นค่าเริ่มต้น ไม่ใช่ฝั่งศูนย์');
});

test('linkCenterMenuToUser เชื่อมเมนูให้ตรงคนที่ระบุ', async () => {
  await richMenuService.linkCenterMenuToUser('U_OWNER');
  const linked = lineClient.getSentLog().find((s) => s.type === 'richmenu_link_user');
  assert.strictEqual(linked.userId, 'U_OWNER');
});

test('บันทึก Audit Log ทุกครั้งที่เชื่อมเมนู', async () => {
  await richMenuService.linkCenterMenuToUser('U_OWNER');
  const logs = await db.AuditLog.findWhere((l) => l.action === 'richmenu.linked');
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].actor_line_id, 'U_OWNER');
});

test('สร้างศูนย์ใหม่แล้ว เชื่อม Rich Menu ให้เจ้าของอัตโนมัติ (ไม่บังคับรอ เพราะไม่ใช่ของที่ขาดไม่ได้)', async () => {
  await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  // เป็น fire-and-forget ให้รอสักครู่ก่อนตรวจสอบ
  await new Promise((r) => setTimeout(r, 50));

  const linked = lineClient.getSentLog().find((s) => s.type === 'richmenu_link_user' && s.userId === 'U_OWNER');
  assert.ok(linked, 'เจ้าของศูนย์ใหม่ต้องได้รับการเชื่อม Rich Menu อัตโนมัติ');
});

test('แต่งตั้งผู้จัดการใหม่แล้ว เชื่อม Rich Menu ให้อัตโนมัติเช่นกัน', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  lineClient.clearSentLog(); // เคลียร์ล็อกของเจ้าของก่อน เพื่อตรวจเฉพาะผู้จัดการ

  await centerService.appointManager({ centerId: center.center_id, targetLineId: 'U_MGR', requesterLineId: 'U_OWNER' });
  await new Promise((r) => setTimeout(r, 50));

  const linked = lineClient.getSentLog().find((s) => s.type === 'richmenu_link_user' && s.userId === 'U_MGR');
  assert.ok(linked, 'ผู้จัดการใหม่ต้องได้รับการเชื่อม Rich Menu อัตโนมัติเช่นเดียวกับเจ้าของ');
});

test('ปุ่มในเมนูฝั่งศูนย์ต้องมีครบ 3 ปุ่มตามที่ออกแบบไว้ใน docs/RICHMENU_SETUP.md', () => {
  const def = richMenuService.MENU_DEFS[richMenuService.CENTER_ADMIN_KEY];
  assert.strictEqual(def.object.areas.length, 3);
  const labels = def.object.areas.map((a) => a.action.label);
  assert.deepStrictEqual(labels, ['จัดการผู้พัก', 'รอดำเนินการ', 'ติดต่อทีมงาน']);
});

test('ปุ่มในเมนูฝั่งครอบครัวต้องมีครบ 4 ปุ่มตามที่ออกแบบไว้', () => {
  const def = richMenuService.MENU_DEFS[richMenuService.FAMILY_KEY];
  assert.strictEqual(def.object.areas.length, 4);
  const labels = def.object.areas.map((a) => a.action.label);
  assert.deepStrictEqual(labels, ['หน้าหลัก', 'บันทึกนัด/ยา', 'ดูประวัติ', 'ติดต่อ Admin']);
});

test('ขนาดภาพต้องตรงตามข้อกำหนดของ LINE (2500x1686) ทั้งสองเมนู', () => {
  for (const key of [richMenuService.CENTER_ADMIN_KEY, richMenuService.FAMILY_KEY]) {
    const size = richMenuService.MENU_DEFS[key].object.size;
    assert.strictEqual(size.width, 2500);
    assert.strictEqual(size.height, 1686);
  }
});
