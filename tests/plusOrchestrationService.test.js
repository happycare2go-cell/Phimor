const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';

const db = require('../backend/db');
const { AIProviderError, AI_ERROR_CODES } = require('../backend/providers/aiErrors');
const {
  createPlusOrchestrator,
} = require('../backend/services/plusOrchestrationService');

const FLAGS = {
  plus: {
    enabled: true, internalEntitlementOnly: true, aiExplanation: true,
    medicationDiff: true, pharmacistEscalation: false,
  },
};

test.beforeEach(() => db.resetAll());

async function seed() {
  await db.CareProfiles.insert({
    care_profile_id: 'CP-1', owner_line_id: 'U-1', patient_name: 'คุณแม่', status: 'independent',
    chronic_conditions: ['เบาหวาน'], drug_allergies: 'Penicillin', family_phone: '0812345678',
    emergency_contact_phone: '0899999999', line_token: 'LINE-SECRET', raw_document: 'RAW-SECRET',
  });
  await db.MedicationSnapshots.insert({
    snapshot_id: 'S-OLD', care_profile_id: 'CP-1', recorded_at: '2026-08-01T00:00:00Z',
    items: [{ name: 'Metformin', dose: '500 mg' }], source_image_base64: 'IMAGE-SECRET', recorded_by: 'U-SECRET',
  });
  await db.MedicationSnapshots.insert({
    snapshot_id: 'S-NEW', care_profile_id: 'CP-1', recorded_at: '2026-08-20T00:00:00Z',
    items: [{ name: 'Metformin', dose: '1000 mg', instruction: 'หลังอาหาร' }, { name: 'Aspirin', dose: '81 mg' }],
    source_image_base64: 'IMAGE-SECRET-2', recorded_by: 'U-SECRET',
  });
  await db.Appointments.insert({
    appointment_id: 'A-1', care_profile_id: 'CP-1', datetime: '2099-09-01T09:00:00Z', status: 'confirmed',
    hospital: 'โรงพยาบาลกลาง', reason_for_visit: 'ติดตามอาการ', related_condition: 'เบาหวาน', created_by: 'U-SECRET',
  });
  await db.CareProfileMembers.insert({ member_id: 'MEM-SECRET', care_profile_id: 'CP-1', line_user_id: 'U-FAMILY', status: 'active', permissions: ['view'] });
}

function entitlement() {
  return { allowed: true, features: ['*'], planCode: 'family_plus', source: 'internal' };
}

function explanation() {
  return { summary: 'สรุปจากข้อมูลที่บันทึกไว้', keyPoints: ['ข้อมูลสำคัญ'], missingInformation: [], disclaimer: 'ไม่ใช่คำวินิจฉัยหรือคำสั่งรักษา' };
}

function harness({ providerError = null, response = explanation(), flags = FLAGS, auditError = false } = {}) {
  const providerCalls = [];
  const audits = [];
  const provider = {
    async generateStructured(request) {
      providerCalls.push(request);
      if (providerError) throw providerError;
      return response;
    },
  };
  const handle = createPlusOrchestrator({
    flags,
    config: { ai: { provider: 'gemini', explanationModel: 'test-explanation-model', timeoutMs: 2000 } },
    provider,
    getPlusEntitlement: async () => entitlement(),
    recordAudit: async (metadata) => {
      audits.push(metadata);
      if (auditError) throw new Error('audit should be fail-open');
      return { recorded: true };
    },
  });
  return { handle, providerCalls, audits };
}

const request = (question, extra = {}) => ({ lineUserId: 'U-1', careProfileId: 'CP-1', question, ...extra });

test('Care Profile summary uses minimized structured service context and AI explanation', async () => {
  await seed();
  const { handle, providerCalls } = harness();
  const result = await handle(request('ช่วยสรุปข้อมูลคุณแม่'));
  assert.equal(result.action, 'answer');
  assert.equal(result.purpose, 'care_profile_summary');
  assert.equal(providerCalls.length, 1);
  const context = JSON.parse(providerCalls[0].context);
  assert.equal(context.data.profile.patientName, 'คุณแม่');
  assert.equal(context.data.currentMedicationCount, 2);
});

test('current medication question uses current snapshot retrieval only', async () => {
  await seed();
  const { handle, providerCalls } = harness();
  const result = await handle(request('ตอนนี้มียาอะไรบ้าง'));
  assert.equal(result.purpose, 'medication_summary');
  const data = JSON.parse(providerCalls[0].context).data;
  assert.equal(data.currentSnapshot.snapshotId, 'S-NEW');
  assert.deepEqual(data.medications.map((item) => item.name), ['Metformin', 'Aspirin']);
});

test('medication instruction question exposes recorded instructions without rewriting', async () => {
  await seed();
  const { handle, providerCalls } = harness();
  const result = await handle(request('ยาที่บันทึกไว้กินอย่างไร'));
  assert.equal(result.purpose, 'medication_instructions');
  const instructions = JSON.parse(providerCalls[0].context).data.instructions;
  assert.equal(instructions[0].instruction, 'หลังอาหาร');
});

test('latest medication comparison uses deterministic diff as the only AI context', async () => {
  await seed();
  const { handle, providerCalls } = harness();
  const result = await handle(request('รอบล่าสุดเปลี่ยนยาอะไร'));
  assert.equal(result.purpose, 'medication_diff');
  const data = JSON.parse(providerCalls[0].context).data;
  assert.equal(data.status, 'AVAILABLE');
  assert.equal(data.diff.added.length, 1);
  assert.equal(data.diff.doseChanged.length, 1);
});

test('appointment question uses upcoming appointment summary', async () => {
  await seed();
  const { handle, providerCalls } = harness();
  const result = await handle(request('มีนัดอะไรต่อไป'));
  assert.equal(result.purpose, 'appointment_summary');
  const data = JSON.parse(providerCalls[0].context).data;
  assert.deepEqual(data.map((item) => item.appointmentId), ['A-1']);
});

test('prepare question uses deterministic doctor visit payload', async () => {
  await seed();
  const { handle, providerCalls } = harness();
  const result = await handle(request('ช่วยเตรียมคำถามก่อนไปพบแพทย์', { appointmentId: 'A-1' }));
  assert.equal(result.purpose, 'doctor_visit_preparation');
  const data = JSON.parse(providerCalls[0].context).data;
  assert.equal(data.appointment.appointmentId, 'A-1');
  assert.equal(data.questionInputs.appointmentReason, 'ติดตามอาการ');
});

for (const [question, intent, escalationType] of [
  ['กินยาสองตัวนี้ด้วยกันได้ไหม', 'medication_advice', 'pharmacist_escalation'],
  ['เพิ่มยาเป็น 2 เม็ดได้ไหม', 'dose_change', 'pharmacist_escalation'],
  ['อาการนี้เป็นโรคอะไร', 'diagnosis', 'medical_escalation'],
]) {
  test(`safety blocks ${intent} before generative explanation`, async () => {
    await seed();
    const { handle, providerCalls, audits } = harness();
    const result = await handle(request(question));
    assert.equal(result.action, 'escalation');
    assert.equal(result.escalationType, escalationType);
    assert.equal(result.intent, intent);
    assert.equal(providerCalls.length, 0);
    assert.equal(audits[0].resultStatus, 'escalated');
  });
}

test('AI context excludes identifiers, phone numbers, images, raw documents, audit and member lists', async () => {
  await seed();
  const { handle, providerCalls } = harness();
  await handle(request('ช่วยสรุปข้อมูลคุณแม่'));
  const serialized = providerCalls[0].context;
  for (const secret of ['LINE-SECRET', '0812345678', '0899999999', 'IMAGE-SECRET', 'RAW-SECRET', 'U-SECRET', 'MEM-SECRET']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(/audit|familyMembers|careProfileMembers/i.test(serialized), false);
});

for (const code of [
  AI_ERROR_CODES.AI_UNAVAILABLE, AI_ERROR_CODES.AI_TIMEOUT, AI_ERROR_CODES.AI_RATE_LIMIT,
  AI_ERROR_CODES.AI_INVALID_RESPONSE, AI_ERROR_CODES.AI_PROVIDER_ERROR,
]) {
  test(`${code} returns a safe unavailable envelope`, async () => {
    await seed();
    const { handle, audits } = harness({ providerError: new AIProviderError(code, 'private provider detail') });
    const result = await handle(request('ช่วยสรุปข้อมูลคุณแม่'));
    assert.deepEqual(result, {
      action: 'unavailable', intent: 'summarize', purpose: 'care_profile_summary',
      errorCode: code, message: 'ระบบช่วยอธิบายยังไม่พร้อม กรุณาลองใหม่ภายหลัง',
    });
    assert.equal(audits[0].errorCode, code);
  });
}

test('invalid structured AI output becomes AI_INVALID_RESPONSE', async () => {
  await seed();
  const { handle } = harness({ response: { summary: 'missing required arrays' } });
  const result = await handle(request('ช่วยสรุปข้อมูลคุณแม่'));
  assert.equal(result.action, 'unavailable');
  assert.equal(result.errorCode, 'AI_INVALID_RESPONSE');
});

test('audit contains metadata only and never stores raw question, response, or context', async () => {
  await seed();
  const { handle, audits } = harness();
  const question = 'ช่วยสรุปข้อมูลคุณแม่';
  await handle(request(question));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].purpose, 'care_profile_summary');
  assert.equal(audits[0].inputCharacterCount, question.length);
  const serialized = JSON.stringify(audits[0]);
  assert.equal(serialized.includes(question), false);
  assert.equal(serialized.includes('สรุปจากข้อมูลที่บันทึกไว้'), false);
  assert.equal(serialized.includes('Metformin'), false);
});

test('audit failure is fail-open and operational logging contains no health payload', async () => {
  await seed();
  const logs = [];
  const handle = createPlusOrchestrator({
    flags: FLAGS,
    config: { ai: { provider: 'gemini', explanationModel: 'test', timeoutMs: 2000 } },
    provider: { async generateStructured() { return explanation(); } },
    getPlusEntitlement: async () => entitlement(),
    recordAudit: async () => { throw new Error('database details and health payload'); },
    auditLogger: (entry) => logs.push(entry),
  });
  const result = await handle(request('ช่วยสรุปข้อมูลคุณแม่'));
  assert.equal(result.action, 'answer');
  assert.equal(logs.length, 1);
  const serialized = JSON.stringify(logs[0]);
  assert.equal(serialized.includes('Metformin'), false);
  assert.equal(serialized.includes('database details'), false);
});

test('successful orchestration is read-only for clinical and business records', async () => {
  await seed();
  const before = {
    profiles: await db.CareProfiles.findWhere(() => true),
    snapshots: await db.MedicationSnapshots.findWhere(() => true),
    appointments: await db.Appointments.findWhere(() => true),
    members: await db.CareProfileMembers.findWhere(() => true),
  };
  const { handle } = harness();
  await handle(request('ช่วยสรุปข้อมูลคุณแม่'));
  const after = {
    profiles: await db.CareProfiles.findWhere(() => true),
    snapshots: await db.MedicationSnapshots.findWhere(() => true),
    appointments: await db.Appointments.findWhere(() => true),
    members: await db.CareProfileMembers.findWhere(() => true),
  };
  assert.deepEqual(after, before);
});

test('PLUS_ENABLED remains server-side authoritative and stops before entitlement/provider', async () => {
  let entitlementCalls = 0;
  let providerCalls = 0;
  const handle = createPlusOrchestrator({
    flags: { plus: { ...FLAGS.plus, enabled: false } },
    getPlusEntitlement: async () => { entitlementCalls += 1; return entitlement(); },
    provider: { async generateStructured() { providerCalls += 1; return explanation(); } },
  });
  const result = await handle(request('ช่วยสรุปข้อมูลคุณแม่'));
  assert.equal(result.errorCode, 'PLUS_DISABLED');
  assert.equal(entitlementCalls, 0);
  assert.equal(providerCalls, 0);
});

test('orchestration executes entitlement, safety, authorization, domain, provider, audit in order', async () => {
  const order = [];
  const handle = createPlusOrchestrator({
    flags: FLAGS,
    config: { ai: { provider: 'gemini', explanationModel: 'test', timeoutMs: 2000 } },
    getPlusEntitlement: async () => { order.push('entitlement'); return entitlement(); },
    classifyPlusIntent: async () => { order.push('safety'); return { intent: 'summarize', confidence: 1, requiresEscalation: false }; },
    authorize: async () => { order.push('authorization'); return {}; },
    services: { buildCareProfileSummary: async () => { order.push('domain'); return { profile: {} }; } },
    provider: { async generateStructured() { order.push('provider'); return explanation(); } },
    recordAudit: async () => { order.push('audit'); return { recorded: true }; },
  });
  const result = await handle(request('ช่วยสรุปข้อมูลคุณแม่'));
  assert.equal(result.action, 'answer');
  assert.deepEqual(order, ['entitlement', 'safety', 'authorization', 'domain', 'provider', 'audit']);
});
