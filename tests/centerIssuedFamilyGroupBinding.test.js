const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LIFF_ID_FAMILY = 'TEST_FAMILY_LIFF';

const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const familyService = require('../backend/services/familyService');
const groupBindingService = require('../backend/services/groupBindingService');
const { GROUP_BINDING_TRANSACTION_KEY } = require('../backend/services/groupBindingRepository');
const { familyCareNotificationService } = require('../backend/services/familyCareNotificationService');
const lineClient = require('../backend/providers/lineClient');

beforeEach(() => {
  db.resetAll();
  lineClient.clearSentLog();
});

async function setup({
  centerName = 'ศูนย์ตัวอย่าง', owner = 'U-CENTER', residentId = 'R-1',
  profileId = 'CP-1', patientName = 'คุณสมใจ', familyOwner = null,
} = {}) {
  const center = await centerService.createCenter({ name:centerName, ownerLineId:owner });
  const profile = await db.CareProfiles.insert({
    care_profile_id:profileId, owner_line_id:familyOwner, patient_name:patientName,
    center_id:center.center_id, status:'linked', managed_by_center:!familyOwner, created_at:new Date().toISOString(),
  });
  const resident = await db.Residents.insert({
    resident_id:residentId, center_id:center.center_id, full_name:patientName, aliases:[], room:null,
    family_phone:null, care_profile_id:profileId, status:'active', link_status:familyOwner ? 'linked' : 'center_managed',
  });
  return { center, profile, resident, owner };
}

async function issue(fixture, actor = fixture.owner) {
  return groupBindingService.createCenterFamilyBindingToken({
    centerId:fixture.center.center_id, residentId:fixture.resident.resident_id, requesterLineId:actor,
  });
}

test('Center Owner/Manager issue one cryptographic 15-minute CGROUP code while Staff and unrelated Center are denied', async () => {
  const ownerFixture = await setup();
  await db.CenterStaff.insert({ staff_id:'S-M', center_id:ownerFixture.center.center_id,
    line_user_id:'U-MANAGER', role:'manager', status:'active' });
  await db.CenterStaff.insert({ staff_id:'S-S', center_id:ownerFixture.center.center_id,
    line_user_id:'U-STAFF', role:'staff', status:'active' });
  await db.CenterStaff.insert({ staff_id:'S-P', center_id:ownerFixture.center.center_id,
    line_user_id:'U-PENDING', role:'manager', status:'pending' });
  await db.CenterStaff.insert({ staff_id:'S-R', center_id:ownerFixture.center.center_id,
    line_user_id:'U-REVOKED', role:'owner', status:'revoked' });
  const before = Date.now();
  const ownerCode = await issue(ownerFixture);
  assert.equal(ownerCode.ok, true);
  assert.match(ownerCode.code, /^CGROUP-[A-F0-9]{32}$/);
  assert.ok(new Date(ownerCode.expiresAt).getTime() - before >= 14 * 60 * 1000);
  assert.equal((await issue(ownerFixture, 'U-STAFF')).ok, false);
  assert.equal((await issue(ownerFixture, 'U-PENDING')).ok, false);
  assert.equal((await issue(ownerFixture, 'U-REVOKED')).ok, false);
  assert.equal((await issue(ownerFixture, 'U-OTHER')).ok, false);

  // A second eligible profile proves Manager authorization separately.
  const managerFixture = await setup({ residentId:'R-2', profileId:'CP-2', owner:'U-OTHER-CENTER' });
  await db.CenterStaff.insert({ staff_id:'S-M2', center_id:managerFixture.center.center_id,
    line_user_id:'U-MANAGER-2', role:'manager', status:'active' });
  assert.equal((await issue(managerFixture, 'U-MANAGER-2')).ok, true);
});

test('CGROUP plaintext is returned once but only its hash is persisted and audits contain no code', async () => {
  const fixture = await setup();
  const issued = await issue(fixture);
  const stored = (await db.GroupBindingTokens.findAll())[0];
  assert.equal(stored.code, undefined);
  assert.match(stored.code_hash, /^[a-f0-9]{64}$/);
  assert.equal(stored.code_hash, groupBindingService.hashCode(issued.code));
  assert.equal(stored.center_id, fixture.center.center_id);
  assert.equal(stored.care_profile_id, fixture.profile.care_profile_id);
  assert.equal(stored.resident_id, fixture.resident.resident_id);
  assert.equal(stored.source_flow, groupBindingService.CENTER_FAMILY_SOURCE);
  assert.equal(JSON.stringify(await db.AuditLog.findAll()).includes(issued.code), false);
});

test('eligibility rejects wrong-Center, discharged, conflicting relationship and already-bound profiles', async () => {
  const fixture = await setup();
  const other = await centerService.createCenter({ name:'ศูนย์อื่น', ownerLineId:'U-OTHER' });
  const wrong = await groupBindingService.createCenterFamilyBindingToken({
    centerId:other.center_id, residentId:fixture.resident.resident_id, requesterLineId:'U-OTHER',
  });
  assert.equal(wrong.ok, false);
  await db.Residents.update((item) => item.resident_id === fixture.resident.resident_id, { status:'discharged' });
  assert.equal((await issue(fixture)).ok, false);

  db.resetAll();
  const conflict = await setup();
  await db.Residents.insert({ resident_id:'R-CONFLICT', center_id:conflict.center.center_id,
    full_name:'สำเนา', care_profile_id:conflict.profile.care_profile_id, status:'active' });
  assert.equal((await issue(conflict)).code, 'CARE_PROFILE_RELATIONSHIP_CONFLICT');

  db.resetAll();
  const bound = await setup();
  await db.GroupBindings.insert({ binding_id:'GB-1', care_profile_id:bound.profile.care_profile_id,
    line_group_id:'G-BOUND', kind:'family', status:'active' });
  assert.equal((await issue(bound)).code, 'FAMILY_GROUP_ALREADY_BOUND');
});

test('two Center code creations and a Center/FAMILY issuance race converge to one live family-binding capability', async () => {
  const fixture = await setup({ familyOwner:'U-FAMILY' });
  const [one, two] = await Promise.all([issue(fixture), issue(fixture)]);
  assert.equal([one, two].filter((result) => result.ok).length, 1);
  assert.equal((await db.GroupBindingTokens.findWhere((item) => !item.used_at && !item.invalidated_at)).length, 1);

  db.resetAll();
  const mixed = await setup({ familyOwner:'U-FAMILY' });
  const results = await Promise.all([
    issue(mixed),
    groupBindingService.createFamilyBindingToken(mixed.profile.care_profile_id, 'U-FAMILY'),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal((await db.GroupBindingTokens.findWhere((item) => !item.used_at && !item.invalidated_at)).length, 1);
});

test('valid CGROUP consumption creates the canonical Family binding without granting ownership or Family permissions', async () => {
  const fixture = await setup();
  const token = await issue(fixture);
  const result = await groupBindingService.consumeCodeFromGroup({
    code:token.code, groupId:'G-FAMILY', senderLineId:'U-GROUP-MEMBER',
  });
  assert.equal(result.ok, true);
  const profile = await db.CareProfiles.findOneByField('care_profile_id', fixture.profile.care_profile_id);
  assert.equal(profile.owner_line_id, null);
  assert.equal(profile.managed_by_center, true);
  assert.equal((await db.CareProfileMembers.findAll()).length, 0);
  const binding = await db.GroupBindings.findOne((item) => item.care_profile_id === fixture.profile.care_profile_id);
  assert.equal(binding.kind, 'family');
  assert.equal(binding.line_group_id, 'G-FAMILY');
  assert.equal(binding.binding_source, groupBindingService.CENTER_FAMILY_SOURCE);
});

test('shared Family group accepts P1/P2 while a profile and cross-kind destinations remain exclusive', async () => {
  const first = await setup({ residentId:'R-1', profileId:'CP-1' });
  const second = await setup({ owner:'U-CENTER-2', residentId:'R-2', profileId:'CP-2' });
  for (const fixture of [first, second]) {
    const token = await issue(fixture);
    assert.equal((await groupBindingService.consumeCodeFromGroup({
      code:token.code, groupId:'G-SHARED', senderLineId:'U-ANY',
    })).ok, true);
  }
  assert.equal((await db.GroupBindings.findWhere((item) => item.line_group_id === 'G-SHARED')).length, 2);

  const third = await setup({ owner:'U-CENTER-3', residentId:'R-3', profileId:'CP-3' });
  await db.GroupBindings.insert({ binding_id:'GB-STAFF', kind:'center_staff', center_id:third.center.center_id,
    line_group_id:'G-STAFF', status:'active' });
  const token = await issue(third);
  assert.equal((await groupBindingService.consumeCodeFromGroup({
    code:token.code, groupId:'G-STAFF', senderLineId:'U-ANY',
  })).ok, false);
  assert.equal((await db.GroupBindingTokens.findOneByField('code_hash', groupBindingService.hashCode(token.code))).used_at, null);
});

test('same CGROUP code racing across two groups creates one binding and one pair of consumption audits', async () => {
  const fixture = await setup();
  const token = await issue(fixture);
  const results = await Promise.all([
    groupBindingService.consumeCodeFromGroup({ code:token.code, groupId:'G-1', senderLineId:'U-A' }),
    groupBindingService.consumeCodeFromGroup({ code:token.code, groupId:'G-2', senderLineId:'U-B' }),
  ]);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal((await db.GroupBindings.findWhere((item) => item.care_profile_id === fixture.profile.care_profile_id
    && item.status === 'active')).length, 1);
  assert.equal((await db.AuditLog.findWhere((item) => item.action === 'family_group.center_code_consumed')).length, 1);
  assert.equal((await db.AuditLog.findWhere((item) => item.action === 'family_group.bound_via_center_code')).length, 1);
});

test('expired, revoked and used CGROUP codes fail safely without a second logical binding', async () => {
  const fixture = await setup();
  const expired = await issue(fixture);
  await db.GroupBindingTokens.update((item) => item.code_hash === groupBindingService.hashCode(expired.code),
    { expires_at:new Date(Date.now() - 1000).toISOString() });
  assert.match((await groupBindingService.consumeCodeFromGroup({
    code:expired.code, groupId:'G-1', senderLineId:'U-A',
  })).reason, /หมดอายุ/);

  db.resetAll();
  const revokedFixture = await setup();
  const revoked = await issue(revokedFixture);
  await db.GroupBindingTokens.update((item) => item.code_hash === groupBindingService.hashCode(revoked.code),
    { revoked_at:new Date().toISOString(), status:'revoked' });
  assert.equal((await groupBindingService.consumeCodeFromGroup({
    code:revoked.code, groupId:'G-1', senderLineId:'U-A',
  })).ok, false);

  db.resetAll();
  const usedFixture = await setup();
  const used = await issue(usedFixture);
  assert.equal((await groupBindingService.consumeCodeFromGroup({ code:used.code, groupId:'G-1', senderLineId:'U-A' })).ok, true);
  assert.equal((await groupBindingService.consumeCodeFromGroup({ code:used.code, groupId:'G-2', senderLineId:'U-A' })).ok, false);
  assert.equal((await db.GroupBindings.findAll()).length, 1);
});

test('group-before-owner is valid; later ownership claim retains profile, clinical history and GroupBinding', async () => {
  const fixture = await setup();
  await db.Medications.insert({ medication_id:'MED-1', care_profile_id:fixture.profile.care_profile_id, name:'ยาตัวอย่าง' });
  const code = await issue(fixture);
  assert.equal((await groupBindingService.consumeCodeFromGroup({
    code:code.code, groupId:'G-FAMILY', senderLineId:'U-MEMBER',
  })).ok, true);
  const invite = await centerService.getOrCreateResidentInvite({
    centerId:fixture.center.center_id, residentId:fixture.resident.resident_id, requesterLineId:fixture.owner,
  });
  const claimToken = new URL(invite.inviteUrl).searchParams.get('token');
  const first = await familyService.acceptInvite(claimToken, 'U-FIRST-FAMILY');
  const retry = await familyService.acceptInvite(claimToken, 'U-FIRST-FAMILY');
  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(first.careProfile.care_profile_id, fixture.profile.care_profile_id);
  assert.equal((await db.CareProfiles.findOneByField('care_profile_id', fixture.profile.care_profile_id)).owner_line_id, 'U-FIRST-FAMILY');
  assert.equal((await db.CareProfiles.findOneByField('care_profile_id', fixture.profile.care_profile_id)).managed_by_center, false);
  assert.equal((await db.Medications.findOneByField('medication_id', 'MED-1')).care_profile_id, fixture.profile.care_profile_id);
  assert.equal((await db.GroupBindings.findOneByField('care_profile_id', fixture.profile.care_profile_id)).line_group_id, 'G-FAMILY');
});

test('first claimant wins across concurrent Family actors and CGROUP possession alone cannot claim ownership', async () => {
  const fixture = await setup();
  const code = await issue(fixture);
  await groupBindingService.consumeCodeFromGroup({ code:code.code, groupId:'G-FAMILY', senderLineId:'U-CODE-HOLDER' });
  assert.equal((await db.CareProfiles.findOneByField('care_profile_id', fixture.profile.care_profile_id)).owner_line_id, null);
  const invite = await centerService.getOrCreateResidentInvite({
    centerId:fixture.center.center_id, residentId:fixture.resident.resident_id, requesterLineId:fixture.owner,
  });
  const claimToken = new URL(invite.inviteUrl).searchParams.get('token');
  const results = await Promise.all([
    familyService.acceptInvite(claimToken, 'U-A'),
    familyService.acceptInvite(claimToken, 'U-B'),
  ]);
  assert.equal(results.filter((item) => item.ok).length, 1);
  const profile = await db.CareProfiles.findOneByField('care_profile_id', fixture.profile.care_profile_id);
  assert.ok(['U-A', 'U-B'].includes(profile.owner_line_id));
});

test('OA leave deactivates shared Family bindings but preserves ownership and requires a fresh code', async () => {
  const fixture = await setup({ familyOwner:'U-FAMILY' });
  const code = await issue(fixture);
  await groupBindingService.consumeCodeFromGroup({ code:code.code, groupId:'G-FAMILY', senderLineId:'U-MEMBER' });
  await groupBindingService.deactivateGroup('G-FAMILY');
  const history = await db.GroupBindings.findWhere((item) => item.care_profile_id === fixture.profile.care_profile_id);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'inactive');
  assert.equal((await db.CareProfiles.findOneByField('care_profile_id', fixture.profile.care_profile_id)).owner_line_id, 'U-FAMILY');
  assert.equal((await db.GroupBindings.findWhere((item) => item.status === 'active')).length, 0);
  assert.equal((await issue(fixture)).ok, true);
});

test('discharge revokes unused CGROUP capability while preserving historical binding and claimed owner', async () => {
  const pendingFixture = await setup();
  const pending = await issue(pendingFixture);
  assert.equal((await centerService.dischargeResident(pendingFixture.center.center_id,
    pendingFixture.resident.resident_id, pendingFixture.owner)).ok, true);
  assert.equal((await groupBindingService.consumeCodeFromGroup({
    code:pending.code, groupId:'G-LATE', senderLineId:'U-MEMBER',
  })).ok, false);

  db.resetAll();
  const boundFixture = await setup({ familyOwner:'U-FAMILY' });
  const code = await issue(boundFixture);
  await groupBindingService.consumeCodeFromGroup({ code:code.code, groupId:'G-FAMILY', senderLineId:'U-MEMBER' });
  await centerService.dischargeResident(boundFixture.center.center_id, boundFixture.resident.resident_id, boundFixture.owner);
  const binding = await db.GroupBindings.findOneByField('care_profile_id', boundFixture.profile.care_profile_id);
  const profile = await db.CareProfiles.findOneByField('care_profile_id', boundFixture.profile.care_profile_id);
  assert.equal(binding.status, 'active');
  assert.equal(profile.owner_line_id, 'U-FAMILY');
  assert.equal(profile.center_id, null);
  assert.equal(profile.status, 'independent');
});

test('CGROUP consumption and discharge serialize without a partial or duplicate binding', async () => {
  const dischargeFirst = await setup();
  const pending = await issue(dischargeFirst);
  const [discharged, rejectedConsume] = await Promise.all([
    centerService.dischargeResident(dischargeFirst.center.center_id, dischargeFirst.resident.resident_id, dischargeFirst.owner),
    groupBindingService.consumeCodeFromGroup({ code:pending.code, groupId:'G-LATE', senderLineId:'U-MEMBER' }),
  ]);
  assert.equal(discharged.ok, true);
  assert.equal(rejectedConsume.ok, false);
  assert.equal((await db.GroupBindings.findAll()).length, 0);

  db.resetAll();
  const consumeFirst = await setup();
  const ready = await issue(consumeFirst);
  const consumed = await groupBindingService.consumeCodeFromGroup({
    code:ready.code, groupId:'G-FAMILY', senderLineId:'U-MEMBER',
  });
  const ended = await centerService.dischargeResident(
    consumeFirst.center.center_id, consumeFirst.resident.resident_id, consumeFirst.owner,
  );
  assert.equal(consumed.ok, true);
  assert.equal(ended.ok, true);
  assert.equal((await db.GroupBindings.findWhere((item) => item.care_profile_id === consumeFirst.profile.care_profile_id)).length, 1);
  assert.equal((await db.Residents.findOneByField('resident_id', consumeFirst.resident.resident_id)).status, 'discharged');
});

test('Center relationship change wins safely against pending CGROUP consumption', async () => {
  const fixture = await setup();
  const pending = await issue(fixture);
  const relationshipChange = db.withTransaction(GROUP_BINDING_TRANSACTION_KEY, async () => {
    await db.Residents.update((item) => item.resident_id === fixture.resident.resident_id,
      { status:'transferred', transferred_at:new Date().toISOString() });
    await db.CareProfiles.update((item) => item.care_profile_id === fixture.profile.care_profile_id,
      { center_id:null, status:'independent' });
  });
  const [, consume] = await Promise.all([
    relationshipChange,
    groupBindingService.consumeCodeFromGroup({ code:pending.code, groupId:'G-LATE', senderLineId:'U-MEMBER' }),
  ]);
  assert.equal(consume.ok, false);
  assert.equal((await db.GroupBindings.findAll()).length, 0);
  assert.equal((await db.GroupBindingTokens.findOneByField('code_hash', groupBindingService.hashCode(pending.code))).used_at, null);
});

test('verified Family group receives profile-scoped notifications even while owner is null', async () => {
  const fixture = await setup();
  const code = await issue(fixture);
  await groupBindingService.consumeCodeFromGroup({ code:code.code, groupId:'G-FAMILY', senderLineId:'U-MEMBER' });
  const queued = await familyCareNotificationService.enqueueFinalized({
    kind:'daily_care', careProfileId:fixture.profile.care_profile_id, resourceId:'DCR-1',
    projection:{ careRecipientName:fixture.profile.patient_name, careDate:'2026-08-30', dailyCare:[] },
  });
  assert.equal(queued.ok, true);
  const intent = (await db.NotificationOutbox.findAll())[0];
  assert.equal(intent.to, 'G-FAMILY');
  assert.equal(intent.meta.careProfileId, fixture.profile.care_profile_id);
  assert.match(intent.messages[0].text, /คุณสมใจ/);
  assert.doesNotMatch(intent.dedupe_key, /G-FAMILY/);
});

test('Center resident projection exposes only safe group/ownership states, never group or owner LINE IDs', async () => {
  const fixture = await setup({ familyOwner:'U-FAMILY-SECRET' });
  const code = await issue(fixture);
  await groupBindingService.consumeCodeFromGroup({ code:code.code, groupId:'G-RAW-SECRET', senderLineId:'U-MEMBER' });
  const projection = await centerService.listResidents(fixture.center.center_id);
  assert.equal(projection[0].family_group_connected, true);
  assert.equal(projection[0].ownership_claimed, true);
  assert.doesNotMatch(JSON.stringify(projection), /G-RAW-SECRET|U-FAMILY-SECRET|code_hash|CGROUP-/);
});
