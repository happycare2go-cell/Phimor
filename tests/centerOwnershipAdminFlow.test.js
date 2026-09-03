process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');

const OLD_OWNER = `U${'1'.repeat(32)}`;
const NEW_OWNER = `U${'2'.repeat(32)}`;
const ADMIN = `U${'3'.repeat(32)}`;
const html = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'system-admin', 'index.html'), 'utf8');
const css = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'system-admin', 'ownership-transfer-ui.css'), 'utf8');
const uiSource = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'system-admin', 'ownership-transfer-ui.js'), 'utf8');

beforeEach(() => db.resetAll());

async function seed() {
  const center = await centerService.createCenter({ name:'ศูนย์ A', ownerLineId:OLD_OWNER });
  return center;
}

test('preview is read-only, verifies a non-member and returns only safe operational identity', async () => {
  const center = await seed();
  const centerBefore = JSON.stringify(await db.Centers.findOne((row) => row.center_id === center.center_id));
  const staffBefore = JSON.stringify(await db.CenterStaff.findWhere((row) => row.center_id === center.center_id));
  const preview = await centerService.previewOwnerTransfer({
    centerId:center.center_id, newOwnerLineId:NEW_OWNER, keepPreviousAsManager:false,
    verifyLineProfile:async (userId) => ({ userId, displayName:'คุณเจ้าของใหม่' }),
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.newOwner.displayName, 'คุณเจ้าของใหม่');
  assert.equal(preview.newOwner.existingCenterRole, null);
  assert.deepEqual(preview.impact, {
    centerDataPreserved:true, familyConsentPreserved:true, careProfileOwnershipPreserved:true,
  });
  assert.doesNotMatch(JSON.stringify(preview), new RegExp(NEW_OWNER));
  assert.equal(JSON.stringify(await db.Centers.findOne((row) => row.center_id === center.center_id)), centerBefore);
  assert.equal(JSON.stringify(await db.CenterStaff.findWhere((row) => row.center_id === center.center_id)), staffBefore);
});

test('preview and transfer independently verify the target profile', async () => {
  const center = await seed();
  let verifications = 0;
  const verifyLineProfile = async (userId) => {
    verifications += 1;
    return { userId, displayName:'เจ้าของใหม่' };
  };
  assert.equal((await centerService.previewOwnerTransfer({
    centerId:center.center_id, newOwnerLineId:NEW_OWNER, verifyLineProfile,
  })).ok, true);
  assert.equal((await centerService.transferOwner({
    centerId:center.center_id, newOwnerLineId:NEW_OWNER, actor:`admin:${ADMIN}`, verifyLineProfile,
  })).ok, true);
  assert.equal(verifications, 2);
});

test('ownership history projection is bounded and never forwards arbitrary audit metadata', async () => {
  const center = await seed();
  for (let index = 0; index < 55; index += 1) {
    await db.audit('center.owner_transferred', `admin:${ADMIN}`, {
      centerId:center.center_id,
      previousOwnerLineId:OLD_OWNER,
      newOwnerLineId:NEW_OWNER,
      keepPreviousAsManager:index % 2 === 0,
      clinicalPayload:'MUST_NOT_LEAK',
    });
  }
  const result = await centerService.listOwnershipHistory(center.center_id, 500);
  assert.equal(result.items.length, 50);
  assert.deepEqual(Object.keys(result.items[0]).sort(), [
    'newOwner', 'operator', 'previousOwner', 'previousOwnerOutcome', 'transferredAt',
  ]);
  assert.doesNotMatch(JSON.stringify(result), /MUST_NOT_LEAK|clinicalPayload/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(NEW_OWNER));
});

test('System Admin transfer UI requires preview then explicit confirmation and explains preserved data', () => {
  for (const copy of [
    'โอนสิทธิ์เจ้าของศูนย์', 'ตรวจสอบบัญชี', 'ยืนยันการโอนสิทธิ์',
    'สิทธิ์การดูแลข้อมูลผู้พักเป็นสิทธิ์ของศูนย์', 'ญาติไม่ต้องอนุญาตใหม่',
    'ประวัติการเปลี่ยนเจ้าของ', 'ถอดสิทธิ์เจ้าของเดิมออกจากศูนย์',
    'คงเจ้าของเดิมไว้เป็นผู้จัดการ',
  ]) assert.match(`${html}\n${uiSource}`, new RegExp(copy));
  assert.match(uiSource, /transfer-owner\/preview/);
  assert.match(uiSource, /previewIntent/);
  assert.match(uiSource, /if \(busy \|\| !context \|\| !preview \|\| !previewIntent\) return/);
  assert.doesNotMatch(uiSource, /Care Profile.*patient|resident.*name|clinicalPayload|owner_line_id/i);
});

test('mobile transfer dialog uses a non-overlapping header/body/footer layout with safe-area clearance', () => {
  assert.match(html, /ownership-transfer__header[\s\S]*ownership-transfer__body[\s\S]*ownership-transfer__footer/);
  assert.match(css, /grid-template-rows:auto minmax\(0,1fr\) auto/);
  assert.match(css, /ownership-transfer__body\{[^}]*overflow-y:auto/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /max-height:92dvh/);
  assert.match(css, /min-height:44px/);
  assert.doesNotMatch(css, /position:(fixed|sticky)/);
});
