const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { AI_ERROR_CODES, AIProviderError } = require('../backend/providers/aiErrors');
const {
  DOCTOR_QUESTION_INSTRUCTIONS, validateDoctorQuestions,
} = require('../backend/providers/doctorQuestionAI');
const {
  createDoctorQuestionService, assertGroundedNumbers, assertContextGroundedClaims,
} = require('../backend/services/doctorQuestionService');

const NOW = new Date('2026-08-26T00:00:00.000Z');
const validAI = () => ({
  title: 'คำถามที่อยากถามคุณหมอ',
  summary: 'เตรียมคำถามจากข้อมูลที่ยืนยันไว้',
  questions: [
    { id: 'provider-id', category: 'medication', question: 'ควรยืนยันวิธีใช้ Metformin อย่างไร?', rationale: 'วิธีใช้ยาที่บันทึกไว้ยังไม่ครบ' },
    { id: 'provider-id-2', category: 'lab', question: 'ผล HbA1c ที่เพิ่มขึ้นควรติดตามอย่างไร?', rationale: 'มีแนวโน้มที่เปรียบเทียบได้จากผลยืนยันแล้ว' },
  ],
  missingInformation: [],
  safetyNotice: 'แพทย์เป็นผู้ประเมินและตัดสินใจเรื่องการรักษา',
});

function context() {
  return {
    context: {
      contextType: 'doctor_question_preparation',
      conditions: [{ value: 'เบาหวาน', source: 'care_profile' }],
      allergies: [],
      currentMedications: [{ name: 'Metformin', instruction: '', source: 'medication_snapshot' }],
      medicationChanges: [],
      confirmedLabs: [{ analyteNameSource: 'HbA1c', sourceValueText: '7.2', source: 'confirmed_lab' }],
      safeLabTrends: [{ analyteNameSource: 'HbA1c', direction: 'increased', source: 'deterministic_lab_trend' }],
      appointment: null,
      missingInformation: [{ code: 'MEDICATION_INSTRUCTION_MISSING', label: 'ยาบางรายการยังไม่มีวิธีใช้ที่บันทึกไว้' }],
    },
    contextTimestamp: NOW.toISOString(),
  };
}

function harness(overrides = {}) {
  const calls = { entitlement: [], provider: [], audit: [], context: [] };
  const provider = overrides.provider || {
    async generateStructured(input) { calls.provider.push(input); return validAI(); },
  };
  const service = createDoctorQuestionService({
    config: { ai: { provider: 'fake', explanationModel: 'fake-model', timeoutMs: 1000 } },
    flags: { plus: { enabled: true, aiExplanation: true, internalEntitlementOnly: true } },
    authorizeCareProfileAccess: overrides.authorize || (async () => ({ principalType: 'family_owner' })),
    requirePlusFeature: overrides.entitlement || (async (input) => { calls.entitlement.push(input); return { allowed: true }; }),
    buildContext: overrides.buildContext || (async (input) => { calls.context.push(input); return context(); }),
    provider,
    recordAudit: overrides.recordAudit || (async (metadata) => { calls.audit.push(metadata); return { recorded: true }; }),
  });
  return { service, calls };
}

test('authorized owner receives structured neutral questions and ai_explanation entitlement is reused', async () => {
  const { service, calls } = harness();
  const result = await service({ careProfileId: 'CP-1', lineUserId: 'U-OWNER', now: NOW });
  assert.equal(result.status, 'questions');
  assert.deepEqual(result.questions.map((item) => item.id), ['Q1', 'Q2']);
  assert.equal(calls.entitlement[0].feature, 'ai_explanation');
  assert.equal(result.missingInformation[0].code, 'MEDICATION_INSTRUCTION_MISSING');
  assert.match(result.disclaimer, /ไม่ใช่การวินิจฉัย/);
});

test('authorized caregiver and center actor are supported while pharmacist principal is denied', async () => {
  for (const principalType of ['family_caregiver', 'center_staff']) {
    const { service, calls } = harness({ authorize: async () => ({ principalType }) });
    assert.equal((await service({ careProfileId: 'CP-1', lineUserId: 'U-1', now: NOW })).status, 'questions');
    assert.equal(calls.audit[0].requesterType, principalType === 'center_staff' ? null : 'family');
    assert.equal(calls.audit[0].intent, principalType === 'center_staff'
      ? 'prepare_questions_center_staff' : 'prepare_questions_family');
  }
  const { service } = harness({ authorize: async () => ({ principalType: 'pharmacist' }) });
  await assert.rejects(service({ careProfileId: 'CP-1', lineUserId: 'P-1', now: NOW }), (error) => error.code === 'ACCESS_DENIED');
});

test('revoked and cross-profile authorization failures occur before context or AI', async () => {
  for (const code of ['MEMBERSHIP_REVOKED', 'ACCESS_DENIED']) {
    const { service, calls } = harness({ authorize: async () => { const error = new Error(code); error.code = code; throw error; } });
    await assert.rejects(service({ careProfileId: 'CP-1', lineUserId: 'U-1', now: NOW }), (error) => error.code === code);
    assert.equal(calls.provider.length, 0);
    assert.equal(calls.context.length, 0);
  }
});

test('missing Plus entitlement blocks generation without adding subscription logic', async () => {
  const { service, calls } = harness({ entitlement: async () => { const error = new Error('Plus required'); error.code = 'NO_PLUS_ENTITLEMENT'; error.status = 403; throw error; } });
  await assert.rejects(service({ careProfileId: 'CP-1', lineUserId: 'U-1', now: NOW }), (error) => error.code === 'NO_PLUS_ENTITLEMENT');
  assert.equal(calls.provider.length, 0);
  assert.equal(calls.context.length, 0);
});

test('AI receives only minimized context and user focus without raw protected payloads', async () => {
  const { service, calls } = harness();
  await service({ careProfileId: 'CP-1', lineUserId: 'U-OWNER', focus: 'อยากถามเรื่องยา', now: NOW });
  const request = calls.provider[0];
  assert.equal(request.task, 'doctor_question_preparation');
  assert.equal(request.input.text, 'อยากถามเรื่องยา');
  for (const forbidden of ['LINE', 'phone', 'Base64', 'pending_card', 'raw_document', 'emergency_contact']) {
    assert.equal(request.context.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});

test('emergency focus reuses approved deterministic safety and never returns a normal list', async () => {
  const { service, calls } = harness();
  const result = await service({
    careProfileId: 'CP-1', lineUserId: 'U-OWNER', focus: 'หายใจไม่ออก', now: NOW,
  });
  assert.equal(result.status, 'escalation');
  assert.equal(result.reasonCode, 'POSSIBLE_EMERGENCY');
  assert.equal(calls.provider.length, 0);
  assert.equal(calls.context.length, 0);
  assert.equal(calls.entitlement.length, 0);
});

test('provider unavailable and malformed output return a safe unavailable state', async () => {
  for (const provider of [
    { generateStructured: async () => { throw new AIProviderError(AI_ERROR_CODES.AI_TIMEOUT, 'secret timeout'); } },
    { generateStructured: async () => ({ ...validAI(), questions: [] }) },
  ]) {
    const result = await harness({ provider }).service({ careProfileId: 'CP-1', lineUserId: 'U-1', now: NOW });
    assert.equal(result.status, 'unavailable');
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('structured validator rejects diagnosis medication advice invented range and excessive lists', () => {
  const unsafe = [
    { ...validAI(), summary: 'แสดงว่าคุณเป็นโรคไต' },
    { ...validAI(), questions: [{ id: 'x', category: 'medication', question: 'ถามเรื่องยา', rationale: 'ควรหยุดยาทันที' }] },
    { ...validAI(), questions: [{ id: 'x', category: 'lab', question: 'ถามเรื่องผล', rationale: 'ค่าปกติคือ 5' }] },
    { ...validAI(), questions: Array.from({ length: 9 }, (_, index) => ({ id: String(index), category: 'clarification', question: 'ควรถามอะไร?', rationale: 'ข้อมูลยังไม่ครบ' })) },
  ];
  for (const output of unsafe) assert.throws(() => validateDoctorQuestions(output), /Invalid|Unsafe/);
});

test('structured validator accepts neutral questions and prevents AI-created missing facts', () => {
  const result = validateDoctorQuestions(validAI());
  assert.equal(result.questions.length, 2);
  assert.deepEqual(result.missingInformation, []);
  assert.throws(() => validateDoctorQuestions({ ...validAI(), missingInformation: ['เดาเอง'] }), /invent/);
});

test('invented numeric range or follow-up interval not grounded in context is rejected', () => {
  const result = validateDoctorQuestions({
    ...validAI(), questions: [{
      id: 'x', category: 'lab', question: 'ควรตรวจซ้ำใน 3 เดือนหรือไม่?', rationale: 'ต้องติดตามผล',
    }],
  });
  assert.throws(() => assertGroundedNumbers(result, 'HbA1c 7.2'), /Ungrounded/);
  assert.doesNotThrow(() => assertGroundedNumbers(result, 'นัดหมายระบุ 3 เดือน'));
});

test('service does not treat unrelated ISO date digits as grounding for invented follow-up timing', async () => {
  const output = {
    ...validAI(), questions: [{
      id: 'x', category: 'follow_up', question: 'ควรตรวจซ้ำใน 3 เดือนหรือไม่?', rationale: 'เพื่อวางแผนติดตาม',
    }],
  };
  const { service } = harness({ provider: { generateStructured: async () => output } });
  const result = await service({ careProfileId: 'CP-1', lineUserId: 'U-1', now: NOW });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, AI_ERROR_CODES.AI_INVALID_RESPONSE);
});

test('AI cannot claim a rejected trend source flag or medication change absent from deterministic context', () => {
  const noClaimsContext = { confirmedLabs: [], safeLabTrends: [], medicationChanges: [] };
  for (const mutation of [
    { summary: 'ผล Lab เพิ่มขึ้นจากครั้งก่อน' },
    { summary: 'ผลนี้ผิดปกติ' },
    { summary: 'ข้อมูลแสดงว่ามีการปรับขนาดยา' },
  ]) {
    const result = validateDoctorQuestions({ ...validAI(), ...mutation, questions: [{
      id: 'x', category: 'clarification', question: 'ควรสอบถามข้อมูลใดเพิ่มเติม?', rationale: 'ข้อมูลที่บันทึกไว้ยังไม่ครบ',
    }] });
    assert.throws(() => assertContextGroundedClaims(result, noClaimsContext), /Ungrounded/);
  }
  const neutral = validateDoctorQuestions({ ...validAI(), questions: [{
    id: 'x', category: 'lab', question: 'ผลนี้เปลี่ยนจากครั้งก่อนหรือไม่?', rationale: 'ยังเปรียบเทียบแนวโน้มอย่างปลอดภัยไม่ได้',
  }] });
  assert.doesNotThrow(() => assertContextGroundedClaims(neutral, noClaimsContext));
});

test('prompt explicitly prohibits diagnosis treatment medication changes and invented Lab facts', () => {
  assert.match(DOCTOR_QUESTION_INSTRUCTIONS, /Do not diagnose/i);
  assert.match(DOCTOR_QUESTION_INSTRUCTIONS, /started, stopped, changed or dose-adjusted/i);
  assert.match(DOCTOR_QUESTION_INSTRUCTIONS, /Do not invent.*ranges.*thresholds/i);
  assert.match(DOCTOR_QUESTION_INSTRUCTIONS, /safeLabTrends/);
});

test('AI audit is metadata-only and excludes LINE ID clinical context focus and generated questions', async () => {
  const { service, calls } = harness();
  await service({ careProfileId: 'CP-1', lineUserId: 'U-SECRET', focus: 'อยากถามเรื่อง Metformin', now: NOW });
  const serialized = JSON.stringify(calls.audit);
  assert.equal(calls.audit[0].purpose, 'doctor_question_preparation');
  assert.equal(calls.audit[0].requesterLineId, null);
  for (const forbidden of ['U-SECRET', 'Metformin', 'HbA1c', 'คำถามที่อยากถามคุณหมอ']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(typeof calls.audit[0].inputCharacterCount, 'number');
  assert.equal(typeof calls.audit[0].outputCharacterCount, 'number');
});

test('implementation is ephemeral and has no persistence or clinical write imports', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'services', 'doctorQuestionService.js'), 'utf8');
  assert.doesNotMatch(source, /INSERT\s+INTO|UPDATE\s+|localStorage|sessionStorage/i);
  assert.doesNotMatch(source, /careProfileHealthHistoryService|updateCareProfile|confirmDraft|medicationWrite|appointment.*(?:create|update)/i);
});
