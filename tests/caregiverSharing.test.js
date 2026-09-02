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

test('caregiver invite race is consumed by exactly one actor', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId:'U_OWNER', patientName:'บุคคลตัวอย่าง' });
  const created = await familyService.createCaregiverInvite({ careProfileId:profile.care_profile_id, requesterLineId:'U_OWNER' });
  const results = await Promise.all([
    familyService.acceptCaregiverInvite(created.invite.token, 'U_RELATIVE_A'),
    familyService.acceptCaregiverInvite(created.invite.token, 'U_RELATIVE_B'),
  ]);
  assert.strictEqual(results.filter((result) => result.ok).length, 1);
  assert.strictEqual((await db.CareProfileMembers.findWhere((member) => member.care_profile_id === profile.care_profile_id && member.status === 'active')).length, 1);
  const invite = await db.CareProfileShareInvites.findOne((item) => item.invite_id === created.invite.invite_id);
  assert.strictEqual(invite.status, 'used');
  assert.ok(['U_RELATIVE_A', 'U_RELATIVE_B'].includes(invite.used_by));
});

test('same accepted actor retry is idempotent and two tokens cannot duplicate one membership', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId:'U_OWNER', patientName:'บุคคลตัวอย่าง' });
  const first = await familyService.createCaregiverInvite({ careProfileId:profile.care_profile_id, requesterLineId:'U_OWNER' });
  const accepted = await familyService.acceptCaregiverInvite(first.invite.token, 'U_RELATIVE');
  const duplicate = await familyService.acceptCaregiverInvite(first.invite.token, 'U_RELATIVE');
  assert.strictEqual(accepted.ok, true);
  assert.strictEqual(duplicate.ok, true);
  assert.strictEqual(duplicate.duplicate, true);

  const second = await familyService.createCaregiverInvite({ careProfileId:profile.care_profile_id, requesterLineId:'U_OWNER' });
  const secondAccepted = await familyService.acceptCaregiverInvite(second.invite.token, 'U_RELATIVE');
  assert.strictEqual(secondAccepted.ok, true);
  const members = await db.CareProfileMembers.findWhere((member) => member.care_profile_id === profile.care_profile_id
    && member.line_user_id === 'U_RELATIVE' && member.status === 'active');
  assert.strictEqual(members.length, 1);
  assert.strictEqual(members[0].member_id, accepted.member.member_id);
});

test('expired and already-used caregiver invites remain rejected for another actor', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId:'U_OWNER', patientName:'บุคคลตัวอย่าง' });
  const expired = await familyService.createCaregiverInvite({ careProfileId:profile.care_profile_id, requesterLineId:'U_OWNER' });
  await db.CareProfileShareInvites.update((item) => item.invite_id === expired.invite.invite_id, {
    expires_at:new Date(Date.now() - 1000).toISOString(),
  });
  assert.strictEqual((await familyService.acceptCaregiverInvite(expired.invite.token, 'U_RELATIVE')).ok, false);
  const used = await familyService.createCaregiverInvite({ careProfileId:profile.care_profile_id, requesterLineId:'U_OWNER' });
  assert.strictEqual((await familyService.acceptCaregiverInvite(used.invite.token, 'U_RELATIVE')).ok, true);
  assert.strictEqual((await familyService.acceptCaregiverInvite(used.invite.token, 'U_OTHER')).ok, false);
});
