const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const db = require('../backend/db');
const historyService = require('../backend/services/careProfileHealthHistoryService');
const { createCareProfileHealthHistoryService } = historyService;

test.beforeEach(() => {
  db.resetAll();
  historyService.resetHealthHistoryForTests();
});

async function seedProfile(overrides = {}) {
  return db.CareProfiles.insert({
    care_profile_id: 'CP-1', owner_line_id: 'U-OWNER', patient_name: 'คุณยาย',
    status: 'independent', weight_kg: 60, chronic_conditions: ['เบาหวาน'],
    drug_allergies: '', emergency_contact_phone: '0811111111',
    ...overrides,
  });
}

async function update(patch, overrides = {}) {
  return historyService.updateCareProfileHealth({
    careProfileId: 'CP-1', lineUserId: 'U-OWNER', patch, source: 'family_liff', ...overrides,
  });
}

async function familyHistory(overrides = {}) {
  return historyService.getCareProfileHealthHistory({
    careProfileId: 'CP-1', lineUserId: 'U-OWNER', audience: 'family', ...overrides,
  });
}

test('one changed field updates current state and creates one history event', async () => {
  await seedProfile();
  const result = await update({ weight_kg: 62 });
  assert.equal(result.changed, true);
  assert.equal(result.profile.weight_kg, 62);
  const history = await familyHistory();
  assert.equal(history.items.length, 1);
  assert.deepEqual(history.items[0].changes, [{ field: 'weight_kg', before: 60, after: 62 }]);
});

test('multiple changed fields in one Save create one event with changed keys only', async () => {
  await seedProfile({ blood_type: 'A' });
  await update({ blood_type: 'O', drug_allergies: ' Penicillin ', gender: '', actor_type: 'system_admin' });
  const history = await familyHistory();
  assert.equal(history.items.length, 1);
  assert.deepEqual(history.items[0].changes, [
    { field: 'blood_type', before: 'A', after: 'O' },
    { field: 'drug_allergies', before: '', after: 'Penicillin' },
  ]);
});

test('unchanged Save creates no event and does not update _updatedAt', async () => {
  const profile = await seedProfile();
  const result = await update({ weight_kg: '60', chronic_conditions: ['เบาหวาน'] });
  assert.equal(result.changed, false);
  assert.equal(result.profile._updatedAt, profile._updatedAt);
  assert.equal((await familyHistory()).items.length, 0);
});

test('numeric string and number are semantically equal', async () => {
  await seedProfile({ height_cm: 155 });
  const result = await update({ height_cm: '155.0' });
  assert.equal(result.changed, false);
});

test('chronic condition reorder is unchanged while add/remove creates a deterministic event', async () => {
  await seedProfile({ chronic_conditions: ['เบาหวาน', 'ความดันโลหิตสูง'] });
  assert.equal((await update({ chronic_conditions: ['ความดันโลหิตสูง', 'เบาหวาน', 'เบาหวาน'] })).changed, false);
  assert.equal((await update({ chronic_conditions: ['เบาหวาน', 'ไขมันในเลือดสูง'] })).changed, true);
  const changes = (await familyHistory()).items[0].changes[0];
  assert.equal(changes.field, 'chronic_conditions');
  assert.deepEqual(changes.before, ['เบาหวาน', 'ความดันโลหิตสูง'].sort((a, b) => a.localeCompare(b, 'th')));
  assert.deepEqual(changes.after, ['เบาหวาน', 'ไขมันในเลือดสูง'].sort((a, b) => a.localeCompare(b, 'th')));
});

test('unrelated owner and cross-profile requester cannot update or create history', async () => {
  await seedProfile();
  await assert.rejects(
    historyService.updateCareProfileHealth({ careProfileId:'CP-1', lineUserId:'U-OTHER', patch:{weight_kg:70}, source:'family_liff' }),
    (error) => error.code === 'ACCESS_DENIED'
  );
  assert.equal((await db.CareProfiles.findOne((item) => item.care_profile_id === 'CP-1')).weight_kg, 60);
  assert.equal((await familyHistory()).items.length, 0);
});

test('revoked caregiver and caregiver without edit_profile are denied', async () => {
  await seedProfile();
  await db.CareProfileMembers.insert({ member_id:'M-1', care_profile_id:'CP-1', line_user_id:'U-REVOKED', role:'caregiver', status:'revoked', permissions:['view','edit_profile'] });
  await db.CareProfileMembers.insert({ member_id:'M-2', care_profile_id:'CP-1', line_user_id:'U-VIEW', role:'caregiver', status:'active', permissions:['view'] });
  await assert.rejects(
    historyService.updateCareProfileHealth({ careProfileId:'CP-1', lineUserId:'U-REVOKED', patch:{weight_kg:61}, source:'family_liff' }),
    (error) => error.code === 'MEMBERSHIP_REVOKED'
  );
  await assert.rejects(
    historyService.updateCareProfileHealth({ careProfileId:'CP-1', lineUserId:'U-VIEW', patch:{weight_kg:61}, source:'family_liff' }),
    (error) => error.code === 'ACCESS_DENIED'
  );
});

test('active caregiver with edit_profile is recorded as family_caregiver', async () => {
  await seedProfile();
  await db.CareProfileMembers.insert({ member_id:'M-1', care_profile_id:'CP-1', line_user_id:'U-CARE', role:'caregiver', status:'active', permissions:['view','edit_profile'] });
  await historyService.updateCareProfileHealth({ careProfileId:'CP-1', lineUserId:'U-CARE', patch:{weight_kg:61}, source:'family_liff' });
  const result = await historyService.getCareProfileHealthHistory({ careProfileId:'CP-1', lineUserId:'U-CARE', audience:'family' });
  assert.equal(result.items[0].actorType, 'family_caregiver');
});

test('actor identity, source and diff metadata cannot be overridden by patch fields', async () => {
  await seedProfile();
  await update({
    weight_kg: 61, actor_type:'system_admin', source:'api', changed_at:'2000-01-01',
    changed_by_line_user_id:'U-ATTACKER', before_values:{weight_kg:1}, after_values:{weight_kg:999},
  });
  const event = (await familyHistory()).items[0];
  assert.equal(event.actorType, 'family_owner');
  assert.equal(event.source, 'family_liff');
  assert.deepEqual(event.changes, [{ field:'weight_kg', before:60, after:61 }]);
  assert.notEqual(event.changedAt, '2000-01-01T00:00:00.000Z');
});

test('center manager actor is derived from active center authorization context', async () => {
  await seedProfile({ center_id:'C-1', status:'linked' });
  await db.Centers.insert({ center_id:'C-1', name:'ศูนย์ทดสอบ', status:'active', subscription_required:false });
  await db.CenterStaff.insert({ staff_id:'S-1', center_id:'C-1', line_user_id:'U-MANAGER', role:'manager', status:'active' });
  await db.Residents.insert({ resident_id:'R-1', center_id:'C-1', care_profile_id:'CP-1', status:'active' });
  await historyService.updateCareProfileHealth({
    careProfileId:'CP-1', lineUserId:'U-MANAGER', centerId:'C-1',
    patch:{weight_kg:61, actor_type:'system_admin'}, source:'center_liff',
  });
  const event = (await familyHistory()).items[0];
  assert.equal(event.actorType, 'center_manager');
  assert.equal(event.source, 'center_liff');
});

test('source must match the trusted backend channel and cannot elevate an actor', async () => {
  await seedProfile();
  await assert.rejects(
    historyService.updateCareProfileHealth({
      careProfileId:'CP-1', lineUserId:'U-OWNER', patch:{weight_kg:61}, source:'center_liff',
    }),
    (error) => error.code === 'INVALID_SOURCE'
  );
  assert.equal((await db.CareProfiles.findOne((item) => item.care_profile_id === 'CP-1')).weight_kg, 60);
  assert.equal((await familyHistory()).items.length, 0);
});

function transactionalFixture({ failInsert = false, failUpdate = false } = {}) {
  let profile = { care_profile_id:'CP-1', owner_line_id:'U-OWNER', status:'independent', weight_kg:60, _updatedAt:'old' };
  let events = [];
  const service = createCareProfileHealthHistoryService({
    authorizeCareProfileAccess: async () => ({ principalType:'family_owner', role:'owner' }),
    withTransaction: async (_key, fn) => {
      const profileSnapshot = structuredClone(profile);
      const eventSnapshot = structuredClone(events);
      try { return await fn(); } catch (error) { profile = profileSnapshot; events = eventSnapshot; throw error; }
    },
    selectProfileForUpdate: async () => ({ id:'ROW-1', data:structuredClone(profile) }),
    mergeProfile: async (_id, patch) => {
      if (failUpdate) return null;
      profile = { ...profile, ...patch };
      return structuredClone(profile);
    },
    insertHistory: async (record) => {
      if (failInsert) throw new Error('sensitive value must not be logged');
      events.push(structuredClone(record));
    },
    now: () => '2026-08-25T00:00:00.000Z',
    historyId: () => 'CPHH-1',
  });
  return { service, profile: () => profile, events: () => events };
}

test('history insert failure rolls back Care Profile update and does not log raw values', async () => {
  const fixture = transactionalFixture({ failInsert:true });
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    await assert.rejects(fixture.service.updateCareProfileHealth({ careProfileId:'CP-1', lineUserId:'U-OWNER', patch:{drug_allergies:'SECRET-ALLERGY'}, source:'family_liff' }));
  } finally { console.error = original; }
  assert.equal(fixture.profile().weight_kg, 60);
  assert.equal('drug_allergies' in fixture.profile(), false);
  assert.equal(fixture.events().length, 0);
  assert.deepEqual(logs, []);
});

test('profile update failure creates no history event', async () => {
  const fixture = transactionalFixture({ failUpdate:true });
  await assert.rejects(
    fixture.service.updateCareProfileHealth({ careProfileId:'CP-1', lineUserId:'U-OWNER', patch:{weight_kg:61}, source:'family_liff' }),
    (error) => error.code === 'CARE_PROFILE_UPDATE_FAILED'
  );
  assert.equal(fixture.profile().weight_kg, 60);
  assert.equal(fixture.events().length, 0);
});

test('concurrent saves for one Care Profile are serialized into consistent events', async () => {
  await seedProfile();
  await Promise.all([update({ weight_kg:61 }), update({ weight_kg:62 })]);
  const current = await db.CareProfiles.findOne((item) => item.care_profile_id === 'CP-1');
  assert.equal(current.weight_kg, 62);
  const events = (await familyHistory({ limit:10 })).items;
  assert.equal(events.length, 2);
  const transitions = events.map((event) => `${event.changes[0].before}->${event.changes[0].after}`).sort();
  assert.deepEqual(transitions, ['60->61', '61->62']);
});

test('Plus summary code has no dependency on Health History', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['careProfileContextBuilder.js', 'careProfileSummaryService.js', 'plusOrchestrationService.js']) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'backend', 'services', file), 'utf8');
    assert.doesNotMatch(source, /careProfileHealthHistory|care_profile_health_history/);
  }
});
