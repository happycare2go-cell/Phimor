const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AI_VERSIONS, classifyPlusIntent, evaluatePlusSafety, runPlusSafetyGate,
  createStructuredIntentClassifier,
} = require('../backend/services/plusIntentService');

const cases = [
  ['ตอนนี้คุณแม่มียาอะไรบ้าง', 'retrieve'],
  ['ยาที่บันทึกไว้มีกินตอนไหน', 'retrieve'],
  ['ช่วยสรุปข้อมูลสุขภาพ', 'summarize'],
  ['รอบล่าสุดยาเปลี่ยนอะไร', 'compare'],
  ['ช่วยเตรียมคำถามก่อนไปพบแพทย์', 'prepare'],
  ['กินยาสองตัวนี้ด้วยกันได้ไหม', 'medication_advice'],
  ['ยานี้ใช้รักษาอะไร', 'medication_advice'],
  ['ปรับวิธีใช้ยาได้ไหม', 'dose_change'],
  ['ควรหยุดยานี้ไหม', 'stop_start_medication'],
  ['เพิ่มเป็น 2 เม็ดได้ไหม', 'dose_change'],
  ['อาการแบบนี้เป็นโรคอะไร', 'diagnosis'],
  ['ควรรักษายังไง', 'treatment'],
];

for (const [text, expected] of cases) {
  test(`deterministic intent: ${text} -> ${expected}`, async () => {
    const result = await classifyPlusIntent({ text });
    assert.equal(result.intent, expected);
    assert.equal(result.source, 'deterministic');
  });
}

test('medication escalation returns pharmacist action', async () => {
  const result = await classifyPlusIntent({ text: 'กินยาสองตัวนี้ด้วยกันได้ไหม' });
  const decision = evaluatePlusSafety(result);
  assert.equal(decision.action, 'pharmacist_escalation');
  assert.equal(decision.reasonCode, 'MEDICATION_ADVICE_REQUIRES_PROFESSIONAL');
});

test('diagnosis and treatment return medical escalation', async () => {
  for (const text of ['อาการแบบนี้เป็นโรคอะไร', 'ควรรักษายังไง']) {
    const decision = evaluatePlusSafety(await classifyPlusIntent({ text }));
    assert.equal(decision.action, 'medical_escalation');
  }
});

test('risky deterministic intent stops before generative answer provider', async () => {
  let answerCalls = 0;
  const result = await runPlusSafetyGate({
    text: 'เพิ่มเป็น 2 เม็ดได้ไหม',
    generateAnswer: async () => { answerCalls += 1; return 'must not happen'; },
  });
  assert.equal(result.action, 'pharmacist_escalation');
  assert.equal(answerCalls, 0);
});

test('allowed intent may continue to a future answer handler', async () => {
  let answerCalls = 0;
  const result = await runPlusSafetyGate({
    text: 'ช่วยสรุปข้อมูลสุขภาพ',
    generateAnswer: async ({ intent }) => { answerCalls += 1; return { intent }; },
  });
  assert.equal(result.action, 'allow');
  assert.equal(result.result.intent, 'summarize');
  assert.equal(answerCalls, 1);
});

test('ambiguous low-confidence classifier result fails safe to needs_review', async () => {
  const classifier = { async classify() { return { intent: 'retrieve', confidence: 0.55, requiresEscalation: false, reasonCode: null }; } };
  const result = await classifyPlusIntent({ text: 'อันนี้โอเคไหม', classifier });
  assert.equal(result.requiresEscalation, true);
  assert.equal(result.reasonCode, 'LOW_CONFIDENCE_REQUIRES_REVIEW');
  assert.equal(evaluatePlusSafety(result).action, 'needs_review');
});

test('unsupported or malformed classifier intent is denied safely', async () => {
  const classifier = { async classify() { return { intent: 'write_prescription', confidence: 1, requiresEscalation: false }; } };
  const result = await classifyPlusIntent({ text: 'ทำบางอย่างให้หน่อย', classifier });
  assert.equal(result.requiresEscalation, true);
  assert.equal(evaluatePlusSafety(result).action, 'needs_review');
});

test('classifier failure fails safe without exposing its error', async () => {
  const classifier = { async classify() { throw new Error('secret provider detail'); } };
  const result = await classifyPlusIntent({ text: 'คำถามที่กำกวม', classifier });
  assert.equal(result.reasonCode, 'CLASSIFIER_UNAVAILABLE_REQUIRES_REVIEW');
  assert.equal(evaluatePlusSafety(result).action, 'needs_review');
});

test('frontend flags cannot override server-side safety policy', async () => {
  const result = await classifyPlusIntent({ text: 'ควรหยุดยานี้ไหม', frontendAllowsAI: true });
  const decision = evaluatePlusSafety({ ...result, frontendAllowsAI: true });
  assert.equal(decision.action, 'pharmacist_escalation');
});

test('structured classifier uses classification-only task and versioned prompt', async () => {
  let request;
  const classifier = createStructuredIntentClassifier({
    provider: {
      async generateStructured(value) {
        request = value;
        return value.outputSchema({ intent: 'retrieve', confidence: 0.95, requiresEscalation: false, reasonCode: null });
      },
    },
  });
  const result = await classifier.classify({ text: 'ขอดูข้อมูล', contextHint: 'medication' });
  assert.equal(result.intent, 'retrieve');
  assert.equal(request.task, 'plus_intent_classification');
  assert.match(request.systemInstructions, /Do not answer the question/);
  assert.equal(AI_VERSIONS.intentClassifierPrompt, 'plus-intent-classifier-v1');
});

test('blank input is denied without invoking a classifier', async () => {
  let calls = 0;
  const result = await classifyPlusIntent({ text: '  ', classifier: { async classify() { calls += 1; } } });
  assert.equal(result.reasonCode, 'INVALID_INPUT');
  assert.equal(evaluatePlusSafety(result).action, 'needs_review');
  assert.equal(calls, 0);
});

test('oversized input is denied before invoking a classifier', async () => {
  let calls = 0;
  const result = await classifyPlusIntent({ text: 'ก'.repeat(4001), classifier: { async classify() { calls += 1; } } });
  assert.equal(result.reasonCode, 'INPUT_TOO_LONG');
  assert.equal(evaluatePlusSafety(result).action, 'needs_review');
  assert.equal(calls, 0);
});
