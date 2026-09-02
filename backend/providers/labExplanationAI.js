const { AIProviderError, AI_ERROR_CODES } = require('./aiErrors');
const { AI_VERSIONS } = require('../config/aiVersions');
const { trustedTaskInstructions } = require('./promptSafety');

const LAB_EXPLANATION_INSTRUCTIONS = trustedTaskInstructions(`You assist an authorized PHIMOR Family user by explaining confirmed laboratory information.
Use only the structured confirmed facts supplied by the backend. Draft, voided, raw-document and Pending Card data are never valid context.
Explain generally what the named test measures and restate source-confirmed values in understandable language.
Only describe a longitudinal direction when deterministicTrend.status is "available". Never override a non-comparable reason.
Reference ranges and abnormal flags are source-specific. Never invent or normalize a range, abnormal flag, critical threshold, unit, specimen, method, LOINC code or diagnosis.
Do not call a change improved, worsened, healthy, dangerous, normal or abnormal unless the source explicitly provides that exact flag. Never infer an emergency from a number.
Do not diagnose, prescribe treatment, or recommend starting, stopping, changing or adjusting medication or dose.
If sourceRangesDiffer is true, clearly state that the source ranges differ and cannot be treated as one normalized range.
You may propose neutral questions for a healthcare professional. A human healthcare professional remains responsible for interpretation and care decisions.
The backend will insert confirmedFacts itself; return confirmedFacts as an empty array and do not recreate patient facts.
Return JSON only with exactly these fields:
summary (string), testExplanation (string), confirmedFacts (empty array), trendExplanation (string or null), rangeCaveat (string or null), questionsForClinician (string array), safetyNotice (string), disclaimer (string), unavailableReason (string or null).`);

const OUTPUT_FIELDS = new Set([
  'summary', 'testExplanation', 'confirmedFacts', 'trendExplanation', 'rangeCaveat',
  'questionsForClinician', 'safetyNotice', 'disclaimer', 'unavailableReason',
]);

function requiredText(value, field, max = 4000) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, `Missing ${field}`);
  }
  return value.normalize('NFC').trim().slice(0, max);
}

function nullableText(value, field, max = 4000) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, `Invalid ${field}`);
  }
  return value.normalize('NFC').trim().slice(0, max) || null;
}

function stringArray(value, field) {
  if (!Array.isArray(value) || value.length > 20 || value.some((item) => typeof item !== 'string')) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, `Invalid ${field}`);
  }
  return Object.freeze(value.map((item) => item.normalize('NFC').trim().slice(0, 500)).filter(Boolean));
}

const UNSAFE_GENERATED_PATTERNS = Object.freeze([
  /(?:วินิจฉัยว่า|แสดงว่า(?:คุณ|ผู้ป่วย)|(?:คุณ|ผู้ป่วย)(?:น่าจะ|อาจ)?เป็นโรค)/i,
  /(?:ควร|ต้อง|แนะนำให้)\s*(?:เริ่ม|หยุด|เพิ่ม|ลด|เปลี่ยน|ปรับ).{0,40}(?:ยา|ขนาดยา|โดส)/i,
  /\byou\s+(?:have|likely have|are diagnosed with)\b/i,
  /\b(?:start|stop|increase|decrease|change|adjust)\b.{0,40}\b(?:medication|medicine|drug|dose)\b/i,
  /(?:ดีขึ้น|แย่ลง|\bimproved\b|\bworsened\b)/i,
]);

function assertSafeGeneratedLanguage(result) {
  const generated = [
    result.summary, result.testExplanation, result.trendExplanation,
    result.rangeCaveat, result.safetyNotice,
  ].filter(Boolean).join('\n');
  if (UNSAFE_GENERATED_PATTERNS.some((pattern) => pattern.test(generated))) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Unsafe Lab explanation content');
  }
  return result;
}

function validateLabExplanation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Invalid Lab explanation response');
  }
  if (Object.keys(value).some((field) => !OUTPUT_FIELDS.has(field))) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Unsupported Lab explanation field');
  }
  if (!Array.isArray(value.confirmedFacts) || value.confirmedFacts.length !== 0) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'AI must not create confirmed facts');
  }
  return Object.freeze(assertSafeGeneratedLanguage({
    summary: requiredText(value.summary, 'summary'),
    testExplanation: requiredText(value.testExplanation, 'testExplanation'),
    confirmedFacts: Object.freeze([]),
    trendExplanation: nullableText(value.trendExplanation, 'trendExplanation'),
    rangeCaveat: nullableText(value.rangeCaveat, 'rangeCaveat', 2000),
    questionsForClinician: stringArray(value.questionsForClinician, 'questionsForClinician'),
    safetyNotice: requiredText(value.safetyNotice, 'safetyNotice', 2000),
    disclaimer: requiredText(value.disclaimer, 'disclaimer', 2000),
    unavailableReason: nullableText(value.unavailableReason, 'unavailableReason', 160),
  }));
}

module.exports = {
  LAB_EXPLANATION_INSTRUCTIONS,
  LAB_EXPLANATION_PROMPT_VERSION: AI_VERSIONS.labExplanationPrompt,
  validateLabExplanation, assertSafeGeneratedLanguage,
};
