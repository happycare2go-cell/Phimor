const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'liff-app', 'family', 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'liff-app', 'family', 'family-home-v2.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'liff-app', 'family', 'family-home-v2.css'), 'utf8');
const home = require('../liff-app/family/family-home-v2');

function functionSource(name, nextName) {
  const start = html.indexOf(`function ${name}`);
  const end = nextName ? html.indexOf(`function ${nextName}`, start + 1) : html.length;
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return html.slice(start, end);
}

const profile = (id = 'CP-1') => ({
  profile: { care_profile_id:id, patient_name:'คุณแม่', _updatedAt:'2026-08-26T08:00:00Z' },
  familyRole:'owner',
  upcomingAppointments:[{ hospital:'โรงพยาบาลตัวอย่าง', datetime:'2026-09-01T09:00:00Z' }],
});

test('Home V2 uses the approved hierarchy without a new bottom navigation', () => {
  const order = ['careProfileAnchor', 'familyActionsSection', 'careProfileGrid', 'familyServicesGrid', 'familyConnectionsList', 'familyRecentActivity'].map((id) => html.indexOf(`id="${id}"`));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(html, /bottom-navigation|bottom-nav/);
  assert.doesNotMatch(html, /class="tabs"|class="tab(?:\s|"|>)/);
  assert.match(html, /family-home-v2\.css/);
  assert.match(html, /family-home-v2\.js/);
});

test('top header shows the authenticated LINE profile without exposing the LINE user id', () => {
  assert.match(html, /aria-label="บัญชี LINE ที่กำลังใช้งาน"/);
  assert.match(html, /id="lineProfilePicture"/);
  assert.match(html, /id="lineProfileFallback"/);
  assert.match(html, /id="lineDisplayName"/);
  const render = functionSource('renderLineIdentity', 'askConfirm');
  assert.match(render, /profile\?\.displayName/);
  assert.match(render, /profile\?\.pictureUrl/);
  assert.match(render, /name\.textContent=displayName/);
  assert.doesNotMatch(render, /userId|LINE_USER_ID|innerHTML|localStorage|sessionStorage/);
  assert.match(css, /family-line-identity__avatar/);
  assert.match(css, /object-fit:cover/);
});

test('Care Profile is a compact context anchor and selector remains backend-dashboard driven', () => {
  assert.match(html, /กำลังดูข้อมูลของ/);
  assert.match(html, /id="familyProfileSwitch" hidden/);
  assert.match(html, /id="profileSelector" aria-label="สลับ Care Profile" onchange="selectProfile\(this\.value\)"/);
  const render = functionSource('renderProfileAnchor', 'loadDashboard');
  assert.match(render, /allProfiles\.forEach/);
  assert.match(render, /option\.value=entry\.profile\.care_profile_id/);
  assert.match(render, /selector\.disabled=allProfiles\.length<2/);
  assert.match(render, /familyProfileSwitch/);
  assert.match(css, /family-profile-anchor\{padding:13px 14px/);
  assert.match(css, /family-profile-switch select\{position:absolute/);
});

test('existing users can add another independent Care Profile through the reused form', () => {
  assert.match(html, /id="addCareProfileButton"[^>]*>\+ เพิ่ม Care Profile<\/button>/);
  const open = functionSource('openAddProfileForm', 'closeAddProfileForm');
  assert.match(open, /noProfileCard/);
  assert.match(open, /createProfileButton/);
  const create = functionSource('createIndependentProfile', 'collectProfileForm');
  assert.match(create, /\/api\/care-profile\/independent/);
  assert.match(create, /loadDashboard\(created\.care_profile_id\)/);
  assert.equal((html.match(/id="newProfileName"/g) || []).length, 1, 'the creation form must not be duplicated');
});

test('legacy top navigation is removed while all underlying capabilities remain reachable', () => {
  for (const destination of ['health', 'medications', 'appointments', 'lab', 'family', 'access']) {
    assert.match(html, new RegExp(`data-family-destination="${destination}"`));
  }
  assert.match(html, /onclick="openFamilyDestination\('history'\)">ดูประวัติยาและส่งออก PDF/);
  assert.match(html, /onclick="openFamilyDestination\('history'\)">ประวัติและ PDF/);
  assert.match(html, /loadHistory\(\)/);
  assert.match(html, /id="healthProfileFormCard"/);
  assert.match(html, /id="medicationEntryCard"/);
  assert.match(html, /id="appointmentListCard"/);
  assert.match(html, /id="appointmentEntryCard"/);
  const navigate = functionSource('openFamilyDestination', 'acceptConsent');
  for (const view of ['health', 'record', 'history']) assert.match(navigate, new RegExp(`activateView\\('${view}'\\)`));
});

test('service cards route to the existing Lab, 1D, 1E, Plus, and consultation implementations', () => {
  for (const destination of ['lab-analysis', 'doctor-questions', 'doctor-visit', 'consultation', 'plus']) {
    assert.match(html, new RegExp(`data-family-destination="${destination}"`));
  }
  const navigate = functionSource('openFamilyDestination', 'acceptConsent');
  assert.match(navigate, /destination==='lab'\|\|destination==='lab-analysis'/);
  assert.match(navigate, /LAB_RESULTS_UI\.session\.open\(\)/);
  assert.match(navigate, /PLUS_UI\.runQuickAction\('doctor-questions'\)/);
  assert.match(navigate, /ensureDoctorVisitUI\(\)/);
  assert.match(navigate, /ensureConsultationUI\(\)/);
  assert.equal((html.match(/id="labResultsPanel"/g) || []).length, 1);
  assert.equal((html.match(/id="doctorVisitPanel"/g) || []).length, 1);
  assert.equal((html.match(/id="consultationPanel"/g) || []).length, 1);
  assert.equal((html.match(/id="plusPanel"/g) || []).length, 1);
  assert.match(html, /ผลตรวจล่าสุด/);
  assert.match(html, /วิเคราะห์ผลตรวจ &amp; AI/);
  assert.equal((html.match(/id="labResultsPanel"/g) || []).length, 1);
});

test('full service panels moved out of Home and render one module at a time', () => {
  const services = html.indexOf('id="view-services"');
  const record = html.indexOf('id="view-record"');
  for (const id of ['labResultsPanel', 'consultationPanel', 'doctorVisitPanel', 'plusPanel']) {
    const position = html.indexOf(`id="${id}"`);
    assert.ok(position > services && position < record, `${id} must live in service workspace`);
  }
  assert.match(css, /\[data-family-module\]\.family-module-active:not\(\[hidden\]\)/);
  assert.match(html, /activateServiceModule\('lab',destination==='lab-analysis'\?'วิเคราะห์ผลตรวจ & AI':'ผลตรวจล่าสุด'\)/);
});

test('family and access tools use a lighter list while preserving distinct canonical flows', () => {
  assert.match(html, /ครอบครัวและการเข้าถึง/);
  assert.match(html, /class="family-admin-list"/);
  for (const destination of ['family', 'invite', 'access', 'group']) assert.match(html, new RegExp(`data-family-destination="${destination}"`));
  assert.match(html, /id="caregiverInviteCard"/);
  assert.match(html, /id="caregiverMembersSection"/);
  assert.match(html, /createCaregiverInvite\(\)/);
  assert.match(html, /caregiver-invites/);
  assert.match(html, /INVITE_TOKEN/);
  assert.match(html, /SHARE_TOKEN/);
  assert.match(html, /id="familyAccessSection"/);
  assert.match(html, /\/api\/access-requests/);
  assert.match(html, /id="familyBindingCard"/);
  assert.match(html, /group-binding-token/);
  assert.match(html, /สร้างรหัสผูกกลุ่ม/);
  assert.doesNotMatch(source, /merge.*invite.*group|sharedInvitationToken/i);
});

test('Family group status is profile-scoped, hides binding action when active, and never renders raw groupId', () => {
  assert.match(html, /id="familyBindingStatus"/);
  assert.match(html, /id="familyBindingAction"/);
  const render = functionSource('renderFamilyGroupStatus', 'loadDashboard');
  assert.match(render, /familyGroup\?\.active===true/);
  assert.match(render, /เชื่อมกลุ่มครอบครัวแล้ว/);
  assert.match(render, /ยังไม่ได้เชื่อมกลุ่มครอบครัว/);
  assert.match(render, /familyBindingAction'\)\.hidden=active\|\|!isOwner/);
  assert.doesNotMatch(render, /groupId|line_group_id/);
});

test('consultation action is derived only from backend case collections', () => {
  assert.equal(home.consultationAction({ collections:{ active:[{caseId:'A'}] } }).title, 'กำลังปรึกษาเภสัชกร');
  assert.equal(home.consultationAction({ collections:{ resolved:[{caseId:'R'}] } }).title, 'เภสัชกรตอบประเด็นหลักแล้ว');
  assert.equal(home.consultationAction({ collections:{ queued:[{caseId:'Q'}] } }).title, 'รอเภสัชกรรับเคส');
  assert.equal(home.consultationAction({ collections:{ closed:[{caseId:'C'}] } }), null);
  assert.equal(home.consultationAction(null), null);
  assert.equal(home.consultationServiceLabel({ collections:{ queued:[{}] } }), 'รอเภสัชกร');
  assert.equal(home.consultationServiceLabel({ collections:{ active:[{}] } }), 'กำลังปรึกษา');
  assert.equal(home.consultationServiceLabel({ collections:{ resolved:[{}] } }), 'ตอบประเด็นหลักแล้ว');
  assert.equal(home.consultationServiceLabel(null), 'ห้องปรึกษาเรื่องยา');
});

test('Home actions include only deterministic current-profile facts and never fabricate unread state', () => {
  const actions = home.buildActionItems({
    profileEntry:profile(),
    accessRequests:[{careProfileId:'CP-1'},{careProfileId:'CP-2'}],
    pendingTransport:[{care_profile_id:'CP-1'}],
    consultationState:{collections:{queued:[{caseId:'Q'}]}},
  });
  assert.deepEqual(actions.map((item) => item.kind), ['consultation', 'access', 'transport', 'appointment']);
  assert.doesNotMatch(JSON.stringify(actions), /unread|ข้อความใหม่|notification/i);
  assert.deepEqual(home.buildActionItems({}), []);
  assert.doesNotMatch(source, /unreadCount|notificationCount|fabricat/i);
});

test('upcoming appointment appears only as an action and recent activity contains past/current facts only', () => {
  const actions = home.buildActionItems({ profileEntry:profile() });
  const recent = home.buildRecentItems(profile());
  assert.ok(recent.length <= 3);
  assert.ok(actions.some((item) => item.kind === 'appointment'));
  assert.ok(recent.every((item) => item.destination !== 'appointments'));
  assert.ok(recent.some((item) => item.title === 'อัปเดต Care Profile'));
  assert.match(recent[0].detail, / · \d{2}:\d{2}$/);
  assert.equal((html.match(/id="upcomingList"/g) || []).length, 1);
  assert.ok(html.indexOf('id="upcomingList"') > html.indexOf('id="view-record"'));
  assert.doesNotMatch(source, /\/api\/activity|event timeline|activity table/i);
});

test('recent activity uses one light row without nested action-card styling', () => {
  assert.match(source, /row\.className='family-recent-item'/);
  assert.match(source, /family-recent-item__icon/);
  assert.doesNotMatch(source, /row\.className='family-action family-recent-item'/);
  assert.match(css, /\.family-recent-list\{display:grid;gap:7px\}/);
  assert.match(css, /\.family-recent-item\{[^}]*min-height:52px[^}]*border:1px solid #e6eaf2/);
  assert.match(css, /\.family-recent-item__icon\{[^}]*width:30px[^}]*height:30px[^}]*border-radius:50%/);
});

test('profile switching clears profile-scoped UI before refreshing and modules retain stale guards', () => {
  const select = functionSource('selectProfile', 'loadAccessRequests');
  assert.ok(select.indexOf('clearProfileScopedUi()') < select.indexOf('loadDashboard()'));
  for (const name of ['PLUS_UI', 'CONSULTATION_UI', 'DOCTOR_VISIT_UI', 'LAB_RESULTS_UI']) assert.match(select, new RegExp(name.replace('_', '\\_')));
  const load = functionSource('loadDashboard', 'selectProfile');
  assert.match(load, /token=\+\+DASHBOARD_GENERATION/);
  assert.match(load, /token!==DASHBOARD_GENERATION/);
  assert.match(html, /profileId!==currentProfile\?\.profile\?\.care_profile_id/);
});

test('profile switch clearing covers clinical module output and generated links without browser persistence', () => {
  const clear = functionSource('clearProfileScopedUi', 'renderProfileAnchor');
  for (const value of ['CURRENT_ACCESS_REQUESTS=[]', 'CURRENT_PENDING_TRANSPORT=[]', 'historyList', 'familyBindingCode', 'caregiverInviteUrl', 'LAST_PDF_LINKS=null']) assert.match(clear, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
});

test('medication extraction and confirmation are pinned to immutable profile context', () => {
  const save = functionSource('saveMedication', 'isMedicationOperationCurrent');
  assert.match(save, /const profileId=currentProfile\.profile\.care_profile_id/);
  assert.match(save, /careProfileId:profileId/);
  assert.match(save, /generation:DASHBOARD_GENERATION/);
  assert.match(save, /baseSnapshotId:familyMedicationState\.baseSnapshotId/);
  assert.match(save, /isMedicationOperationCurrent\(operation\)/);
  assert.match(save, /`\/api\/care-profile\/\$\{operation\.careProfileId\}\/medications\/image-proposal`/);
  const confirm = functionSource('confirmMedicationReview', 'persistFamilyMedicationItems');
  assert.match(confirm, /const operation=medicationOperation/);
  assert.match(confirm, /if\(!isMedicationOperationCurrent\(operation\)\)/);
  assert.match(confirm, /persistFamilyMedicationItems\(operation/);
  assert.doesNotMatch(confirm, /currentProfile\.profile\.care_profile_id/);
  const persist = functionSource('persistFamilyMedicationItems', 'clearMedicationForm');
  assert.match(persist, /operation\.careProfileId/);
  assert.match(persist, /baseSnapshotId:operation\.baseSnapshotId/);
  assert.match(persist, /MEDICATION_SNAPSHOT_STALE/);
  const clear = functionSource('clearProfileScopedUi', 'renderProfileAnchor');
  assert.match(clear, /closeMedicationReview\(\)/);
});

test('mobile layout has large touch targets, narrow-screen fallback, focus state, and safe-area padding', () => {
  assert.match(css, /min-height:44px/);
  assert.match(css, /@media\(max-width:360px\)/);
  assert.match(css, /focus-visible/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /overflow-wrap:anywhere/);
  assert.doesNotMatch(css, /overflow-x:\s*(scroll|auto)/);
  assert.match(css, /max-width:620px/);
  assert.doesNotMatch(css, /repeat\(6/);
});

test('UX V2 adds no backend, payment, Lab-domain, or authorization shortcut', () => {
  assert.doesNotMatch(source, /fetch\(|\/api\//);
  assert.doesNotMatch(source, /Omise|amountMinor|10000|confirmDraft|createDraft|PATCH|POST/);
  assert.match(html, /100 บาท \/ 1 Consult Case/);
  assert.match(html, /ระยะเวลา 24 ชั่วโมงเริ่มเมื่อเภสัชกรรับเคส/);
  assert.match(html, /requireBackendUrl/);
});
