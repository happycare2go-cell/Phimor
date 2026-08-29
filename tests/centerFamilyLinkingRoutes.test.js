const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';
process.env.LIFF_ID_FAMILY = 'TEST_FAMILY_LIFF';
process.env.PDF_DOWNLOAD_SECRET = process.env.PDF_DOWNLOAD_SECRET || 'test-pdf-download-secret';

const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const familyService = require('../backend/services/familyService');

let server;
let baseUrl;

before(async () => {
  server = http.createServer(require('../backend/server'));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => new Promise((resolve) => server.close(resolve)));
beforeEach(() => db.resetAll());

async function api(path, { user = 'U-FAMILY', method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers:{ 'X-Line-User-Id':user, ...(body === undefined ? {} : { 'Content-Type':'application/json' }) },
    body:body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body:await response.json() };
}

async function setupCenter() {
  const center = await centerService.createCenter({ name:'ศูนย์ตัวอย่าง', ownerLineId:'U-OWNER', address:'กรุงเทพฯ', contactPhone:'02-000-0000' });
  await db.CenterStaff.insert({ staff_id:'STF-M', center_id:center.center_id, line_user_id:'U-MANAGER', role:'manager', status:'active' });
  await db.CenterStaff.insert({ staff_id:'STF-S', center_id:center.center_id, line_user_id:'U-STAFF', role:'staff', status:'active' });
  return center;
}

test('only active Center Owner/Manager may create Flow A links; Staff and another Center actor are denied', async () => {
  const center = await setupCenter();
  for (const user of ['U-OWNER','U-MANAGER']) {
    const created = await api('/api/center/care-profile-link-requests', { user, method:'POST', body:{ centerId:center.center_id } });
    assert.equal(created.response.status, 201);
    assert.match(created.body.linkUrl, /^https:\/\/liff\.line\.me\/TEST_FAMILY_LIFF\?centerLink=/);
    assert.ok(created.body.expiresAt);
    assert.deepEqual(Object.keys(created.body).sort(), ['expiresAt','linkUrl']);
  }
  const staff = await api('/api/center/care-profile-link-requests', { user:'U-STAFF', method:'POST', body:{ centerId:center.center_id } });
  assert.equal(staff.response.status, 403);
  const outsider = await api('/api/center/care-profile-link-requests', { user:'U-OTHER', method:'POST', body:{ centerId:center.center_id } });
  assert.equal(outsider.response.status, 403);
  const inactive = await db.Centers.update((row) => row.center_id === center.center_id, { status:'suspended' });
  assert.ok(inactive);
  const suspended = await api('/api/center/care-profile-link-requests', { user:'U-OWNER', method:'POST', body:{ centerId:center.center_id } });
  assert.equal(suspended.response.status, 402);
});

test('authenticated Flow A HTTP journey exposes a safe Center projection and keeps the Access inbox owner-wide', async () => {
  const center = await setupCenter();
  await familyService.createIndependentProfile({ ownerLineId:'U-FAMILY', patientName:'ป้าศรี' });
  await familyService.createIndependentProfile({ ownerLineId:'U-FAMILY', patientName:'คุณพ่อ' });
  const created = await api('/api/center/care-profile-link-requests', { user:'U-OWNER', method:'POST', body:{ centerId:center.center_id } });
  const token = new URL(created.body.linkUrl).searchParams.get('centerLink');
  const opened = await api(`/api/access-links/${encodeURIComponent(token)}/open`, { user:'U-FAMILY', method:'POST', body:{} });
  assert.equal(opened.response.status, 200);
  assert.equal(opened.body.centerName, 'ศูนย์ตัวอย่าง');
  assert.equal(opened.body.centerAddress, 'กรุงเทพฯ');
  assert.equal(opened.body.centerPhone, '02-000-0000');
  assert.equal(opened.body.eligibleProfiles.length, 2);
  assert.doesNotMatch(JSON.stringify(opened.body), new RegExp(center.center_id));
  assert.doesNotMatch(JSON.stringify(opened.body), /U-FAMILY|U-OWNER|owner_line_id|presented_to/);
  const inbox = await api('/api/access-requests', { user:'U-FAMILY' });
  assert.equal(inbox.response.status, 200);
  assert.equal(inbox.body.requests.length, 1);
  const secondActor = await api(`/api/access-links/${encodeURIComponent(token)}/open`, { user:'U-SECOND', method:'POST', body:{} });
  assert.equal(secondActor.response.status, 403);
  assert.doesNotMatch(secondActor.body.message, /U-FAMILY|ป้าศรี|คุณพ่อ/);
});

test('member-only and unrelated actors cannot approve or select an owner profile by request body', async () => {
  const center = await setupCenter();
  const ownerProfile = await familyService.createIndependentProfile({ ownerLineId:'U-OWNER-FAMILY', patientName:'คุณแม่' });
  const caregiverProfile = await familyService.createIndependentProfile({ ownerLineId:'U-SOMEONE', patientName:'คุณตา' });
  await db.CareProfileMembers.insert({ member_id:'M-1', care_profile_id:caregiverProfile.care_profile_id, line_user_id:'U-OWNER-FAMILY', role:'caregiver', status:'active' });
  const created = await api('/api/center/care-profile-link-requests', { user:'U-OWNER', method:'POST', body:{ centerId:center.center_id } });
  const token = new URL(created.body.linkUrl).searchParams.get('centerLink');
  const opened = await api(`/api/access-links/${encodeURIComponent(token)}/open`, { user:'U-OWNER-FAMILY', method:'POST', body:{} });
  assert.deepEqual(opened.body.eligibleProfiles.map((row) => row.careProfileId), [ownerProfile.care_profile_id]);
  const forged = await api(`/api/access-requests/${opened.body.requestId}/respond`, {
    user:'U-OWNER-FAMILY', method:'POST', body:{ approved:true, careProfileId:caregiverProfile.care_profile_id },
  });
  assert.equal(forged.response.status, 403);
  const unrelated = await api(`/api/access-requests/${opened.body.requestId}/respond`, {
    user:'U-OTHER', method:'POST', body:{ approved:true, careProfileId:ownerProfile.care_profile_id },
  });
  assert.equal(unrelated.response.status, 403);
  assert.equal((await db.Residents.findAll()).length, 0);
});

test('Flow A decline through HTTP persists, removes the card on reload, and cannot later be approved', async () => {
  const center = await setupCenter();
  const profile = await familyService.createIndependentProfile({ ownerLineId:'U-FAMILY', patientName:'ป้าศรี' });
  const created = await api('/api/center/care-profile-link-requests', { user:'U-OWNER', method:'POST', body:{ centerId:center.center_id } });
  const token = new URL(created.body.linkUrl).searchParams.get('centerLink');
  const opened = await api(`/api/access-links/${encodeURIComponent(token)}/open`, { user:'U-FAMILY', method:'POST', body:{} });
  const declined = await api(`/api/access-requests/${opened.body.requestId}/respond`, { user:'U-FAMILY', method:'POST', body:{ approved:false } });
  assert.equal(declined.response.status, 200);
  assert.equal((await api('/api/access-requests', { user:'U-FAMILY' })).body.requests.length, 0);
  assert.equal((await api(`/api/access-links/${encodeURIComponent(token)}/open`, { user:'U-FAMILY', method:'POST', body:{} })).response.status, 410);
  const lateApproval = await api(`/api/access-requests/${opened.body.requestId}/respond`, {
    user:'U-FAMILY', method:'POST', body:{ approved:true, careProfileId:profile.care_profile_id },
  });
  assert.equal(lateApproval.response.status, 409);
  assert.equal((await db.Residents.findAll()).length, 0);
});

test('Center status lookup is Center-bound and reveals no selected actor/profile before approval', async () => {
  const center = await setupCenter();
  const other = await centerService.createCenter({ name:'ศูนย์อื่น', ownerLineId:'U-OTHER-OWNER' });
  await familyService.createIndependentProfile({ ownerLineId:'U-FAMILY', patientName:'ป้าศรี' });
  const created = await api('/api/center/care-profile-link-requests', { user:'U-OWNER', method:'POST', body:{ centerId:center.center_id } });
  const token = new URL(created.body.linkUrl).searchParams.get('centerLink');
  const opened = await api(`/api/access-links/${encodeURIComponent(token)}/open`, { user:'U-FAMILY', method:'POST', body:{} });
  const own = await api(`/api/access-requests/${opened.body.requestId}?centerId=${encodeURIComponent(center.center_id)}`, { user:'U-OWNER' });
  assert.equal(own.response.status, 200);
  assert.deepEqual(own.body, { requestId:opened.body.requestId, status:'pending' });
  const forged = await api(`/api/access-requests/${opened.body.requestId}?centerId=${encodeURIComponent(other.center_id)}`, { user:'U-OTHER-OWNER' });
  assert.equal(forged.response.status, 404);
});

test('Flow B HTTP decline requires explicit confirmation and remains gone after reload', async () => {
  const center = await setupCenter();
  const added = await centerService.addResident({ centerId:center.center_id, fullName:'ป้าศรี' });
  await centerService.createCenterManagedCareProfile({ centerId:center.center_id, residentId:added.resident.resident_id, profileData:{}, requesterLineId:'U-OWNER' });
  const token = new URL(added.inviteUrl).searchParams.get('token');
  const missingConfirmation = await api(`/api/invite/${encodeURIComponent(token)}/decline`, { user:'U-FAMILY', method:'POST', body:{} });
  assert.equal(missingConfirmation.response.status, 400);
  assert.equal((await api(`/api/invite/${encodeURIComponent(token)}`, { user:'U-FAMILY' })).response.status, 200);
  const declined = await api(`/api/invite/${encodeURIComponent(token)}/decline`, { user:'U-FAMILY', method:'POST', body:{ confirmed:true } });
  assert.equal(declined.response.status, 200);
  assert.equal((await api(`/api/invite/${encodeURIComponent(token)}`, { user:'U-FAMILY' })).response.status, 410);
  const accept = await api(`/api/invite/${encodeURIComponent(token)}/accept`, { user:'U-FAMILY', method:'POST', body:{} });
  assert.notEqual(accept.response.status, 201);
  const resident = await db.Residents.findOneByField('resident_id', added.resident.resident_id);
  assert.equal(resident.status, 'active');
  assert.ok(resident.care_profile_id);
});
