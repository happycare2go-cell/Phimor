const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LIFF_ID_FAMILY = 'TEST_FAMILY_LIFF';

const db = require('../backend/db');
const accessService = require('../backend/services/accessService');
const centerService = require('../backend/services/centerService');
const familyService = require('../backend/services/familyService');

beforeEach(() => db.resetAll());

async function center(name = 'ศูนย์ตัวอย่าง', ownerLineId = 'U-CENTER-OWNER') {
  return centerService.createCenter({
    name, ownerLineId, address:'99 ถนนตัวอย่าง', contactPhone:'02-000-0000',
  });
}

async function profile(careProfileId, ownerLineId, patientName, patch = {}) {
  return db.CareProfiles.insert({
    care_profile_id:careProfileId, owner_line_id:ownerLineId,
    patient_name:patientName, center_id:null, status:'independent',
    managed_by_center:false, created_at:`2026-08-${String(patch.day || 1).padStart(2, '0')}T00:00:00.000Z`,
    ...patch,
  });
}

function tokenFrom(result) {
  return new URL(result.linkUrl).searchParams.get('centerLink');
}

async function openedRequest({ actor = 'U-FAMILY', centerRecord, patient = 'ป้าศรี', profileId = 'CP-1' } = {}) {
  const linkedCenter = centerRecord || await center();
  const selected = await profile(profileId, actor, patient);
  const created = await accessService.createAnonymousLinkRequest({
    centerId:linkedCenter.center_id, requestedBy:linkedCenter.owner_line_id,
  });
  const token = tokenFrom(created);
  const opened = await accessService.openAnonymousLink({ token, lineUserId:actor });
  return { linkedCenter, selected, created, token, opened };
}

test('Flow A creates only an anonymous seven-day one-use request and stores only a SHA-256 token hash', async () => {
  const linkedCenter = await center();
  const beforeResidents = await db.Residents.findAll();
  const beforeProfiles = await db.CareProfiles.findAll();
  const result = await accessService.createAnonymousLinkRequest({ centerId:linkedCenter.center_id, requestedBy:'U-CENTER-OWNER' });
  assert.equal(result.ok, true);
  const token = tokenFrom(result);
  assert.ok(token.length >= 43, '256-bit base64url token is returned only to its creator');
  assert.equal((await db.Residents.findAll()).length, beforeResidents.length);
  assert.equal((await db.CareProfiles.findAll()).length, beforeProfiles.length);
  const stored = (await db.AccessRequests.findAll())[0];
  assert.equal(stored.request_kind, accessService.ANONYMOUS_REQUEST_KIND);
  assert.equal(stored.care_profile_id, null);
  assert.equal(stored.resident_id, null);
  assert.equal(stored.status, 'pending');
  assert.match(stored.link_token_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(stored).includes(token), false);
  const ttl = new Date(stored.expires_at) - new Date(stored.requested_at);
  assert.ok(ttl > 6.99 * 86400000 && ttl <= 7.01 * 86400000);
  assert.equal(JSON.stringify(await db.AuditLog.findAll()).includes(token), false);
});

test('Flow A owner selector is owner-only, deterministic, de-duplicated and excludes linked/ineligible profiles', async () => {
  const actor = 'U-FAMILY';
  const linkedCenter = await center();
  await profile('CP-2', actor, 'คุณพ่อ', { day:2 });
  await profile('CP-1', actor, 'คุณแม่', { day:1 });
  await profile('CP-LINKED', actor, 'คุณตา', { center_id:linkedCenter.center_id, status:'linked', day:3 });
  await profile('CP-CAREGIVER', 'U-OTHER', 'คุณยาย', { day:4 });
  await db.CareProfileMembers.insert({ member_id:'M-1', care_profile_id:'CP-CAREGIVER', line_user_id:actor, role:'caregiver', status:'active' });
  const created = await accessService.createAnonymousLinkRequest({ centerId:linkedCenter.center_id, requestedBy:'U-CENTER-OWNER' });
  const opened = await accessService.openAnonymousLink({ token:tokenFrom(created), lineUserId:actor });
  assert.deepEqual(opened.request.eligibleProfiles, [
    { careProfileId:'CP-1', patientName:'คุณแม่' },
    { careProfileId:'CP-2', patientName:'คุณพ่อ' },
  ]);
  assert.doesNotMatch(JSON.stringify(opened.request), /U-FAMILY|U-OTHER|CP-LINKED|CP-CAREGIVER/);
});

test('first opener is bound once, may resume from owner-wide inbox, and a second actor cannot take over', async () => {
  const linkedCenter = await center();
  await profile('CP-1', 'U-FIRST', 'คุณแม่');
  await profile('CP-2', 'U-SECOND', 'คุณพ่อ');
  const created = await accessService.createAnonymousLinkRequest({ centerId:linkedCenter.center_id, requestedBy:'U-CENTER-OWNER' });
  const token = tokenFrom(created);
  assert.equal((await accessService.openAnonymousLink({ token, lineUserId:'U-FIRST' })).ok, true);
  const second = await accessService.openAnonymousLink({ token, lineUserId:'U-SECOND' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'LINK_ACTOR_MISMATCH');
  assert.doesNotMatch(second.reason, /U-FIRST|คุณแม่/);
  const resumed = await accessService.listPendingRequestsForOwner('U-FIRST');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].requestKind, accessService.ANONYMOUS_REQUEST_KIND);
  assert.equal((await accessService.listPendingRequestsForOwner('U-SECOND')).length, 0);
  const centerProjection = await accessService.listActiveAnonymousLinksForCenter(linkedCenter.center_id);
  assert.equal(centerProjection.length, 1);
  assert.deepEqual(Object.keys(centerProjection[0]).sort(), ['expiresAt','requestedAt','status']);
});

test('Flow A approval atomically creates one minimal Resident and links exactly the selected owned profile', async () => {
  const actor = 'U-FAMILY';
  const linkedCenter = await center();
  await profile('CP-1', actor, 'ป้าศรี', { day:1, family_phone:'0899999999', blood_type:'O' });
  await profile('CP-2', actor, 'คุณพ่อ', { day:2 });
  await db.GroupBindings.insert({ binding_id:'GB-1', kind:'family', care_profile_id:'CP-2', line_group_id:'G-FAMILY', status:'active' });
  const created = await accessService.createAnonymousLinkRequest({ centerId:linkedCenter.center_id, requestedBy:'U-CENTER-OWNER' });
  const token = tokenFrom(created);
  const opened = await accessService.openAnonymousLink({ token, lineUserId:actor });
  const approved = await accessService.respondAccessRequest(opened.request.requestId, true, actor, 'CP-2');
  assert.equal(approved.ok, true);
  const residents = await db.Residents.findAll();
  assert.equal(residents.length, 1);
  assert.deepEqual({
    center_id:residents[0].center_id, full_name:residents[0].full_name,
    aliases:residents[0].aliases, room:residents[0].room,
    family_phone:residents[0].family_phone, care_profile_id:residents[0].care_profile_id,
    status:residents[0].status, link_status:residents[0].link_status,
  }, {
    center_id:linkedCenter.center_id, full_name:'คุณพ่อ', aliases:[], room:null,
    family_phone:null, care_profile_id:'CP-2', status:'active', link_status:'linked',
  });
  assert.equal(residents[0].link_request_id, opened.request.requestId);
  assert.equal((await db.CareProfiles.findOneByField('care_profile_id', 'CP-1')).status, 'independent');
  const selected = await db.CareProfiles.findOneByField('care_profile_id', 'CP-2');
  assert.equal(selected.center_id, linkedCenter.center_id);
  assert.equal(selected.status, 'linked');
  const request = await db.AccessRequests.findOneByField('request_id', opened.request.requestId);
  assert.equal(request.status, 'approved');
  assert.equal(request.care_profile_id, 'CP-2');
  assert.equal(request.resident_id, residents[0].resident_id);
  assert.ok(request.approved_at && request.consumed_at);
  assert.equal((await db.GroupBindings.findOne((row) => row.binding_id === 'GB-1')).line_group_id, 'G-FAMILY');
  const audit = await db.AuditLog.findOne((row) => row.action === 'access_request.anonymous_link_approved');
  assert.ok(audit);
  assert.equal(JSON.stringify(audit).includes(token), false);
});

test('same approval retry is idempotent, another profile replay is rejected, and two tabs converge', async () => {
  const actor = 'U-FAMILY';
  const linkedCenter = await center();
  await profile('CP-1', actor, 'ป้าศรี');
  await profile('CP-2', actor, 'คุณพ่อ', { day:2 });
  const created = await accessService.createAnonymousLinkRequest({ centerId:linkedCenter.center_id, requestedBy:'U-CENTER-OWNER' });
  const opened = await accessService.openAnonymousLink({ token:tokenFrom(created), lineUserId:actor });
  const [first, second] = await Promise.all([
    accessService.respondAccessRequest(opened.request.requestId, true, actor, 'CP-1'),
    accessService.respondAccessRequest(opened.request.requestId, true, actor, 'CP-1'),
  ]);
  assert.equal(first.ok && second.ok, true);
  assert.equal([first, second].filter((item) => item.duplicate).length, 1);
  assert.equal((await db.Residents.findAll()).length, 1);
  const replay = await accessService.respondAccessRequest(opened.request.requestId, true, actor, 'CP-2');
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'REQUEST_ALREADY_USED');
  assert.equal((await db.Residents.findAll()).length, 1);
});

test('two Centers racing for one profile create one Resident and only one Center wins', async () => {
  const actor = 'U-FAMILY';
  const centerA = await center('ศูนย์ A', 'U-A');
  const centerB = await center('ศูนย์ B', 'U-B');
  await profile('CP-1', actor, 'ป้าศรี');
  const linkA = await accessService.createAnonymousLinkRequest({ centerId:centerA.center_id, requestedBy:'U-A' });
  const linkB = await accessService.createAnonymousLinkRequest({ centerId:centerB.center_id, requestedBy:'U-B' });
  const openA = await accessService.openAnonymousLink({ token:tokenFrom(linkA), lineUserId:actor });
  const openB = await accessService.openAnonymousLink({ token:tokenFrom(linkB), lineUserId:actor });
  const results = await Promise.all([
    accessService.respondAccessRequest(openA.request.requestId, true, actor, 'CP-1'),
    accessService.respondAccessRequest(openB.request.requestId, true, actor, 'CP-1'),
  ]);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal((await db.Residents.findAll()).length, 1);
  const linked = await db.CareProfiles.findOneByField('care_profile_id', 'CP-1');
  assert.ok([centerA.center_id, centerB.center_id].includes(linked.center_id));
});

test('approval revalidates ownership and eligibility after the link page was opened', async () => {
  const fixture = await openedRequest();
  await db.CareProfiles.update((row) => row.care_profile_id === fixture.selected.care_profile_id, { owner_line_id:'U-NEW-OWNER' });
  const lostOwnership = await accessService.respondAccessRequest(
    fixture.opened.request.requestId, true, 'U-FAMILY', fixture.selected.care_profile_id
  );
  assert.equal(lostOwnership.ok, false);
  assert.equal(lostOwnership.code, 'OWNER_REQUIRED');
  assert.equal((await db.Residents.findAll()).length, 0);

  db.resetAll();
  const staleFixture = await openedRequest({ profileId:'CP-STALE' });
  await db.CareProfiles.update((row) => row.care_profile_id === staleFixture.selected.care_profile_id, {
    center_id:'CTR-OTHER', status:'linked',
  });
  const stale = await accessService.respondAccessRequest(
    staleFixture.opened.request.requestId, true, 'U-FAMILY', staleFixture.selected.care_profile_id
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'ALREADY_CENTER_LINKED');
  assert.equal((await db.Residents.findAll()).length, 0);
});

test('an authenticated System Admin identity cannot bind a Family consent request without an owned profile', async () => {
  const linkedCenter = await center();
  const owned = await profile('CP-1', 'U-FAMILY', 'ป้าศรี');
  const created = await accessService.createAnonymousLinkRequest({ centerId:linkedCenter.center_id, requestedBy:'U-CENTER-OWNER' });
  const opened = await accessService.openAnonymousLink({ token:tokenFrom(created), lineUserId:'U-SYSTEM-ADMIN' });
  assert.equal(opened.ok, false);
  assert.equal(opened.code, 'OWNER_PROFILE_REQUIRED');
  assert.equal((await db.AccessRequests.findAll())[0].presented_to_line_user_id, null);
  const actualOwner = await accessService.openAnonymousLink({ token:tokenFrom(created), lineUserId:'U-FAMILY' });
  assert.equal(actualOwner.ok, true);
  assert.deepEqual(actualOwner.request.eligibleProfiles.map((item) => item.careProfileId), [owned.care_profile_id]);
  assert.equal((await db.Residents.findAll()).length, 0);
});

test('Flow A decline persists, removes the inbox card, invalidates the token and reveals no identity to Center', async () => {
  const fixture = await openedRequest();
  const result = await accessService.respondAccessRequest(fixture.opened.request.requestId, false, 'U-FAMILY');
  assert.deepEqual(result, { ok:true, status:'declined' });
  assert.equal((await db.Residents.findAll()).length, 0);
  const selected = await db.CareProfiles.findOneByField('care_profile_id', 'CP-1');
  assert.equal(selected.center_id, null);
  assert.equal((await accessService.listPendingRequestsForOwner('U-FAMILY')).length, 0);
  const reopened = await accessService.openAnonymousLink({ token:fixture.token, lineUserId:'U-FAMILY' });
  assert.equal(reopened.ok, false);
  assert.equal(reopened.code, 'LINK_DECLINED');
  const status = await accessService.getRequestStatusForCenter(fixture.opened.request.requestId, fixture.linkedCenter.center_id);
  assert.deepEqual(status, { requestId:fixture.opened.request.requestId, status:'not_approved' });
  assert.doesNotMatch(JSON.stringify(status), /U-FAMILY|ป้าศรี|CP-1|reason/i);
  const audit = await db.AuditLog.findOne((row) => row.action === 'access_request.anonymous_link_declined');
  assert.ok(audit);
  assert.equal(JSON.stringify(audit).includes(fixture.token), false);
});

test('expired, revoked and inactive-Center anonymous requests are terminal without creating a Resident', async () => {
  const expiredFixture = await openedRequest({ profileId:'CP-EXPIRED' });
  await db.AccessRequests.update((row) => row.request_id === expiredFixture.opened.request.requestId, {
    expires_at:new Date(Date.now() - 1000).toISOString(),
  });
  const expired = await accessService.respondAccessRequest(expiredFixture.opened.request.requestId, true, 'U-FAMILY', 'CP-EXPIRED');
  assert.equal(expired.ok, false);
  assert.equal((await db.AccessRequests.findOneByField('request_id', expiredFixture.opened.request.requestId)).status, 'expired');

  db.resetAll();
  const revokedFixture = await openedRequest({ profileId:'CP-REVOKED' });
  await db.AccessRequests.update((row) => row.request_id === revokedFixture.opened.request.requestId, { status:'revoked', revoked_at:new Date().toISOString() });
  const revoked = await accessService.openAnonymousLink({ token:revokedFixture.token, lineUserId:'U-FAMILY' });
  assert.equal(revoked.code, 'LINK_REVOKED');

  db.resetAll();
  const inactiveFixture = await openedRequest({ profileId:'CP-INACTIVE' });
  await db.Centers.update((row) => row.center_id === inactiveFixture.linkedCenter.center_id, { status:'suspended' });
  const inactive = await accessService.respondAccessRequest(inactiveFixture.opened.request.requestId, true, 'U-FAMILY', 'CP-INACTIVE');
  assert.equal(inactive.code, 'CENTER_NOT_AVAILABLE');
  assert.equal((await db.Residents.findAll()).length, 0);
});

test('Flow B explicit decline is authoritative, preserves its Resident/profile/history, and permits a fresh invite', async () => {
  const linkedCenter = await center();
  const added = await centerService.addResident({ centerId:linkedCenter.center_id, fullName:'คุณยาย', room:'A201', familyPhone:'0811111111' });
  const created = await centerService.createCenterManagedCareProfile({
    centerId:linkedCenter.center_id, residentId:added.resident.resident_id,
    profileData:{ bloodType:'O', chronicConditions:['ตัวอย่าง'] }, requesterLineId:'U-CENTER-OWNER',
  });
  await db.Medications.insert({ medication_id:'MED-1', care_profile_id:created.profile.care_profile_id, name:'ยาตัวอย่าง' });
  const token = new URL(added.inviteUrl).searchParams.get('token');
  assert.equal((await familyService.declineInvite(token, 'U-FAMILY')).ok, true);
  assert.equal((await familyService.acceptInvite(token, 'U-FAMILY')).ok, false);
  const resident = await db.Residents.findOneByField('resident_id', added.resident.resident_id);
  const preserved = await db.CareProfiles.findOneByField('care_profile_id', created.profile.care_profile_id);
  assert.equal(resident.status, 'active');
  assert.equal(resident.care_profile_id, created.profile.care_profile_id);
  assert.equal(preserved.managed_by_center, true);
  assert.equal((await db.Medications.findWhereByField('care_profile_id', created.profile.care_profile_id)).length, 1);
  const fresh = await centerService.getOrCreateResidentInvite({ centerId:linkedCenter.center_id, residentId:resident.resident_id });
  assert.notEqual(new URL(fresh.inviteUrl).searchParams.get('token'), token);
  assert.equal((await familyService.acceptInvite(new URL(fresh.inviteUrl).searchParams.get('token'), 'U-FAMILY')).ok, true);
  assert.equal((await db.CareProfiles.findWhere((row) => row.patient_name === 'คุณยาย')).length, 1);
});

test('new Flow B phone input creates no AccessRequest while explicit legacy known-profile requests still work', async () => {
  const actor = 'U-FAMILY';
  const linkedCenter = await center();
  const existing = await profile('CP-1', actor, 'คุณแม่', { family_phone:'0891234567' });
  const added = await centerService.addResident({ centerId:linkedCenter.center_id, fullName:'คุณแม่', familyPhone:'0891234567' });
  assert.equal(added.accessRequestSent, false);
  assert.equal((await db.AccessRequests.findAll()).length, 0);
  const legacy = await accessService.createAccessRequest({
    centerId:linkedCenter.center_id, careProfileId:existing.care_profile_id,
    residentId:added.resident.resident_id, requestedBy:'U-CENTER-OWNER',
  });
  assert.equal(legacy.ok, true);
  assert.equal((await accessService.respondAccessRequest(legacy.request.request_id, true, actor)).ok, true);
  assert.equal((await db.Residents.findOneByField('resident_id', added.resident.resident_id)).care_profile_id, existing.care_profile_id);
});

test('expired known-profile requests are absent from owner inbox and cannot be approved or declined', async () => {
  const actor = 'U-FAMILY';
  const linkedCenter = await center();
  const existing = await profile('CP-1', actor, 'คุณแม่');
  const legacy = await accessService.createAccessRequest({ centerId:linkedCenter.center_id, careProfileId:existing.care_profile_id, requestedBy:'U-CENTER-OWNER' });
  await db.AccessRequests.update((row) => row.request_id === legacy.request.request_id, { expires_at:new Date(Date.now() - 1000).toISOString() });
  assert.equal((await accessService.listPendingRequestsForOwner(actor)).length, 0);
  assert.equal((await db.AccessRequests.findOneByField('request_id', legacy.request.request_id)).status, 'expired');
  assert.equal((await accessService.respondAccessRequest(legacy.request.request_id, true, actor)).ok, false);
  assert.equal((await accessService.respondAccessRequest(legacy.request.request_id, false, actor)).ok, false);
});

test('legacy Resident Invite without a status field still claims the same Center-managed profile', async () => {
  const linkedCenter = await center();
  const resident = await db.Residents.insert({
    resident_id:'R-LEGACY', center_id:linkedCenter.center_id, full_name:'คุณตา',
    status:'active', care_profile_id:'CP-LEGACY', link_status:'center_managed',
  });
  const managed = await db.CareProfiles.insert({
    care_profile_id:'CP-LEGACY', owner_line_id:null, patient_name:'คุณตา', center_id:linkedCenter.center_id,
    status:'linked', managed_by_center:true,
  });
  await db.Invites.insert({ invite_token:'INV-LEGACY', resident_id:resident.resident_id, expires_at:new Date(Date.now() + 86400000).toISOString(), used_at:null });
  const accepted = await familyService.acceptInvite('INV-LEGACY', 'U-FAMILY');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.careProfile.care_profile_id, managed.care_profile_id);
  assert.equal(accepted.careProfile.owner_line_id, 'U-FAMILY');
  assert.equal((await db.CareProfiles.findAll()).length, 1);
});
