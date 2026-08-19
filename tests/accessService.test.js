// tests/accessService.test.js — ทดสอบ FR-O การเชื่อมต่อศูนย์กับ Care Profile ที่มีอยู่แล้ว

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const accessService = require('../backend/services/accessService');
const lineClient = require('../backend/providers/lineClient');

beforeEach(() => {
  db.resetAll();
  lineClient.clearSentLog();
});

test('ข้อ O1: พบเบอร์ตรงกับ Care Profile เดิม → ส่งคำขอ ไม่เชื่อมอัตโนมัติ', async () => {
  const centerA = await centerService.createCenter({ name: 'ศูนย์ A (เดิม)', ownerLineId: 'U_OWNER_A' });
  const profile = await db.CareProfiles.insert({
    care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี ใจดี', center_id: null, status: 'independent',
  });
  await db.Residents.insert({
    resident_id: 'R-OLD', center_id: centerA.center_id, full_name: 'สมศรี ใจดี',
    family_phone: '0812345678', care_profile_id: profile.care_profile_id, status: 'discharged',
  });

  const centerB = await centerService.createCenter({ name: 'ศูนย์ B (ใหม่)', ownerLineId: 'U_OWNER_B' });
  const found = await accessService.findProfileByPhone('0812345678');
  assert.strictEqual(found.care_profile_id, 'CP-1');

  const request = await accessService.createAccessRequest({ centerId: centerB.center_id, careProfileId: found.care_profile_id, requestedBy: 'U_OWNER_B' });
  assert.strictEqual(request.ok, true);
  assert.strictEqual(request.request.status, 'pending');

  // ต้องยังไม่เชื่อมทันที
  const stillIndependent = await db.CareProfiles.findOne((p) => p.care_profile_id === 'CP-1');
  assert.strictEqual(stillIndependent.center_id, null, 'ห้ามเชื่อมอัตโนมัติ ต้องรอครอบครัวอนุมัติก่อน');

  const notified = lineClient.getSentLog().find((s) => s.to === 'U_FAMILY');
  assert.ok(notified, 'ต้องแจ้งครอบครัวว่ามีคำขอ');
});

test('ข้อ O2: ครอบครัวปฏิเสธได้โดยไม่ต้องระบุเหตุผล และศูนย์ไม่เห็นเหตุผล', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const profile = await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี', center_id: null, status: 'independent' });
  const { request } = await accessService.createAccessRequest({ centerId: center.center_id, careProfileId: profile.care_profile_id, requestedBy: 'U_OWNER' });

  const declineResult = await accessService.respondAccessRequest(request.request_id, false, 'U_FAMILY');
  assert.strictEqual(declineResult.ok, true);
  assert.strictEqual(declineResult.status, 'declined');

  const centerView = await accessService.getRequestStatusForCenter(request.request_id);
  assert.strictEqual(centerView.status, 'not_approved');
  assert.strictEqual('reason' in centerView, false, 'ศูนย์ต้องไม่เห็นฟิลด์เหตุผลเลย');

  const stillNotLinked = await db.CareProfiles.findOne((p) => p.care_profile_id === 'CP-1');
  assert.strictEqual(stillNotLinked.center_id, null);
});

test('ข้อ O2: ครอบครัวอนุมัติแล้ว Care Profile ผูกกับศูนย์นั้นทันที', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const profile = await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี', center_id: null, status: 'independent' });
  const { request } = await accessService.createAccessRequest({ centerId: center.center_id, careProfileId: profile.care_profile_id, requestedBy: 'U_OWNER' });

  const approveResult = await accessService.respondAccessRequest(request.request_id, true, 'U_FAMILY');
  assert.strictEqual(approveResult.ok, true);
  assert.strictEqual(approveResult.status, 'approved');

  const linked = await db.CareProfiles.findOne((p) => p.care_profile_id === 'CP-1');
  assert.strictEqual(linked.center_id, center.center_id);
  assert.strictEqual(linked.status, 'linked');
});

test('เฉพาะเจ้าของ Care Profile เท่านั้นที่ตอบคำขอได้', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const profile = await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี', center_id: null, status: 'independent' });
  const { request } = await accessService.createAccessRequest({ centerId: center.center_id, careProfileId: profile.care_profile_id, requestedBy: 'U_OWNER' });

  const byStranger = await accessService.respondAccessRequest(request.request_id, true, 'U_STRANGER');
  assert.strictEqual(byStranger.ok, false);
});

test('ข้อ O3: Care Profile ที่ผูกกับศูนย์อยู่แล้ว ไม่รับคำขอจากศูนย์อื่นซ้ำ', async () => {
  const centerA = await centerService.createCenter({ name: 'ศูนย์ A', ownerLineId: 'U_A' });
  const centerB = await centerService.createCenter({ name: 'ศูนย์ B', ownerLineId: 'U_B' });
  const profile = await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี', center_id: centerA.center_id, status: 'linked' });

  const request = await accessService.createAccessRequest({ centerId: centerB.center_id, careProfileId: profile.care_profile_id, requestedBy: 'U_B' });
  assert.strictEqual(request.ok, false);
  assert.ok(request.reason.includes('อีกศูนย์'));
});
