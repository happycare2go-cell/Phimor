const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../backend/db');
const familyService = require('../backend/services/familyService');

beforeEach(() => db.resetAll());

test('เจ้าของหลักสร้างลิงก์เชิญและญาติรับ Care Profile เป็นผู้ดูแลร่วมได้', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId:'U_OWNER', patientName:'คุณยายทองดี' });
  const created = await familyService.createCaregiverInvite({ careProfileId:profile.care_profile_id, requesterLineId:'U_OWNER' });
  assert.strictEqual(created.ok, true);
  assert.ok(created.url.includes('shareToken='));
  const accepted = await familyService.acceptCaregiverInvite(created.invite.token, 'U_RELATIVE');
  assert.strictEqual(accepted.ok, true);
  assert.strictEqual(await familyService.canAccessProfile(profile.care_profile_id, 'U_RELATIVE'), true);
});

test('ผู้ที่ไม่ใช่เจ้าของหลักสร้างลิงก์เชิญไม่ได้ และลิงก์ใช้ซ้ำไม่ได้', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId:'U_OWNER', patientName:'คุณยายทองดี' });
  assert.strictEqual((await familyService.createCaregiverInvite({ careProfileId:profile.care_profile_id, requesterLineId:'U_OTHER' })).ok, false);
  const created = await familyService.createCaregiverInvite({ careProfileId:profile.care_profile_id, requesterLineId:'U_OWNER' });
  assert.strictEqual((await familyService.acceptCaregiverInvite(created.invite.token, 'U_RELATIVE')).ok, true);
  assert.strictEqual((await familyService.acceptCaregiverInvite(created.invite.token, 'U_ANOTHER')).ok, false);
});

test('ญาติผู้ดูแลร่วมสามารถเลือกวิธีเดินทางแทนเจ้าของหลักได้', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId:'U_OWNER', patientName:'คุณยายทองดี' });
  const created = await familyService.createCaregiverInvite({ careProfileId:profile.care_profile_id, requesterLineId:'U_OWNER' });
  await familyService.acceptCaregiverInvite(created.invite.token, 'U_RELATIVE');
  const plan = await require('../backend/services/transportService').createTransportPlan({ appointmentId:'A1', careProfileId:profile.care_profile_id, centerId:null });
  const result = await require('../backend/services/transportService').familyChooseSelf(plan.plan_id, 'U_RELATIVE');
  assert.strictEqual(result.ok, true);
  const updated = await db.TransportPlans.findOne((p) => p.plan_id === plan.plan_id);
  assert.strictEqual(updated.family_decided_by, 'U_RELATIVE');
});
