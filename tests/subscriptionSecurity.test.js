const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const familyService = require('../backend/services/familyService');
const accessService = require('../backend/services/accessService');
const subscriptionService = require('../backend/services/subscriptionService');
const transportService = require('../backend/services/transportService');
const lineClient = require('../backend/providers/lineClient');

beforeEach(() => { db.resetAll(); lineClient.clearSentLog(); });
afterEach(() => {
  delete process.env.REQUIRE_STAFF_APPROVAL;
  delete process.env.REQUIRE_CARE2GO_OPS_BINDING;
});

test('ศูนย์ใหม่ที่บังคับแพ็กเกจ ใช้งานไม่ได้จนกว่า Admin กำหนดช่วงสิทธิ', async () => {
  const center = await centerService.createCenter({ name:'สาขาทดสอบ', ownerLineId:'U_OWNER', subscriptionRequired:true });
  assert.equal(subscriptionService.entitlement(center).allowed, false);
  const configured = await subscriptionService.setSubscription({
    centerId:center.center_id, startsAt:'2026-08-01T00:00:00+07:00', expiresAt:'2026-09-01T23:59:59+07:00', packageType:'monthly', actor:'admin',
  });
  assert.equal(configured.ok, true);
  assert.equal(subscriptionService.entitlement(configured.center, new Date('2026-08-21T00:00:00+07:00')).allowed, true);
  assert.ok(lineClient.getSentLog().some((m) => m.to === 'U_OWNER' && m.messages[0].text.includes('1 ก.ย. 2569')));
});

test('เตือนหมดอายุภายใน 3 วันเพียงครั้งเดียวผ่าน notification outbox', async () => {
  const center = await centerService.createCenter({ name:'สาขาใกล้หมดอายุ', ownerLineId:'U_OWNER', subscriptionRequired:true });
  await subscriptionService.setSubscription({ centerId:center.center_id, startsAt:'2026-08-01T00:00:00+07:00', expiresAt:'2026-08-24T23:59:59+07:00', actor:'admin' });
  lineClient.clearSentLog();
  await subscriptionService.sendExpiryReminders(new Date('2026-08-21T09:00:00+07:00'));
  await subscriptionService.sendExpiryReminders(new Date('2026-08-21T10:00:00+07:00'));
  const reminders = lineClient.getSentLog().filter((m) => m.to === 'U_OWNER' && m.messages[0].text.includes('หมดอายุภายใน 3 วัน'));
  assert.equal(reminders.length, 1);
});

test('ป้องกันแก้ไขและจำหน่าย Resident ข้ามศูนย์ที่ service layer', async () => {
  const a = await centerService.createCenter({ name:'A', ownerLineId:'U_A' });
  const b = await centerService.createCenter({ name:'B', ownerLineId:'U_B' });
  const { resident } = await centerService.addResident({ centerId:b.center_id, fullName:'ผู้พัก B' });
  assert.equal(await centerService.updateResident(a.center_id, resident.resident_id, { room:'แอบแก้' }), null);
  assert.equal((await centerService.dischargeResident(a.center_id, resident.resident_id, 'U_A')).ok, false);
  assert.equal((await db.Residents.findOne((r) => r.resident_id === resident.resident_id)).status, 'active');
});

test('production policy ให้สมาชิกใหม่รอเจ้าของอนุมัติก่อนเป็นพนักงาน', async () => {
  process.env.REQUIRE_STAFF_APPROVAL = 'true';
  const center = await centerService.createCenter({ name:'ศูนย์', ownerLineId:'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId:center.center_id, groupId:'G_STAFF', requesterLineId:'U_OWNER' });
  const pending = await centerService.recordStaffFromGroup('G_STAFF', 'U_NEW');
  assert.equal(pending.status, 'pending');
  assert.equal((await centerService.listCentersByStaffUser('U_NEW')).length, 0);
  const approved = await centerService.approveStaff({ centerId:center.center_id, targetLineId:'U_NEW', requesterLineId:'U_OWNER', role:'staff' });
  assert.equal(approved.ok, true);
  assert.equal((await centerService.listCentersByStaffUser('U_NEW')).length, 1);
});

test('legacy known-profile AccessRequest remains compatible and revokes the Resident invite after approval', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId:'U_FAMILY', patientName:'คุณยาย', familyPhone:'081-234-5678' });
  const center = await centerService.createCenter({ name:'ศูนย์ใหม่', ownerLineId:'U_OWNER' });
  const added = await centerService.addResident({ centerId:center.center_id, fullName:'คุณยาย', familyPhone:'0812345678' });
  assert.equal(added.accessRequestSent, false, 'new onboarding no longer auto-matches by phone');
  const legacy = await accessService.createAccessRequest({
    centerId:center.center_id, careProfileId:profile.care_profile_id,
    residentId:added.resident.resident_id, requestedBy:'U_OWNER',
  });
  assert.equal(legacy.ok, true);
  assert.equal((await accessService.respondAccessRequest(legacy.request.request_id, true, 'U_FAMILY')).ok, true);
  const token = new URL(added.inviteUrl).searchParams.get('token');
  assert.equal((await familyService.acceptInvite(token, 'U_FAMILY')).ok, false);
  assert.equal((await db.CareProfiles.findWhere((p) => p.patient_name === 'คุณยาย')).length, 1);
  assert.equal((await db.Residents.findOne((r) => r.resident_id === added.resident.resident_id)).care_profile_id, profile.care_profile_id);
});

test('ห้ามเปลี่ยนสถานะเป็น Care2Go requested ถ้ายังไม่ผูกกลุ่มปฏิบัติการ', async () => {
  process.env.REQUIRE_CARE2GO_OPS_BINDING = 'true';
  const center = await centerService.createCenter({ name:'ศูนย์', ownerLineId:'U_OWNER' });
  const profile = await db.CareProfiles.insert({ care_profile_id:'CP', owner_line_id:'U_FAMILY', patient_name:'ผู้พัก', center_id:center.center_id, status:'linked' });
  const plan = await transportService.createTransportPlan({ appointmentId:'APT', careProfileId:profile.care_profile_id, centerId:center.center_id });
  await transportService.familyRequestCenter(plan.plan_id, 'U_FAMILY');
  const result = await transportService.centerChoose(plan.plan_id, 'care2go', 'U_OWNER', { needs:['vehicle'] });
  assert.equal(result.ok, false);
  assert.equal((await db.TransportPlans.findOne((p) => p.plan_id === plan.plan_id)).status, 'awaiting_center');
});
