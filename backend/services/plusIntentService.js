const { AI_ERROR_CODES } = require('../providers/aiErrors');
const { AI_VERSIONS } = require('../config/aiVersions');
const { trustedTaskInstructions } = require('../providers/promptSafety');

const ALLOWED_INTENTS = Object.freeze(['retrieve', 'summarize', 'compare', 'explain', 'prepare']);
const ESCALATION_INTENTS = Object.freeze([
  'medication_advice', 'diagnosis', 'treatment', 'dose_change', 'stop_start_medication',
]);
const ALL_INTENTS = new Set([...ALLOWED_INTENTS, ...ESCALATION_INTENTS]);
const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.8;
const MAX_INTENT_TEXT_LENGTH = 4000;

const INTENT_CLASSIFIER_INSTRUCTIONS = trustedTaskInstructions(`Classify the user's intent only. Do not answer the question.
Return JSON with intent, confidence, requiresEscalation, and reasonCode.
Allowed intents: retrieve, summarize, compare, explain, prepare.
Escalation intents: medication_advice, diagnosis, treatment, dose_change, stop_start_medication.
When uncertain about diagnosis, treatment, dose, starting/stopping medication, suitability, or interactions, set requiresEscalation true.`);

const RULES = Object.freeze([
  { intent: 'stop_start_medication', patterns: [/หยุด\s*ยา/i, /เริ่ม\s*(กิน|ใช้)?\s*ยา/i, /(ควร|ต้อง|สามารถ).*(หยุด|เริ่ม).*(ยา)/i] },
  { intent: 'dose_change', patterns: [/(เพิ่ม|ลด|ปรับ|เปลี่ยน).*(ขนาดยา|ขนาด|โดส|dose|เม็ด|วิธีใช้|วิธีกิน)/i, /(เพิ่ม|ลด).*(เป็น|เหลือ)?\s*\d+\s*เม็ด/i] },
  { intent: 'medication_advice', patterns: [/(ยา|กิน|ใช้).*(สองตัว|ร่วมกัน|ด้วยกัน).*(ได้ไหม|ปลอดภัยไหม)/i, /ยานี้.*(เหมาะ|ปลอดภัย).*(ไหม|หรือไม่)/i, /ยานี้.*(ใช้)?\s*รักษาอะไร/i, /เปลี่ยน\s*ยา.*(ได้ไหม|หรือไม่)/i, /ควร.*ใช้ยา.*ไหม/i] },
  { intent: 'diagnosis', patterns: [/อาการ.*(เป็น|คือ).*โรคอะไร/i, /(เป็น|น่าจะเป็น)\s*โรคอะไร/i, /ช่วย.*วินิจฉัย/i] },
  { intent: 'treatment', patterns: [/(ควร|ต้อง).*(รักษา|รักษายังไง|รักษาอย่างไร)/i, /(อาการ|โรค).*(รักษายังไง|รักษาอย่างไร)/i] },
  { intent: 'prepare', patterns: [/เตรียม.*(ก่อน|ไป).*(พบ|หาหมอ|แพทย์)/i, /เตรียม.*คำถาม.*(หมอ|แพทย์)/i] },
  { intent: 'compare', patterns: [/(ยา|รายการยา).*(เปลี่ยน|ต่าง|แตกต่าง).*อะไร/i, /(เปรียบเทียบ|เทียบ).*(ยา|snapshot|รายการ)/i, /รอบล่าสุด.*ยา.*เปลี่ยน/i, /รอบล่าสุด.*เปลี่ยน.*ยา/i] },
  { intent: 'summarize', patterns: [/(ช่วย)?\s*สรุป.*(ข้อมูลสุขภาพ|ข้อมูล.+|care profile|ประวัติ)/i, /ภาพรวม.*สุขภาพ/i] },
  { intent: 'retrieve', patterns: [/(ตอนนี้|ปัจจุบัน).*(มี|ใช้|กิน).*ยา.*(อะไร|บ้าง)/i, /ยา.*ที่บันทึก.*(กิน|ใช้).*(ตอนไหน|อย่างไร|ยังไง)/i, /(ดู|ขอ|บอก).*(รายการยา|ยาปัจจุบัน|วิธีใช้ที่บันทึก)/i, /(มี|ดู|ขอ|บอก).*(นัด|นัดหมาย).*(อะไร|ต่อไป|บ้าง)/i] },
  { intent: 'explain', patterns: [/อธิบาย.*(ข้อมูล|ผล|ข้อความ).*ที่บันทึก/i] },
]);

function deterministicClassification(text) {
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      const requiresEscalation = ESCALATION_INTENTS.includes(rule.intent);
      return { intent: rule.intent, confidence: 1, requiresEscalation, reasonCode: requiresEscalation ? escalationReason(rule.intent) : null, source: 'deterministic' };
    }
  }
  return null;
}

function escalationReason(intent) {
  if (intent === 'medication_advice') return 'MEDICATION_ADVICE_REQUIRES_PROFESSIONAL';
  if (['dose_change', 'stop_start_medication'].includes(intent)) return 'MEDICATION_CHANGE_REQUIRES_PROFESSIONAL';
  if (intent === 'diagnosis') return 'DIAGNOSIS_REQUIRES_MEDICAL_PROFESSIONAL';
  return 'TREATMENT_REQUIRES_MEDICAL_PROFESSIONAL';
}

function validateClassifierResult(value) {
  if (!value || typeof value !== 'object' || !ALL_INTENTS.has(value.intent)) return null;
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return null;
  return {
    intent: value.intent,
    confidence: value.confidence,
    requiresEscalation: Boolean(value.requiresEscalation) || ESCALATION_INTENTS.includes(value.intent),
    reasonCode: typeof value.reasonCode === 'string' ? value.reasonCode : null,
    source: 'classifier',
  };
}

function createStructuredIntentClassifier({ provider }) {
  return {
    async classify({ text, contextHint = null }) {
      return provider.generateStructured({
        task: 'plus_intent_classification',
        systemInstructions: INTENT_CLASSIFIER_INSTRUCTIONS,
        context: contextHint ? `Context category: ${String(contextHint).slice(0, 80)}` : null,
        input: { text },
        outputSchema: (value) => {
          const validated = validateClassifierResult(value);
          if (!validated) {
            const error = new Error('Invalid intent classifier response');
            error.code = AI_ERROR_CODES.AI_INVALID_RESPONSE;
            throw error;
          }
          return validated;
        },
      });
    },
  };
}

async function classifyPlusIntent({ text, contextHint = null, classifier = null }) {
  const normalized = typeof text === 'string' ? text.trim() : '';
  if (!normalized) return { intent: null, confidence: 0, requiresEscalation: true, reasonCode: 'INVALID_INPUT', source: 'policy' };
  if (normalized.length > MAX_INTENT_TEXT_LENGTH) return { intent: null, confidence: 0, requiresEscalation: true, reasonCode: 'INPUT_TOO_LONG', source: 'policy' };
  const deterministic = deterministicClassification(normalized);
  if (deterministic) return deterministic;
  if (!classifier || typeof classifier.classify !== 'function') {
    return { intent: null, confidence: 0, requiresEscalation: true, reasonCode: 'AMBIGUOUS_INTENT_REQUIRES_REVIEW', source: 'policy' };
  }
  try {
    const result = validateClassifierResult(await classifier.classify({ text: normalized, contextHint }));
    if (!result) return { intent: null, confidence: 0, requiresEscalation: true, reasonCode: 'INVALID_CLASSIFIER_RESULT', source: 'policy' };
    if (result.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD) {
      return { ...result, requiresEscalation: true, reasonCode: 'LOW_CONFIDENCE_REQUIRES_REVIEW' };
    }
    return result;
  } catch (_) {
    return { intent: null, confidence: 0, requiresEscalation: true, reasonCode: 'CLASSIFIER_UNAVAILABLE_REQUIRES_REVIEW', source: 'policy' };
  }
}

function evaluatePlusSafety(intentResult, { pharmacistEscalationEnabled = false } = {}) {
  if (!intentResult || !ALL_INTENTS.has(intentResult.intent)) {
    return { action: 'needs_review', intent: intentResult?.intent || null, reasonCode: intentResult?.reasonCode || 'UNSUPPORTED_INTENT', message: 'ไม่สามารถดำเนินการคำขอนี้โดยอัตโนมัติได้' };
  }
  if (ALLOWED_INTENTS.includes(intentResult.intent) && intentResult.requiresEscalation) {
    return { action: 'needs_review', intent: intentResult.intent, reasonCode: intentResult.reasonCode || 'AMBIGUOUS_INTENT_REQUIRES_REVIEW', message: 'คำขอนี้ต้องได้รับการตรวจสอบก่อนดำเนินการ' };
  }
  if (ESCALATION_INTENTS.includes(intentResult.intent)) {
    const medication = ['medication_advice', 'dose_change', 'stop_start_medication'].includes(intentResult.intent);
    const pharmacistAvailable = medication && pharmacistEscalationEnabled;
    return {
      action: pharmacistAvailable ? 'pharmacist_escalation' : 'medical_escalation',
      intent: intentResult.intent,
      reasonCode: intentResult.reasonCode || escalationReason(intentResult.intent),
      message: pharmacistAvailable
        ? 'คำถามนี้ควรตรวจสอบกับเภสัชกรหรือแพทย์'
        : 'คำถามนี้ควรได้รับการประเมินจากแพทย์หรือบุคลากรทางการแพทย์',
    };
  }
  if (!ALLOWED_INTENTS.includes(intentResult.intent)) {
    return { action: 'needs_review', intent: intentResult.intent, reasonCode: 'UNSUPPORTED_INTENT', message: 'ไม่สามารถดำเนินการคำขอนี้โดยอัตโนมัติได้' };
  }
  return { action: 'allow', intent: intentResult.intent, reasonCode: null };
}

async function runPlusSafetyGate({ text, contextHint = null, classifier = null, generateAnswer, pharmacistEscalationEnabled = false }) {
  const intentResult = await classifyPlusIntent({ text, contextHint, classifier });
  const decision = evaluatePlusSafety(intentResult, { pharmacistEscalationEnabled });
  if (decision.action !== 'allow') return { ...decision, classification: intentResult };
  if (typeof generateAnswer !== 'function') return { ...decision, classification: intentResult };
  return { ...decision, classification: intentResult, result: await generateAnswer({ intent: intentResult.intent }) };
}

module.exports = {
  ALLOWED_INTENTS, ESCALATION_INTENTS, CLASSIFIER_CONFIDENCE_THRESHOLD, MAX_INTENT_TEXT_LENGTH,
  INTENT_CLASSIFIER_INSTRUCTIONS, AI_VERSIONS, deterministicClassification,
  validateClassifierResult, createStructuredIntentClassifier, classifyPlusIntent,
  evaluatePlusSafety, runPlusSafetyGate,
};
