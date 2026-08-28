const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const db = require('../backend/db');
const familyService = require('../backend/services/familyService');
const centerService = require('../backend/services/centerService');
const groupBindingService = require('../backend/services/groupBindingService');
const transportService = require('../backend/services/transportService');
const reminderService = require('../backend/services/reminderService');
const lineClient = require('../backend/providers/lineClient');
const medicationOperation = require('../liff-app/family/medication-operation');

beforeEach(() => {
  db.resetAll();
  lineClient.clearSentLog();
});

async function profile(id, owner, name) {
  return db.CareProfiles.insert({
    care_profile_id:id, owner_line_id:owner, patient_name:name,
    center_id:null, status:'independent', created_at:`2026-08-0${id.slice(-1)}T00:00:00Z`,
  });
}

async function bindWithFreshCode(careProfileId, owner, groupId) {
  const token = await groupBindingService.createFamilyBindingToken(careProfileId, owner);
  assert.equal(token.ok, true);
  return groupBindingService.consumeCodeFromGroup({ code:token.code, groupId, senderLineId:owner });
}

test('one Family group can bind multiple Care Profiles while each profile keeps one active primary group', async () => {
  await profile('CP-1', 'U-1', 'คุณพ่อ');
  await profile('CP-2', 'U-1', 'คุณแม่');
  await profile('CP-3', 'U-3', 'คุณตา');

  for (const [profileId, owner] of [['CP-1','U-1'], ['CP-2','U-1'], ['CP-3','U-3']]) {
    const result = await bindWithFreshCode(profileId, owner, 'G-FAMILY');
    assert.equal(result.ok, true);
  }
  const active = await db.GroupBindings.findWhere((binding) => binding.status === 'active');
  assert.equal(active.length, 3);
  assert.deepEqual(new Set(active.map((binding) => binding.line_group_id)), new Set(['G-FAMILY']));
  assert.ok(active.every((binding) => binding.kind === 'family'));

  const secondGroup = await familyService.bindFamilyGroup({ careProfileId:'CP-1', groupId:'G-OTHER', requesterLineId:'U-1' });
  assert.equal(secondGroup.ok, false);
  assert.equal(secondGroup.code, 'FAMILY_GROUP_ALREADY_BOUND');
});

test('medication operation guard rejects P1 results and confirmations after switching to P2', () => {
  const operation = medicationOperation.create({ careProfileId:'CP-1', generation:7, profileConditions:['เบาหวาน'] });
  assert.equal(medicationOperation.matches(operation, {
    activeOperation:operation, careProfileId:'CP-1', generation:7,
  }), true);
  assert.equal(medicationOperation.matches(operation, {
    activeOperation:operation, careProfileId:'CP-2', generation:8,
  }), false);
  assert.equal(medicationOperation.matches(operation, {
    activeOperation:null, careProfileId:'CP-1', generation:7,
  }), false);
  assert.deepEqual(operation.profileConditions, ['เบาหวาน']);
});

test('Family token issuance is owner-only, 15 minutes, deterministic, and blocked after binding', async () => {
  await profile('CP-1', 'U-1', 'คุณพ่อ');
  const denied = await groupBindingService.createFamilyBindingToken('CP-1', 'U-OTHER');
  assert.equal(denied.ok, false);

  const before = Date.now();
  const first = await groupBindingService.createFamilyBindingToken('CP-1', 'U-1');
  const second = await groupBindingService.createFamilyBindingToken('CP-1', 'U-1');
  assert.equal(first.code, second.code);
  assert.equal(second.reused, true);
  const ttl = new Date(first.expiresAt).getTime() - before;
  assert.ok(ttl >= 14 * 60 * 1000 && ttl <= 16 * 60 * 1000);

  assert.equal((await groupBindingService.consumeCodeFromGroup({ code:first.code, groupId:'G-1', senderLineId:'U-1' })).ok, true);
  const alreadyBound = await groupBindingService.createFamilyBindingToken('CP-1', 'U-1');
  assert.equal(alreadyBound.ok, false);
  assert.equal(alreadyBound.code, 'FAMILY_GROUP_ALREADY_BOUND');
});

test('concurrent same-token consumption creates one logical active binding', async () => {
  await profile('CP-1', 'U-1', 'คุณพ่อ');
  const token = await groupBindingService.createFamilyBindingToken('CP-1', 'U-1');
  const results = await Promise.all([
    groupBindingService.consumeCodeFromGroup({ code:token.code, groupId:'G-1', senderLineId:'U-1' }),
    groupBindingService.consumeCodeFromGroup({ code:token.code, groupId:'G-1', senderLineId:'U-1' }),
  ]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(results.filter((result) => result.duplicate).length, 1);
  const active = await db.GroupBindings.findWhere((binding) => binding.status === 'active'
    && binding.kind === 'family' && binding.care_profile_id === 'CP-1');
  assert.equal(active.length, 1);
});

test('Family, Center staff, and Care2Go group destinations cannot cross kinds', async () => {
  await profile('CP-1', 'U-FAMILY', 'คุณแม่');
  assert.equal((await bindWithFreshCode('CP-1', 'U-FAMILY', 'G-FAMILY')).ok, true);
  const center = await centerService.createCenter({ name:'ศูนย์', ownerLineId:'U-CENTER' });
  assert.equal((await centerService.bindGroupToCenter({ centerId:center.center_id, groupId:'G-FAMILY', requesterLineId:'U-CENTER' })).ok, false);
  assert.equal((await transportService.bindCare2goOperationsGroup('G-FAMILY', 'U-OPS')).ok, false);

  assert.equal((await centerService.bindGroupToCenter({ centerId:center.center_id, groupId:'G-CENTER', requesterLineId:'U-CENTER' })).ok, true);
  await profile('CP-2', 'U-FAMILY', 'คุณพ่อ');
  const familyOnCenter = await bindWithFreshCode('CP-2', 'U-FAMILY', 'G-CENTER');
  assert.equal(familyOnCenter.ok, false);
  assert.equal((await centerService.findCenterByGroup('G-CENTER')).center_id, center.center_id);
  assert.equal(await centerService.findCenterByGroup('G-FAMILY'), null);
});

test('concurrent Family and Center tokens cannot assign different kinds to the same group', async () => {
  await profile('CP-1', 'U-FAMILY', 'คุณแม่');
  const center = await centerService.createCenter({ name:'ศูนย์', ownerLineId:'U-CENTER' });
  const familyToken = await groupBindingService.createFamilyBindingToken('CP-1', 'U-FAMILY');
  const centerToken = await groupBindingService.createStaffBindingToken(center.center_id, 'U-CENTER');
  const results = await Promise.all([
    groupBindingService.consumeCodeFromGroup({ code:familyToken.code, groupId:'G-RACE', senderLineId:'U-FAMILY' }),
    groupBindingService.consumeCodeFromGroup({ code:centerToken.code, groupId:'G-RACE', senderLineId:'U-CENTER' }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  const active = await db.GroupBindings.findWhere((binding) => binding.status === 'active'
    && binding.line_group_id === 'G-RACE');
  assert.equal(active.length, 1);
});

test('OA leave deactivates every shared Family binding, retains history, and rejoin requires fresh codes', async () => {
  for (const [id, owner, name] of [['CP-1','U-1','คุณพ่อ'],['CP-2','U-2','คุณแม่'],['CP-3','U-3','คุณตา']]) {
    await profile(id, owner, name);
    assert.equal((await bindWithFreshCode(id, owner, 'G-SHARED')).ok, true);
  }
  const left = await groupBindingService.deactivateGroup('G-SHARED');
  assert.equal(left.bindings.length, 3);
  const history = await db.GroupBindings.findWhere((binding) => binding.line_group_id === 'G-SHARED');
  assert.equal(history.length, 3);
  assert.ok(history.every((binding) => binding.status === 'inactive' && binding.unbound_at));

  // A LINE join only sends guidance; it does not call a reactivation path.
  assert.equal((await db.GroupBindings.findWhere((binding) => binding.status === 'active')).length, 0);
  assert.equal((await bindWithFreshCode('CP-1', 'U-1', 'G-SHARED')).ok, true);
  assert.equal((await bindWithFreshCode('CP-2', 'U-2', 'G-SHARED')).ok, true);
  await profile('CP-4', 'U-4', 'คุณยาย');
  assert.equal((await bindWithFreshCode('CP-4', 'U-4', 'G-SEPARATE')).ok, true);
  const active = await db.GroupBindings.findWhere((binding) => binding.status === 'active');
  assert.deepEqual(new Set(active.map((binding) => binding.care_profile_id)), new Set(['CP-1','CP-2','CP-4']));
  assert.equal(active.find((binding) => binding.care_profile_id === 'CP-4').line_group_id, 'G-SEPARATE');
});

test('member-left deactivates only profiles owned by that member in a shared group', async () => {
  await profile('CP-1', 'U-OWNER-A', 'คุณพ่อ');
  await profile('CP-2', 'U-OWNER-B', 'คุณแม่');
  await bindWithFreshCode('CP-1', 'U-OWNER-A', 'G-SHARED');
  await bindWithFreshCode('CP-2', 'U-OWNER-B', 'G-SHARED');

  const result = await groupBindingService.handleMemberLeft('G-SHARED', 'U-OWNER-A');
  assert.deepEqual(result.affectedCareProfileIds, ['CP-1']);
  const rows = await db.GroupBindings.findWhere((binding) => binding.line_group_id === 'G-SHARED');
  assert.equal(rows.find((binding) => binding.care_profile_id === 'CP-1').status, 'inactive');
  assert.equal(rows.find((binding) => binding.care_profile_id === 'CP-2').status, 'active');
});

test('shared destination keeps profile-scoped reminder intents distinct and identifies each Care Profile', async () => {
  await profile('CP-1', 'U-1', 'คุณพ่อ');
  await profile('CP-2', 'U-2', 'คุณแม่');
  await bindWithFreshCode('CP-1', 'U-1', 'G-SHARED');
  await bindWithFreshCode('CP-2', 'U-2', 'G-SHARED');
  const today = new Date('2026-08-28T08:00:00+07:00');
  for (const [id, profileId] of [['APT-1','CP-1'],['APT-2','CP-2']]) {
    await db.Appointments.insert({ appointment_id:id, care_profile_id:profileId,
      hospital:'โรงพยาบาลตัวอย่าง', datetime:'2026-08-28T14:00:00+07:00', status:'confirmed' });
  }
  assert.equal((await reminderService.sendAppointmentReminders(today)).sent, 2);
  const notices = await db.NotificationOutbox.findWhere((item) => item.kind === 'appointment_reminder');
  assert.equal(notices.length, 2);
  assert.notEqual(notices[0].dedupe_key, notices[1].dedupe_key);
  const text = notices.map((item) => item.messages[0].text).join('\n');
  assert.match(text, /คุณพ่อ/);
  assert.match(text, /คุณแม่/);
});

test('transport reminder to a shared Family group identifies the Care Profile and stays plan-scoped', async () => {
  await profile('CP-1', 'U-1', 'คุณพ่อ');
  await profile('CP-2', 'U-2', 'คุณแม่');
  await bindWithFreshCode('CP-1', 'U-1', 'G-SHARED');
  await bindWithFreshCode('CP-2', 'U-2', 'G-SHARED');
  for (const [appointmentId, planId, profileId] of [['APT-1','TP-1','CP-1'],['APT-2','TP-2','CP-2']]) {
    await db.Appointments.insert({ appointment_id:appointmentId, care_profile_id:profileId,
      hospital:'โรงพยาบาลตัวอย่าง', datetime:'2026-08-28T18:00:00+07:00', status:'confirmed' });
    await db.TransportPlans.insert({ plan_id:planId, appointment_id:appointmentId,
      care_profile_id:profileId, center_id:null, status:'awaiting_family', reminder_stages_sent:[], history:[] });
  }
  assert.equal((await transportService.remindPendingFamilyChoices(new Date('2026-08-28T08:00:00+07:00'))).reminded, 2);
  const notices = await db.NotificationOutbox.findWhere((item) => item.kind === 'transport_family_reminder');
  assert.equal(notices.length, 2);
  assert.notEqual(notices[0].dedupe_key, notices[1].dedupe_key);
  const text = notices.map((item) => item.messages[0].text).join('\n');
  assert.match(text, /คุณพ่อ/);
  assert.match(text, /คุณแม่/);
});

test('inactive shared group is no longer a Family notification destination', async () => {
  await profile('CP-1', 'U-1', 'คุณพ่อ');
  await bindWithFreshCode('CP-1', 'U-1', 'G-SHARED');
  await groupBindingService.deactivateGroup('G-SHARED');
  await db.Appointments.insert({ appointment_id:'APT-1', care_profile_id:'CP-1',
    hospital:'โรงพยาบาลตัวอย่าง', datetime:'2026-08-28T14:00:00+07:00', status:'confirmed' });
  const targets = await reminderService.sendAppointmentReminders(new Date('2026-08-28T08:00:00+07:00'));
  assert.equal(targets.sent, 1);
  assert.equal(lineClient.getSentLog().some((entry) => entry.to === 'G-SHARED'), false);
  assert.equal(lineClient.getSentLog().some((entry) => entry.to === 'U-1'), true);
});
