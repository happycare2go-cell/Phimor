const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const db = require('../backend/db');
const { loadFeatureFlags } = require('../backend/config/featureFlags');
const { loadConsultationConfig, isInternalConsultationUser } = require('../backend/config/consultationConfig');
const { classifyConsultationSafety } = require('../backend/services/consultationSafetyService');
const { createConsultationEligibilityService } = require('../backend/services/consultationEligibilityService');
const { createConsultationOrderService } = require('../backend/services/consultationOrderService');
const { messageWorkflowTransition, assertWaitingOnInvariant, WAITING_ON_SEMANTICS } = require('../backend/domain/consultation');

const ENABLED = Object.freeze({
  enabled:true, internalOnly:false, internalLineUserIds:[], priceMinor:10000,
  currency:'THB', durationMinutes:1440, pollSeconds:5, maxMessageChars:4000,
  termsVersion:'consult-v1',
});

test.beforeEach(() => db.resetAll());

test('consultation configuration defaults disabled and internal-only with approved invariants', () => {
  const config = loadConsultationConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.internalOnly, true);
  assert.equal(config.priceMinor, 10000);
  assert.equal(config.currency, 'THB');
  assert.equal(config.durationMinutes, 1440);
  assert.equal(config.pollSeconds, 5);
  assert.equal(config.maxMessageChars, 4000);
  assert.deepEqual(loadFeatureFlags({}).consultation, { enabled:false, internalOnly:true });
});

test('invalid commercial environment values cannot change backend invariants', () => {
  const config = loadConsultationConfig({
    CONSULTATION_ENABLED:'yes', CONSULTATION_INTERNAL_ONLY:'no',
    CONSULTATION_PRICE_MINOR:'1', CONSULTATION_CURRENCY:'USD',
    CONSULTATION_DURATION_MINUTES:'60', CONSULTATION_MAX_MESSAGE_CHARS:'99999',
    CONSULTATION_POLL_SECONDS:'0',
  });
  assert.equal(config.enabled, false);
  assert.equal(config.internalOnly, true);
  assert.equal(config.priceMinor, 10000);
  assert.equal(config.currency, 'THB');
  assert.equal(config.durationMinutes, 1440);
  assert.equal(config.maxMessageChars, 4000);
  assert.equal(config.pollSeconds, 5);
});

test('internal-only mode uses a server-side LINE user allowlist and fails closed when empty', () => {
  const empty = loadConsultationConfig({ CONSULTATION_ENABLED:'true', CONSULTATION_INTERNAL_ONLY:'true' });
  assert.equal(isInternalConsultationUser('U-1', empty), false);
  const allowed = loadConsultationConfig({
    CONSULTATION_ENABLED:'true', CONSULTATION_INTERNAL_ONLY:'true',
    CONSULTATION_INTERNAL_LINE_USER_IDS:' U-1,U-2,U-1 ',
  });
  assert.equal(isInternalConsultationUser('U-1', allowed), true);
  assert.equal(isInternalConsultationUser('U-3', allowed), false);
  assert.deepEqual(allowed.internalLineUserIds, ['U-1','U-2']);
});

test('waiting_on semantics and transitions are centralized', () => {
  assert.equal(WAITING_ON_SEMANTICS.pharmacist, 'next_expected_action_from_pharmacist');
  assert.deepEqual(messageWorkflowTransition('active', 'customer'), { state:'active', waitingOn:'pharmacist', reopened:false });
  assert.deepEqual(messageWorkflowTransition('active', 'pharmacist'), { state:'active', waitingOn:'customer', reopened:false });
  assert.deepEqual(messageWorkflowTransition('resolved', 'customer'), { state:'active', waitingOn:'pharmacist', reopened:true });
  assert.deepEqual(messageWorkflowTransition('resolved', 'pharmacist'), { state:'active', waitingOn:'customer', reopened:true });
  assert.doesNotThrow(() => assertWaitingOnInvariant('resolved', 'none'));
  assert.doesNotThrow(() => assertWaitingOnInvariant('closed', 'none'));
  assert.throws(() => assertWaitingOnInvariant('resolved', 'customer'), (error) => error.code === 'INVALID_WAITING_ON_STATE');
});

test('Thai emergency patterns block consultation progression deterministically', () => {
  for (const question of [
    'คุณพ่อแน่นหน้าอกรุนแรงและหายใจไม่ออก',
    'คุณแม่หมดสติ ปลุกไม่ตื่น',
    'เลือดออกมากไม่หยุด',
    'ตอนนี้คิดจะทำร้ายตัวเอง',
  ]) {
    const result = classifyConsultationSafety(question);
    assert.equal(result.action, 'emergency_block');
    assert.equal(result.reasonCode, 'POSSIBLE_EMERGENCY');
  }
});

test('English emergency regression patterns block before consultation', () => {
  for (const question of ['Severe chest pain and sweating', "I can't breathe", 'Patient is unconscious']) {
    assert.equal(classifyConsultationSafety(question).action, 'emergency_block');
  }
});

test('non-emergency medication advice is eligible for human pharmacist consultation', () => {
  assert.equal(classifyConsultationSafety('กินยาสองตัวนี้ด้วยกันได้ไหม').action, 'pharmacist_consultation_eligible');
  assert.equal(classifyConsultationSafety('Can I take these two medications together?').action, 'pharmacist_consultation_eligible');
});

test('emergency safety gate prevents order creation before authorization or paywall progression', async () => {
  let authorizationCalls=0; let insertCalls=0;
  const service=createConsultationOrderService({
    authorize:async()=>{authorizationCalls+=1;},
    repository:{async createOrder(){insertCalls+=1;return {}; }},
    transaction:async(key,fn)=>fn(),
  });
  await assert.rejects(
    () => service.createDraft({lineUserId:'U-1',careProfileId:'CP-1',initialQuestion:'คุณแม่หมดสติ ปลุกไม่ตื่น',termsAccepted:true,termsVersion:'v1'}),
    (error)=>error.code==='EMERGENCY_BLOCKED'
  );
  assert.equal(authorizationCalls,0);
  assert.equal(insertCalls,0);
});

test('diagnosis/treatment and ambiguous requests do not silently enter pharmacist checkout', () => {
  assert.equal(classifyConsultationSafety('อาการนี้เป็นโรคอะไร').action, 'medical_escalation');
  assert.equal(classifyConsultationSafety('ช่วยตอบคำถามนี้หน่อย').action, 'medical_escalation');
});

test('disabled consultation eligibility returns unavailable without authorization', async () => {
  let calls = 0;
  const service = createConsultationEligibilityService({ authorize:async () => { calls += 1; } });
  const result = await service.checkEligibility({ lineUserId:'U-1', careProfileId:'CP-1', config:{...ENABLED, enabled:false} });
  assert.equal(result.availability, 'unavailable');
  assert.equal(result.reasonCode, 'CONSULTATION_DISABLED');
  assert.equal(calls, 0);
});

test('Family owner and active caregiver with view are eligible with no profile context leakage', async () => {
  await db.CareProfiles.insert({ care_profile_id:'CP-1', owner_line_id:'U-OWNER', patient_name:'คุณแม่', status:'independent', phone:'0811111111' });
  await db.CareProfileMembers.insert({ member_id:'M-1', care_profile_id:'CP-1', line_user_id:'U-CARE', status:'active', role:'caregiver', permissions:['view'] });
  const service = createConsultationEligibilityService();
  for (const lineUserId of ['U-OWNER','U-CARE']) {
    const result = await service.checkEligibility({ lineUserId, careProfileId:'CP-1', config:ENABLED });
    assert.equal(result.availability, 'eligible');
    assert.deepEqual(result.price, {amountMinor:10000,currency:'THB'});
    assert.equal(result.durationHours, 24);
    assert.equal(result.termsVersion, 'consult-v1');
    assert.equal(JSON.stringify(result).includes('0811111111'), false);
    assert.equal(JSON.stringify(result).includes('คุณแม่'), false);
  }
});

test('revoked caregiver and unavailable Care Profile receive safe denial', async () => {
  await db.CareProfiles.insert({ care_profile_id:'CP-1', owner_line_id:'U-OWNER', patient_name:'คุณแม่', status:'independent' });
  await db.CareProfileMembers.insert({ member_id:'M-1', care_profile_id:'CP-1', line_user_id:'U-REVOKED', status:'revoked', role:'caregiver', permissions:['view'] });
  const service = createConsultationEligibilityService();
  for (const [lineUserId, careProfileId] of [['U-REVOKED','CP-1'],['U-X','CP-NOPE']]) {
    const result = await service.checkEligibility({ lineUserId, careProfileId, config:ENABLED });
    assert.deepEqual(result, { availability:'denied', reasonCode:'ACCESS_DENIED' });
  }
});
