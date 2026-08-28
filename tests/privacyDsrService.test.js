const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const db = require('../backend/db');
const familyService = require('../backend/services/familyService');
const privacyService = require('../backend/services/privacyService');
const identity = require('../backend/utils/safeIdentity');

test.beforeEach(() => db.resetAll());

test('latest consent event is authoritative and withdrawal does not destroy Care Profile data', async () => {
  await db.CareProfiles.insert({ care_profile_id:'CP-1', owner_line_id:'U-A', patient_name:'ผู้รับการดูแลตัวอย่าง' });
  await familyService.recordConsent('U-A', true);
  assert.equal((await familyService.getConsentState('U-A')).status, 'active');
  await familyService.recordConsent('U-A', false);
  assert.deepEqual(await familyService.getConsentState('U-A'), {
    hasConsent:false, status:'withdrawn', version:familyService.CONSENT_VERSION,
    updatedAt:(await db.Consents.findAll())[0].at,
  });
  assert.ok(await db.CareProfiles.findOne((row) => row.care_profile_id === 'CP-1'));
  assert.equal((await familyService.getConsentState('U-B')).status, 'not_given');
});

test('concurrent duplicate DSR submission returns one active request without blocking a later terminal request', async () => {
  const [first, second] = await Promise.all([
    privacyService.createRequest({ lineUserId:'U-A', type:'export', note:'ขอสำเนาข้อมูลบัญชี' }),
    privacyService.createRequest({ lineUserId:'U-A', type:'export', note:'กดซ้ำจากอีกแท็บ' }),
  ]);
  assert.equal((await db.DataSubjectRequests.findAll()).length, 1);
  assert.equal([first, second].filter((item) => item.created).length, 1);
  const stored = (await db.DataSubjectRequests.findAll())[0];
  await privacyService.updateRequest({ requestId:stored.request_id, status:'rejected', publicNote:'กรุณายืนยันข้อมูลเพิ่มเติม', actorReference:'admin:test' });
  const later = await privacyService.createRequest({ lineUserId:'U-A', type:'export', note:'ส่งใหม่ภายหลัง' });
  assert.equal(later.created, true);
  assert.equal((await db.DataSubjectRequests.findAll()).length, 2);
});

test('Family DSR projection is actor-owned, minimized and non-enumerable', async () => {
  await privacyService.createRequest({ lineUserId:'U-A-1234', displayName:'คุณเอ', type:'correct', note:'ขอแก้ชื่อบัญชี' });
  await privacyService.createRequest({ lineUserId:'U-B-9876', displayName:'คุณบี', type:'delete', note:'private B' });
  const own = await privacyService.listOwnRequests('U-A-1234');
  assert.equal(own.length, 1); assert.equal(own[0].type, 'correct');
  assert.doesNotMatch(JSON.stringify(own), /U-A-1234|U-B-9876|private B|line_user/i);
  const rowB = (await db.DataSubjectRequests.findAll()).find((row) => row.line_user_id === 'U-B-9876');
  await assert.rejects(
    privacyService.getOwnRequest({ lineUserId:'U-A-1234', requestId:rowB.request_id }),
    (error) => error.code === 'DATA_REQUEST_NOT_FOUND' && error.status === 404,
  );
});

test('completed DSR requires explicit manual fulfillment attestation and audit excludes request text', async () => {
  await privacyService.createRequest({ lineUserId:'U-A', type:'restrict', note:'ข้อความส่วนตัวห้ามเข้า audit' });
  const row = (await db.DataSubjectRequests.findAll())[0];
  await assert.rejects(
    privacyService.updateRequest({ requestId:row.request_id, status:'completed', actorReference:'admin:test' }),
    (error) => error.code === 'MANUAL_FULFILLMENT_CONFIRMATION_REQUIRED',
  );
  const updated = await privacyService.updateRequest({ requestId:row.request_id, status:'completed', publicNote:'ดำเนินการตามขั้นตอนแล้ว', manualFulfillmentConfirmed:true, actorReference:'admin:test' });
  assert.equal(updated.status, 'completed'); assert.equal(updated.fulfillmentMode, 'manual_review');
  const audit = JSON.stringify(await db.AuditLog.findAll());
  assert.match(audit, /privacy\.data_request_created/); assert.match(audit, /privacy\.data_request_updated/);
  assert.doesNotMatch(audit, /ข้อความส่วนตัว|ดำเนินการตามขั้นตอนแล้ว/);
});

test('central identity display prefers verified name and otherwise masks the LINE identifier consistently', () => {
  assert.equal(identity.displayIdentity({ displayName:' คุณสมใจ ', lineUserId:'U-secret-1642' }), 'คุณสมใจ');
  assert.equal(identity.displayIdentity({ lineUserId:'U-secret-1642' }), 'บัญชี LINE ••••1642');
  assert.doesNotMatch(identity.displayIdentity({ lineUserId:'U-secret-1642' }), /U-secret/);
});
