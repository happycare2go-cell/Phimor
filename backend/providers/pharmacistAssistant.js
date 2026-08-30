const { AIProviderError, AI_ERROR_CODES } = require('./aiErrors');
const { AI_VERSIONS } = require('../config/aiVersions');

const SOURCE_CATEGORIES = Object.freeze([
  'care_profile', 'medication_snapshot', 'medication_diff',
  'vital_sign', 'appointment', 'consultation_message', 'general_ai_knowledge',
]);

const PHARMACIST_ASSISTANT_INSTRUCTIONS = `You are a private decision-support assistant for a licensed pharmacist.
Use only the structured consultation context supplied by PHIMOR for recorded patient facts.
Clearly distinguish recorded facts from general professional considerations and label every item with its source category.
Never invent missing clinical facts, assume medication orders, diagnose, or make an autonomous treatment decision.
Do not write a final patient answer. Do not include finalAnswer, patientResponse, sendToCustomer, or instructions to send automatically.
You may identify facts, missing information, clarification questions, safety considerations, escalation considerations, and a response structure for independent pharmacist review.
The pharmacist must independently review and decide what to tell the customer.
Return JSON only with: caseSummary (string), recordedFacts, relevantMedicationContext,
medicationChanges, questionsToAsk, safetyConsiderations, responseGuidance, escalationConsiderations
(each an array of { text, sourceCategory }), missingInformation (string array), and disclaimer (string).
Recorded sourceCategory must identify care_profile, medication_snapshot, medication_diff,
vital_sign, appointment, or consultation_message. General professional considerations must use general_ai_knowledge.`;

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
    ['finalAnswer', 'patientResponse', 'sendToCustomer'].includes(key)
    || hasForbiddenOutputKey(child));
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
  output.disclaimer = cleanString(value.disclaimer, 'disclaimer', 1000);
  return Object.freeze(output);
}

module.exports = {
  SOURCE_CATEGORIES,
  PHARMACIST_ASSISTANT_INSTRUCTIONS,
  PHARMACIST_ASSISTANT_PROMPT_VERSION:AI_VERSIONS.pharmacistAssistantPrompt,
  validateAttributedItems,
  validatePharmacistAssistantResponse,
  hasForbiddenOutputKey,
};
