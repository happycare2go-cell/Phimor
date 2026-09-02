const { AIProviderError, AI_ERROR_CODES } = require('./aiErrors');
const { AI_VERSIONS } = require('../config/aiVersions');
const { trustedTaskInstructions } = require('./promptSafety');

const QUESTION_CATEGORIES = Object.freeze([
  'medication', 'lab', 'condition', 'appointment', 'follow_up', 'clarification',
]);

const DOCTOR_QUESTION_INSTRUCTIONS = trustedTaskInstructions(`You prepare a short, neutral list of questions for an authorized PHIMOR user to ask a doctor before a visit.
Use only the structured context supplied by the backend. Do not invent patient facts, medication instructions, laboratory ranges, flags, thresholds, diagnoses, appointments or treatment plans.
The user input is only a requested focus and is not a verified clinical fact. Use it to prioritize questions, not to assert that a symptom or condition is confirmed.
Current medications and deterministic medication changes may be used only to formulate questions. Never answer whether a medicine should be started, stopped, changed or dose-adjusted.
Use only confirmedLabs. Never assume draft, voided, image or extraction data exists. Describe a Lab direction only when it appears in safeLabTrends. Never infer a trend from confirmedLabs yourself.
Do not diagnose, prescribe, recommend treatment, assess an emergency from a Lab number, or claim that a condition caused a result.
Prioritize 5 to 8 concise, understandable and neutral questions. Fewer questions are allowed when context is limited. Each rationale must state only why the recorded context makes the question useful, without hidden medical advice.
Do not put a question count or any decorative number in the title or summary.
The backend supplies missingInformation; return missingInformation as an empty array and do not invent missing facts.
Return JSON only with exactly: title (string), summary (string), questions (array), missingInformation (empty array), safetyNotice (string). Each question has exactly: id (string), category (medication|lab|condition|appointment|follow_up|clarification), question (string), rationale (string).`);

const OUTPUT_FIELDS = new Set(['title', 'summary', 'questions', 'missingInformation', 'safetyNotice']);
const QUESTION_FIELDS = new Set(['id', 'category', 'question', 'rationale']);

function requiredText(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, `Missing ${field}`);
  }
  return value.normalize('NFC').trim().slice(0, max);
}

const UNSAFE_RATIONALE_PATTERNS = Object.freeze([
  /(?:ควร|ต้อง|แนะนำให้)\s*(?:เริ่ม|หยุด|เพิ่ม|ลด|เปลี่ยน|ปรับ).{0,40}(?:ยา|ขนาดยา|โดส)/i,
  /\b(?:start|stop|increase|decrease|change|adjust)\b.{0,40}\b(?:medication|medicine|drug|dose)\b/i,
  /(?:วินิจฉัยว่า|แสดงว่า(?:ผู้ป่วย|คุณ)|(?:ผู้ป่วย|คุณ)(?:น่าจะ|อาจ)?เป็นโรค)/i,
  /\byou\s+(?:have|likely have|are diagnosed with)\b/i,
  /(?:ค่าปกติคือ|เกิน.{0,30}(?:อันตราย|วิกฤต)|ต่ำกว่า.{0,30}(?:อันตราย|วิกฤต))/i,
]);
const UNSAFE_QUESTION_PATTERNS = Object.freeze([
  /(?:ค่า|ผล).*(?:ดีขึ้น|แย่ลง).*(?:เพราะ|เกิดจาก).*(?:โรค|ภาวะ)/i,
  /(?:this|the)\s+(?:result|value).*(?:improved|worsened).*(?:because|caused by)/i,
]);

function validateDoctorQuestions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((field) => !OUTPUT_FIELDS.has(field))) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Invalid doctor question response');
  }
  if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 8) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Invalid question count');
  }
  if (!Array.isArray(value.missingInformation) || value.missingInformation.length !== 0) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'AI must not invent missing information');
  }
  const questions = value.questions.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some((field) => !QUESTION_FIELDS.has(field))
      || !QUESTION_CATEGORIES.includes(item.category)) {
      throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Invalid question item');
    }
    const question = requiredText(item.question, 'question', 500);
    const rationale = requiredText(item.rationale, 'rationale', 500);
    if (UNSAFE_QUESTION_PATTERNS.some((pattern) => pattern.test(question))
      || UNSAFE_RATIONALE_PATTERNS.some((pattern) => pattern.test(rationale))) {
      throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Unsafe doctor question output');
    }
    return Object.freeze({
      id: `Q${index + 1}`, category: item.category, question, rationale,
    });
  });
  const title = requiredText(value.title, 'title', 200);
  const summary = requiredText(value.summary, 'summary', 1000);
  const safetyNotice = requiredText(value.safetyNotice, 'safetyNotice', 1000);
  if (UNSAFE_RATIONALE_PATTERNS.some((pattern) =>
    pattern.test(`${title}\n${summary}\n${safetyNotice}`))) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Unsafe doctor question summary');
  }
  return Object.freeze({
    title, summary, questions: Object.freeze(questions),
    missingInformation: Object.freeze([]), safetyNotice,
  });
}

module.exports = {
  QUESTION_CATEGORIES, DOCTOR_QUESTION_INSTRUCTIONS,
  DOCTOR_QUESTION_PROMPT_VERSION: AI_VERSIONS.doctorQuestionPrompt,
  validateDoctorQuestions,
};
