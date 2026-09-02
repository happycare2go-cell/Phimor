const { AIProviderError, AI_ERROR_CODES } = require('./aiErrors');
const { AI_VERSIONS } = require('../config/aiVersions');
const { trustedTaskInstructions } = require('./promptSafety');

const PLUS_EXPLANATION_INSTRUCTIONS = trustedTaskInstructions(`You explain only the structured information supplied by the PHIMOR backend.
Use only the supplied context. Never invent missing health information; say that information was not found.
Do not diagnose, prescribe, recommend treatment, assess drug interactions, or suggest starting, stopping, or changing medication or dose.
Clearly distinguish recorded information from general explanation. General explanation must not become individualized medical advice.
Reply in the user's language when supported.
Return JSON only with: summary (string), keyPoints (string array), missingInformation (string array), disclaimer (string).`);

function safeStringArray(value, field) {
  if (!Array.isArray(value) || value.length > 30 || value.some((item) => typeof item !== 'string')) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, `Invalid ${field}`);
  }
  return value.map((item) => item.trim().slice(0, 500)).filter(Boolean);
}

function validatePlusExplanation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Invalid explanation response');
  }
  for (const field of ['summary', 'disclaimer']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, `Missing ${field}`);
    }
  }
  return Object.freeze({
    summary: value.summary.trim().slice(0, 4000),
    keyPoints: Object.freeze(safeStringArray(value.keyPoints, 'keyPoints')),
    missingInformation: Object.freeze(safeStringArray(value.missingInformation, 'missingInformation')),
    disclaimer: value.disclaimer.trim().slice(0, 1000),
  });
}

module.exports = {
  PLUS_EXPLANATION_INSTRUCTIONS,
  PLUS_EXPLANATION_PROMPT_VERSION: AI_VERSIONS.explanationPrompt,
  validatePlusExplanation,
};
