const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const familyService = require('../backend/services/familyService');
const groupBindingService = require('../backend/services/groupBindingService');
const accessService = require('../backend/services/accessService');

beforeEach(() => db.resetAll());

test('เจ้าของคนเดียวมีหลายสาขาและเลือก active branch ได้', async () => {
  const a = await centerService.createCenter({ name: 'สาขา A', ownerLineId: 'U_OWNER' });
  const b = await centerService.createCenter({ name: 'สาขา B', ownerLineId: 'U_OWNER' });
  const centers = await centerService.listCentersByStaffUser('U_OWNER');
  assert.strictEqual(centers.length, 2);
  assert.strictEqual((await centerService.findCenterByStaffUser('U_OWNER')), null, 'หลายสาขาต้องไม่เดาสาขา');
  await centerService.setActiveCenterForStaff('U_OWNER', b.center_id);
  assert.strictEqual((await centerService.findCenterByStaffUser('U_OWNER')).center_id, b.center_id);
  assert.notStrictEqual(a.center_id, b.center_id);
});

test('รหัส STAFF ผูกกลุ่มพนักงานโดยไม่สับสนกับกลุ่มครอบครัว', async () => {
  const center = await centerService.createCenter({ name: 'สาขา A', ownerLineId: 'U_OWNER' });
  const token = await groupBindingService.createStaffBindingToken(center.center_id, 'U_OWNER');
  const result = await groupBindingService.consumeCodeFromGroup({ code: token.code, groupId: 'G_STAFF', senderLineId: 'U_OWNER' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.kind, 'center_staff');
  assert.strictEqual((await centerService.findCenterByGroup('G_STAFF')).center_id, center.center_id);
});

test('พนักงานออกจากกลุ่มแล้วสิทธิ์สาขาหายทันที แต่ owner ไม่ถูกลบอัตโนมัติ', async () => {
  const center = await centerService.createCenter({ name: 'สาขา A', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G_STAFF', requesterLineId: 'U_OWNER' });
  await centerService.recordStaffFromGroup('G_STAFF', 'U_STAFF');
  assert.ok(await db.CenterStaff.findOne((s) => s.line_user_id === 'U_STAFF'));
  await centerService.removeStaffFromGroup('G_STAFF', 'U_STAFF');
  assert.strictEqual(await db.CenterStaff.findOne((s) => s.line_user_id === 'U_STAFF'), null);
  await centerService.removeStaffFromGroup('G_STAFF', 'U_OWNER');
  assert.ok(await db.CenterStaff.findOne((s) => s.line_user_id === 'U_OWNER' && s.role === 'owner'));
});

test('พนักงานที่ถูกถอนสิทธิ์กลับเข้ากลุ่มเดิมได้ แต่ต้องรออนุมัติใหม่', async () => {
  process.env.REQUIRE_STAFF_APPROVAL = 'true';
  const center = await centerService.createCenter({ name:'สาขา A', ownerLineId:'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId:center.center_id, groupId:'G_STAFF', requesterLineId:'U_OWNER' });
  await db.CenterStaff.insert({ staff_id:'STF_RETURN', center_id:center.center_id, line_user_id:'U_RETURN', role:'staff', status:'active' });
  assert.strictEqual((await centerService.revokeStaff({ centerId:center.center_id, targetLineId:'U_RETURN', requesterLineId:'U_OWNER' })).ok, true);
  const rejoined = await centerService.recordStaffFromGroup('G_STAFF', 'U_RETURN');
  assert.strictEqual(rejoined.status, 'pending');
  assert.strictEqual((await centerService.approveStaff({ centerId:center.center_id, targetLineId:'U_RETURN', requesterLineId:'U_OWNER' })).ok, true);
  assert.strictEqual((await db.CenterStaff.findOne((s) => s.staff_id === 'STF_RETURN')).status, 'active');
  delete process.env.REQUIRE_STAFF_APPROVAL;
});

test('ศูนย์สร้าง Care Profile ก่อน แล้วญาติรับสิทธิ์ภายหลังโดยข้อมูลเดิมไม่หาย', async () => {
  const center = await centerService.createCenter({ name:'สาขา A', ownerLineId:'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId:center.center_id, fullName:'คุณยาย', familyPhone:'0811111111' });
  const created = await centerService.createCenterManagedCareProfile({
    centerId:center.center_id, residentId:resident.resident_id, requesterLineId:'U_OWNER',
    profileData:{ bloodType:'O+', chronicConditions:['เบาหวาน'], drugAllergies:'Penicillin' },
  });
  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.profile.owner_line_id, null);
  const invite = await centerService.getOrCreateResidentInvite({ centerId:center.center_id, residentId:resident.resident_id });
  const token = new URL(invite.inviteUrl).searchParams.get('invite');
  const claimed = await familyService.acceptInvite(token, 'U_FAMILY');
  assert.strictEqual(claimed.ok, true);
  assert.strictEqual(claimed.careProfile.owner_line_id, 'U_FAMILY');
  assert.strictEqual(claimed.careProfile.blood_type, 'O+');
  assert.deepStrictEqual(claimed.careProfile.chronic_conditions, ['เบาหวาน']);
});

test('Care Profile เก็บข้อมูลสุขภาพครบและรายการยาเป็น snapshot ย้อนหลังได้', async () => {
  const profile = await familyService.createIndependentProfile({
    ownerLineId: 'U_FAMILY', patientName: 'คุณยาย', gender: 'female', bloodType: 'O+',
    heightCm: 155, weightKg: 52, chronicConditions: ['เบาหวาน'], drugAllergies: 'Penicillin',
    foodAllergies: 'กุ้ง', mobilityLimitations: 'ใช้ไม้เท้า', emergencyContactName: 'ลูกสาว', emergencyContactPhone: '0811111111',
  });
  assert.deepStrictEqual(profile.chronic_conditions, ['เบาหวาน']);
  assert.strictEqual(profile.blood_type, 'O+');
  await familyService.recordMedicationSnapshot({ careProfileId: profile.care_profile_id,
    items: [{ name: 'Metformin', dose: 'หลังอาหาร', condition: 'เบาหวาน' }], recordedBy: 'U_FAMILY' });
  const history = await familyService.getMedicationHistory(profile.care_profile_id);
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].items[0].condition, 'เบาหวาน');
});

test('อนุมัติ Care Profile เดิมแล้วผูกกลับ Resident ที่ร้องขอจริง', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U_FAMILY', patientName: 'คุณยาย', familyPhone: '0812345678' });
  const center = await centerService.createCenter({ name: 'สาขา A', ownerLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'คุณยาย' });
  const { request } = await accessService.createAccessRequest({ centerId: center.center_id, careProfileId: profile.care_profile_id,
    residentId: resident.resident_id, requestedBy: 'U_OWNER' });
  await accessService.respondAccessRequest(request.request_id, true, 'U_FAMILY');
  const linkedResident = await db.Residents.findOne((r) => r.resident_id === resident.resident_id);
  assert.strictEqual(linkedResident.care_profile_id, profile.care_profile_id);
});
