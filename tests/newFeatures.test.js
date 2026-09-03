const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const familyService = require('../backend/services/familyService');
const groupBindingService = require('../backend/services/groupBindingService');
const accessService = require('../backend/services/accessService');

const VALID_OWNER_A = `U${'a'.repeat(32)}`;
const VALID_OWNER_B = `U${'b'.repeat(32)}`;
const VALID_NEW_OWNER = `U${'c'.repeat(32)}`;

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

test('รายชื่อทีมงานไม่แสดง LINE User คนเดิมซ้ำ แม้มีข้อมูลเก่าซ้ำในฐานข้อมูล', async () => {
  const center = await centerService.createCenter({ name:'สาขา A', ownerLineId:'U_OWNER' });
  await db.CenterStaff.insert({ staff_id:'DUP', center_id:center.center_id, line_user_id:'U_OWNER', role:'owner', status:'active' });
  const staff = await centerService.listStaff(center.center_id);
  assert.strictEqual(staff.filter((s) => s.line_user_id === 'U_OWNER').length, 1);
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

test('CenterStaff legacy duplicates are all revoked and every stale Center context is removed', async () => {
  const center = await centerService.createCenter({ name:'สาขา A', ownerLineId:'U_OWNER' });
  await db.CenterStaff.insert({ staff_id:'STF-DUP-1', center_id:center.center_id, line_user_id:'U_DUP', role:'staff', status:'active' });
  await db.CenterStaff.insert({ staff_id:'STF-DUP-2', center_id:center.center_id, line_user_id:'U_DUP', role:'manager', status:'active' });
  await db.StaffContexts.insert({ context_id:'CTX-1', center_id:center.center_id, line_user_id:'U_DUP' });
  await db.StaffContexts.insert({ context_id:'CTX-2', center_id:center.center_id, line_user_id:'U_DUP' });

  const result = await centerService.revokeStaff({
    centerId:center.center_id, targetLineId:'U_DUP', requesterLineId:'U_OWNER', reason:'offboarded',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.revokedCount, 2);
  const rows = await db.CenterStaff.findWhere((row) => row.center_id === center.center_id && row.line_user_id === 'U_DUP');
  assert.strictEqual(rows.every((row) => row.status === 'revoked'), true);
  assert.strictEqual((await db.StaffContexts.findWhere((row) => row.center_id === center.center_id && row.line_user_id === 'U_DUP')).length, 0);
  assert.strictEqual((await centerService.listCentersByStaffUser('U_DUP')).length, 0);
  assert.strictEqual(await centerService.canApprove(center.center_id, 'U_DUP'), false);
});

test('revoking duplicate non-owner rows never revokes the owner row', async () => {
  const center = await centerService.createCenter({ name:'สาขา A', ownerLineId:'U_OWNER' });
  await db.CenterStaff.insert({ staff_id:'STF-OWNER-DUP', center_id:center.center_id, line_user_id:'U_OWNER', role:'staff', status:'active' });
  const result = await centerService.revokeStaff({
    centerId:center.center_id, targetLineId:'U_OWNER', requesterLineId:'U_OWNER',
  });
  assert.strictEqual(result.ok, true);
  const rows = await db.CenterStaff.findWhere((row) => row.center_id === center.center_id && row.line_user_id === 'U_OWNER');
  assert.strictEqual(rows.find((row) => row.role === 'owner').status, 'active');
  assert.strictEqual(rows.find((row) => row.staff_id === 'STF-OWNER-DUP').status, 'revoked');
});

test('concurrent staff discovery and promotion converge to one effective Center role', async () => {
  const center = await centerService.createCenter({ name:'สาขา A', ownerLineId:'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId:center.center_id, groupId:'G_STAFF', requesterLineId:'U_OWNER' });
  await Promise.all([
    centerService.recordStaffFromGroup('G_STAFF', 'U_RACE'),
    centerService.recordStaffFromGroup('G_STAFF', 'U_RACE'),
  ]);
  let rows = await db.CenterStaff.findWhere((row) => row.center_id === center.center_id && row.line_user_id === 'U_RACE' && (!row.status || row.status === 'active'));
  assert.strictEqual(rows.length, 1);
  const [appointed, duplicate] = await Promise.all([
    centerService.appointManager({ centerId:center.center_id, targetLineId:'U_RACE', requesterLineId:'U_OWNER' }),
    centerService.appointManager({ centerId:center.center_id, targetLineId:'U_RACE', requesterLineId:'U_OWNER' }),
  ]);
  assert.strictEqual([appointed, duplicate].filter((result) => result.ok).length, 1);
  rows = await db.CenterStaff.findWhere((row) => row.center_id === center.center_id && row.line_user_id === 'U_RACE' && (!row.status || row.status === 'active'));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].role, 'manager');
  const demoted = await centerService.removeManager({ centerId:center.center_id, targetLineId:'U_RACE', requesterLineId:'U_OWNER' });
  assert.strictEqual(demoted.ok, true);
  rows = await db.CenterStaff.findWhere((row) => row.center_id === center.center_id && row.line_user_id === 'U_RACE' && (!row.status || row.status === 'active'));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].role, 'staff');
});

test('duplicate manager and staff memberships converge through promotion and demotion', async () => {
  const center = await centerService.createCenter({ name:'สาขา A', ownerLineId:'U_OWNER' });
  await db.CenterStaff.insert({
    staff_id:'STF-MANAGER-DUP', center_id:center.center_id,
    line_user_id:'U_DUP_ROLE', role:'manager', status:'active', assigned_at:'2026-01-01T00:00:00.000Z',
  });
  await db.CenterStaff.insert({
    staff_id:'STF-STAFF-DUP', center_id:center.center_id,
    line_user_id:'U_DUP_ROLE', role:'staff', status:'active', assigned_at:'2026-01-02T00:00:00.000Z',
  });

  const alreadyManager = await centerService.appointManager({
    centerId:center.center_id, targetLineId:'U_DUP_ROLE', requesterLineId:'U_OWNER',
  });
  assert.strictEqual(alreadyManager.ok, false);
  let activeRows = await db.CenterStaff.findWhere((row) => row.center_id === center.center_id
    && row.line_user_id === 'U_DUP_ROLE' && (!row.status || row.status === 'active'));
  assert.strictEqual(activeRows.length, 1);
  assert.strictEqual(activeRows[0].role, 'manager');

  const demoted = await centerService.removeManager({
    centerId:center.center_id, targetLineId:'U_DUP_ROLE', requesterLineId:'U_OWNER',
  });
  assert.strictEqual(demoted.ok, true);
  activeRows = await db.CenterStaff.findWhere((row) => row.center_id === center.center_id
    && row.line_user_id === 'U_DUP_ROLE' && (!row.status || row.status === 'active'));
  assert.strictEqual(activeRows.length, 1);
  assert.strictEqual(activeRows[0].role, 'staff');
});

test('concurrent owner transfers serialize and only one stale command succeeds', async () => {
  const center = await centerService.createCenter({ name:'สาขา A', ownerLineId:'U_OWNER' });
  await db.CenterStaff.insert({
    staff_id:'STF-OWNER-SAME-IDENTITY-DUP', center_id:center.center_id,
    line_user_id:'U_OWNER', role:'owner', status:'active', assigned_at:'2026-01-02T00:00:00.000Z',
  });
  await db.CenterStaff.insert({
    staff_id:'STF-OWNER-OTHER-IDENTITY-DUP', center_id:center.center_id,
    line_user_id:'U_ROGUE_OWNER', role:'owner', status:'active', assigned_at:'2026-01-03T00:00:00.000Z',
  });
  await db.StaffContexts.insert({ context_id:'CTX-OWNER', center_id:center.center_id, line_user_id:'U_OWNER' });
  await db.StaffContexts.insert({ context_id:'CTX-ROGUE', center_id:center.center_id, line_user_id:'U_ROGUE_OWNER' });
  const results = await Promise.all([
    centerService.transferOwner({ centerId:center.center_id, newOwnerLineId:VALID_OWNER_A, actor:'U_ADMIN' }),
    centerService.transferOwner({ centerId:center.center_id, newOwnerLineId:VALID_OWNER_B, actor:'U_ADMIN' }),
  ]);

  assert.strictEqual(results.filter((result) => result.ok).length, 1);
  assert.strictEqual(results.filter((result) => result.conflict).length, 1);
  const updatedCenter = await db.Centers.findOne((row) => row.center_id === center.center_id);
  const activeOwners = await db.CenterStaff.findWhere((row) => row.center_id === center.center_id
    && row.role === 'owner' && (!row.status || row.status === 'active'));
  assert.strictEqual(activeOwners.length, 1);
  assert.strictEqual(activeOwners[0].line_user_id, updatedCenter.owner_line_id);
  assert.ok([VALID_OWNER_A, VALID_OWNER_B].includes(updatedCenter.owner_line_id));
  assert.strictEqual((await db.StaffContexts.findWhere((row) => row.center_id === center.center_id
    && row.line_user_id === 'U_OWNER')).length, 0);
  assert.strictEqual((await db.StaffContexts.findWhere((row) => row.center_id === center.center_id
    && row.line_user_id === 'U_ROGUE_OWNER')).length, 0);
  const priorOwnerRows = await db.CenterStaff.findWhere((row) => row.center_id === center.center_id
    && ['U_OWNER', 'U_ROGUE_OWNER'].includes(row.line_user_id));
  assert.strictEqual(priorOwnerRows.every((row) => row.status === 'revoked'), true);
});

test('owner transfer may retain exactly one previous-owner manager membership', async () => {
  const center = await centerService.createCenter({ name:'สาขา A', ownerLineId:'U_OWNER' });
  await db.CenterStaff.insert({
    staff_id:'STF-OWNER-DUP', center_id:center.center_id,
    line_user_id:'U_OWNER', role:'staff', status:'active', assigned_at:'2026-01-02T00:00:00.000Z',
  });
  await db.StaffContexts.insert({ context_id:'CTX-OWNER', center_id:center.center_id, line_user_id:'U_OWNER' });

  const result = await centerService.transferOwner({
    centerId:center.center_id, newOwnerLineId:VALID_NEW_OWNER, actor:'U_ADMIN', keepPreviousAsManager:true,
  });
  assert.strictEqual(result.ok, true);
  const activePreviousRows = await db.CenterStaff.findWhere((row) => row.center_id === center.center_id
    && row.line_user_id === 'U_OWNER' && (!row.status || row.status === 'active'));
  assert.strictEqual(activePreviousRows.length, 1);
  assert.strictEqual(activePreviousRows[0].role, 'manager');
  assert.strictEqual((await db.StaffContexts.findWhere((row) => row.center_id === center.center_id
    && row.line_user_id === 'U_OWNER')).length, 1);
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
  const token = new URL(invite.inviteUrl).searchParams.get('token');
  const claimed = await familyService.acceptInvite(token, 'U_FAMILY');
  assert.strictEqual(claimed.ok, true);
  assert.strictEqual(claimed.careProfile.owner_line_id, 'U_FAMILY');
  assert.strictEqual(claimed.careProfile.blood_type, 'O+');
  assert.deepStrictEqual(claimed.careProfile.chronic_conditions, ['เบาหวาน']);
});

test('ลิงก์เชิญที่สร้างซ้ำใช้ query token ตรงกับ Family LIFF', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์', ownerLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'คุณทดสอบ' });
  const result = await centerService.getOrCreateResidentInvite({ centerId: center.center_id, residentId: resident.resident_id });
  const url = new URL(result.inviteUrl);
  assert.ok(url.searchParams.get('token'));
  assert.strictEqual(url.searchParams.get('invite'), null);
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
  assert.strictEqual(history[0].changes[0].current.condition, 'เบาหวาน');
  assert.doesNotMatch(JSON.stringify(history), /recorded_by|source_image_base64|U_FAMILY/);
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
