const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const historyService = require('../backend/services/careProfileHealthHistoryService');

let server;
let baseUrl;

before(async () => {
  server = http.createServer(require('../backend/server'));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  db.resetAll();
  historyService.resetHealthHistoryForTests();
});

async function request(path, { user = 'U-FAMILY', method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      'X-Line-User-Id': user,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

async function seed({ profileId = 'CP-1', residentStatus = 'active', subscriptionRequired = false } = {}) {
  const center = await centerService.createCenter({
    name: 'ศูนย์ทดสอบ', ownerLineId: 'U-CENTER-OWNER', subscriptionRequired,
  });
  await db.CenterStaff.insert({
    staff_id: 'STAFF-MANAGER', center_id: center.center_id,
    line_user_id: 'U-MANAGER', role: 'manager', status: 'active',
  });
  await db.CenterStaff.insert({
    staff_id: 'STAFF-NORMAL', center_id: center.center_id,
    line_user_id: 'U-STAFF', role: 'staff', status: 'active',
  });
  const profile = await db.CareProfiles.insert({
    care_profile_id: profileId, owner_line_id: 'U-FAMILY', center_id: center.center_id,
    status: 'linked', patient_name: 'คุณยาย', weight_kg: 60,
    blood_type: 'O', emergency_contact_name: 'คุณลูกสาว',
    emergency_contact_phone: '0811111111', family_phone: '0822222222',
  });
  const resident = await db.Residents.insert({
    resident_id: 'R-1', center_id: center.center_id, care_profile_id: profileId,
    full_name: 'คุณยาย', status: residentStatus,
  });
  return { center, profile, resident };
}

async function familyPatch(body, user = 'U-FAMILY', profileId = 'CP-1') {
  return request(`/api/care-profile/${profileId}`, { user, method: 'PATCH', body });
}

test('Family PATCH keeps the existing response contract and history excludes actor LINE ID', async () => {
  await seed();
  const saved = await familyPatch({ weight_kg: 62, source: 'api', actor_type: 'system_admin' });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.care_profile_id, 'CP-1');
  assert.equal(saved.data.weight_kg, 62);

  const history = await request('/api/care-profile/CP-1/health-history');
  assert.equal(history.response.status, 200);
  assert.equal(history.data.items.length, 1);
  assert.equal(history.data.items[0].actorType, 'family_owner');
  assert.equal(history.data.items[0].source, 'family_liff');
  assert.equal(JSON.stringify(history.data).includes('U-FAMILY'), false);
  assert.equal('changed_by_line_user_id' in history.data.items[0], false);
});

test('Family history supports latest-first cursor pagination and allowed-field filtering', async () => {
  await seed();
  await familyPatch({ weight_kg: 61 });
  await familyPatch({ blood_type: 'A' });
  await familyPatch({ weight_kg: 62 });

  const first = await request('/api/care-profile/CP-1/health-history?limit=1');
  assert.equal(first.response.status, 200);
  assert.equal(first.data.items.length, 1);
  assert.ok(first.data.nextCursor);
  const second = await request(`/api/care-profile/CP-1/health-history?limit=1&cursor=${encodeURIComponent(first.data.nextCursor)}`);
  assert.equal(second.response.status, 200);
  assert.equal(second.data.items.length, 1);
  assert.notEqual(second.data.items[0].historyId, first.data.items[0].historyId);

  const filtered = await request('/api/care-profile/CP-1/health-history?field=blood_type');
  assert.equal(filtered.response.status, 200);
  assert.equal(filtered.data.items.length, 1);
  assert.deepEqual(filtered.data.items[0].changes.map((change) => change.field), ['blood_type']);
});

test('Family history requires owner or active caregiver with edit_profile', async () => {
  await seed();
  await familyPatch({ weight_kg: 61 });
  await db.CareProfileMembers.insert({
    member_id: 'M-EDIT', care_profile_id: 'CP-1', line_user_id: 'U-EDIT',
    status: 'active', permissions: ['view', 'edit_profile'],
  });
  await db.CareProfileMembers.insert({
    member_id: 'M-VIEW', care_profile_id: 'CP-1', line_user_id: 'U-VIEW',
    status: 'active', permissions: ['view'],
  });
  await db.CareProfileMembers.insert({
    member_id: 'M-REVOKED', care_profile_id: 'CP-1', line_user_id: 'U-REVOKED',
    status: 'revoked', permissions: ['view', 'edit_profile'],
  });

  assert.equal((await request('/api/care-profile/CP-1/health-history', { user: 'U-EDIT' })).response.status, 200);
  assert.equal((await request('/api/care-profile/CP-1/health-history', { user: 'U-VIEW' })).response.status, 403);
  assert.equal((await request('/api/care-profile/CP-1/health-history', { user: 'U-REVOKED' })).response.status, 403);
  assert.equal((await request('/api/care-profile/CP-1/health-history', { user: 'U-OTHER' })).response.status, 403);
});

test('Center owner and manager can read linked active resident history but normal staff cannot', async () => {
  const { center } = await seed();
  await familyPatch({ weight_kg: 63 });
  const path = `/api/residents/R-1/care-profile/health-history?centerId=${center.center_id}`;
  assert.equal((await request(path, { user: 'U-CENTER-OWNER' })).response.status, 200);
  assert.equal((await request(path, { user: 'U-MANAGER' })).response.status, 200);
  assert.equal((await request(path, { user: 'U-STAFF' })).response.status, 403);
});

test('Center history denies cross-center, discharged Resident and inactive subscription', async () => {
  const { center } = await seed();
  await familyPatch({ weight_kg: 63 });
  const otherCenter = await centerService.createCenter({ name: 'สาขาอื่น', ownerLineId: 'U-OTHER-CENTER' });
  assert.equal((await request(
    `/api/residents/R-1/care-profile/health-history?centerId=${otherCenter.center_id}`,
    { user: 'U-OTHER-CENTER' }
  )).response.status, 404);

  await db.Residents.update((item) => item.resident_id === 'R-1', { status: 'discharged' });
  assert.equal((await request(
    `/api/residents/R-1/care-profile/health-history?centerId=${center.center_id}`,
    { user: 'U-CENTER-OWNER' }
  )).response.status, 404);

  await db.Residents.update((item) => item.resident_id === 'R-1', { status: 'active' });
  await db.Centers.update((item) => item.center_id === center.center_id, { subscription_required: true });
  assert.equal((await request(
    `/api/residents/R-1/care-profile/health-history?centerId=${center.center_id}`,
    { user: 'U-CENTER-OWNER' }
  )).response.status, 402);
});

test('Center hides contact-only events and redacts contact fields from mixed events', async () => {
  const { center } = await seed();
  await familyPatch({ emergency_contact_phone: '0899999999' });
  await familyPatch({ weight_kg: 64, family_phone: '0888888888' });
  const path = `/api/residents/R-1/care-profile/health-history?centerId=${center.center_id}`;
  const result = await request(path, { user: 'U-MANAGER' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.items.length, 1);
  assert.deepEqual(result.data.items[0].changes, [{ field: 'weight_kg', before: 60, after: 64 }]);
  const serialized = JSON.stringify(result.data);
  assert.equal(serialized.includes('0899999999'), false);
  assert.equal(serialized.includes('0888888888'), false);
  assert.equal(serialized.includes('family_phone'), false);
});

test('Center rejects filtering by prohibited historical contact fields', async () => {
  const { center } = await seed();
  const result = await request(
    `/api/residents/R-1/care-profile/health-history?centerId=${center.center_id}&field=family_phone`,
    { user: 'U-CENTER-OWNER' }
  );
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error, 'FIELD_NOT_AVAILABLE');
});

