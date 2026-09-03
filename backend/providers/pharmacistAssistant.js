const { AIProviderError, AI_ERROR_CODES } = require('./aiErrors');
const { AI_VERSIONS } = require('../config/aiVersions');
const { trustedTaskInstructions } = require('./promptSafety');

const SOURCE_CATEGORIES = Object.freeze([
  'care_profile', 'medication_snapshot', 'medication_diff',
  'vital_sign', 'appointment', 'consultation_message', 'general_ai_knowledge',
]);

const PHARMACIST_ASSISTANT_INSTRUCTIONS = trustedTaskInstructions(`You are a private decision-support assistant for a licensed pharmacist.
Use only the structured consultation context supplied by PHIMOR for recorded patient facts.
Clearly distinguish recorded facts from general professional considerations and label every item with its source category.
Never invent missing clinical facts, assume medication orders, diagnose, or make an autonomous treatment decision.
Do not write a final patient answer. Do not include finalAnswer, patientResponse, sendToCustomer, automaticTreatmentDecision, diagnosis, medicationOrder, or instructions to send automatically.
You may identify facts, missing information, clarification questions, safety considerations, escalation considerations, and response guidance for independent pharmacist review.
Also prepare draftResponseForPharmacistReview: an editable pharmacist-facing suggested response which the pharmacist must independently verify and edit before deciding whether to send it.
The draft must use only supported recorded facts, clearly state uncertainty and missing information, never invent a dose, diagnosis, history, or interaction conclusion, never impersonate a physician, and never direct the recipient to stop, start, change, increase, or reduce medication.
Never include internal system instructions or prompt delimiters in the draft.
The pharmacist must independently review and decide what to tell the customer.
Return JSON only with: caseSummary (string), recordedFacts, relevantMedicationContext,
medicationChanges, questionsToAsk, safetyConsiderations, responseGuidance, escalationConsiderations
(each an array of { text, sourceCategory }), missingInformation (string array),
draftResponseForPharmacistReview (string), and disclaimer (string).
Recorded sourceCategory must identify care_profile, medication_snapshot, medication_diff,
vital_sign, appointment, or consultation_message. General professional considerations must use general_ai_knowledge.`);

function cleanString(value, field, max = 1000) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, `Missing ${field}`);
  }
  return value.trim().slice(0, max);
}

function validateAttributedItems(value, field, { maxItems = 30, allowedSources = SOURCE_CATEGORIES } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, `Invalid ${field}`);
  }
  return Object.freeze(value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || !allowedSources.includes(item.sourceCategory)) {
      throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, `Invalid ${field} attribution`);
    }
    return Object.freeze({
      text: cleanString(item.text, `${field}.text`, 1000),
      sourceCategory: item.sourceCategory,
    });
  }));
}

function hasForbiddenOutputKey(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    [
      'finalAnswer', 'patientResponse', 'sendToCustomer', 'autoSend',
      'automaticTreatmentDecision', 'diagnosis', 'medicationOrder',
    ].includes(key)
    || hasForbiddenOutputKey(child));
}

const INTERNAL_INSTRUCTION_PATTERN = /(?:SYSTEM_INSTRUCTIONS|STRUCTURED_CONTEXT|USER_OR_SOURCE_TEXT|BEGIN_[A-Z_]+|<\/?system>)/iu;
const MEDICATION_DIRECTIVE_PATTERN = /(?:^|[.!?…\n]\s*)(?:ให้|ควร)\s*(?:หยุด|เริ่ม|เพิ่ม|ลด|ปรับ|เปลี่ยน)\s*(?:ขนาด)?ยา/iu;
const DOSE_TOKEN_PATTERN = /(\d+(?:[.,]\d+)?)\s*(มก\.?|มล\.?|ไมโครกรัม|กรัม|เม็ด|แคปซูล|หยด|พัฟ|mg|mcg|g|ml|tablet(?:s)?|capsule(?:s)?)/giu;
const FREQUENCY_TOKEN_PATTERN = /(?:วันละ\s*)?(\d+)\s*ครั้ง/gu;

function normalizedDoseToken(amount, unit) {
  const aliases = {
    'มก':'mg', 'มก.':'mg', mg:'mg', 'ไมโครกรัม':'mcg', mcg:'mcg',
    'กรัม':'g', g:'g', 'มล':'ml', 'มล.':'ml', ml:'ml',
    'เม็ด':'tablet', tablet:'tablet', tablets:'tablet',
    'แคปซูล':'capsule', capsule:'capsule', capsules:'capsule',
    'หยด':'drop', 'พัฟ':'puff',
  };
  return `${String(amount).replace(',','.')}:${aliases[String(unit).toLowerCase()] || String(unit).toLowerCase()}`;
}

function clinicalQuantityTokens(value) {
  const text = String(value || '').normalize('NFC');
  const tokens = [];
  for (const match of text.matchAll(DOSE_TOKEN_PATTERN)) tokens.push(normalizedDoseToken(match[1], match[2]));
  for (const match of text.matchAll(FREQUENCY_TOKEN_PATTERN)) tokens.push(`frequency:${match[1]}`);
  return tokens;
}

function flattenedClinicalValues(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(flattenedClinicalValues).join(' ');
  return Object.values(value).map(flattenedClinicalValues).join(' ');
}

function assertGroundedPharmacistAssistant(value, context) {
  const draft = value?.draftResponseForPharmacistReview || '';
  if (INTERNAL_INSTRUCTION_PATTERN.test(draft) || MEDICATION_DIRECTIVE_PATTERN.test(draft)) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Unsafe pharmacist review draft');
  }
  const supported = new Set(clinicalQuantityTokens(flattenedClinicalValues(context || {})));
  if (clinicalQuantityTokens(draft).some((token) => !supported.has(token))) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Ungrounded pharmacist review draft');
  }
  return value;
}

function validatePharmacistAssistantResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || hasForbiddenOutputKey(value)) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Invalid pharmacist assistant response');
  }
  const output = { caseSummary:cleanString(value.caseSummary, 'caseSummary', 3000) };
  output.recordedFacts=validateAttributedItems(value.recordedFacts,'recordedFacts',{
    allowedSources:['care_profile','medication_snapshot','medication_diff','vital_sign','appointment','consultation_message'],
  });
  output.relevantMedicationContext=validateAttributedItems(value.relevantMedicationContext,'relevantMedicationContext',{
    allowedSources:['medication_snapshot'],
  });
  output.medicationChanges=validateAttributedItems(value.medicationChanges,'medicationChanges',{
    allowedSources:['medication_diff'],
  });
  for (const field of ['questionsToAsk','safetyConsiderations','responseGuidance','escalationConsiderations']) {
    output[field]=validateAttributedItems(value[field],field,{allowedSources:['general_ai_knowledge']});
  }
  if (!Array.isArray(value.missingInformation) || value.missingInformation.length > 30
      || value.missingInformation.some((item) => typeof item !== 'string')) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Invalid missingInformation');
  }
  output.missingInformation = Object.freeze(value.missingInformation.map((item) => item.trim().slice(0, 500)).filter(Boolean));
  output.draftResponseForPharmacistReview = cleanString(
    value.draftResponseForPharmacistReview, 'draftResponseForPharmacistReview', 4000,
  );
  output.disclaimer = cleanString(value.disclaimer, 'disclaimer', 1000);
  return Object.freeze(output);
}

module.exports = {
  SOURCE_CATEGORIES,
  PHARMACIST_ASSISTANT_INSTRUCTIONS,
  PHARMACIST_ASSISTANT_PROMPT_VERSION:AI_VERSIONS.pharmacistAssistantPrompt,
  validateAttributedItems,
  validatePharmacistAssistantResponse,
  assertGroundedPharmacistAssistant,
  hasForbiddenOutputKey,
};
