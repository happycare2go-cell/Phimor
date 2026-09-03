const DEFAULT_AI_TIMEOUT_MS = 15000;
const DEFAULT_AI_MAX_RETRIES = 1;
const OPENAI_MODEL_DEFAULTS = Object.freeze({
  document: 'gpt-5.6-luna',
  explanation: 'gpt-5.6-terra',
  pharmacist: 'gpt-5.6-terra',
  clinicalResearch: 'gpt-5.6-sol',
});
const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function loadV2Config(env = process.env) {
  const provider = String(env.AI_PROVIDER || 'gemini').trim().toLowerCase() || 'gemini';
  const model = (value, openAIDefault) => String(value || (provider === 'openai' ? openAIDefault : '')).trim();
  const effort = (value, fallback) => {
    const normalized = String(value || fallback).trim().toLowerCase();
    return REASONING_EFFORTS.has(normalized) ? normalized : fallback;
  };
  return Object.freeze({
    ai: Object.freeze({
      provider,
      // Empty model values intentionally mean "use the existing provider behavior".
      // Foundation 1A does not change the current Gemini document model selection.
      documentModel: model(env.AI_MODEL_DOCUMENT, OPENAI_MODEL_DEFAULTS.document),
      explanationModel: model(env.AI_MODEL_EXPLANATION, OPENAI_MODEL_DEFAULTS.explanation),
      pharmacistModel: model(env.AI_MODEL_PHARMACIST, OPENAI_MODEL_DEFAULTS.pharmacist),
      clinicalResearchModel: model(env.AI_MODEL_CLINICAL_RESEARCH, OPENAI_MODEL_DEFAULTS.clinicalResearch),
      documentReasoningEffort: effort(env.AI_REASONING_DOCUMENT, 'low'),
      explanationReasoningEffort: effort(env.AI_REASONING_EXPLANATION, 'medium'),
      pharmacistReasoningEffort: effort(env.AI_REASONING_PHARMACIST, 'medium'),
      clinicalResearchReasoningEffort: effort(env.AI_REASONING_CLINICAL_RESEARCH, 'high'),
      timeoutMs: parseInteger(env.AI_TIMEOUT_MS, DEFAULT_AI_TIMEOUT_MS, { min: 1000, max: 120000 }),
      maxRetries: parseInteger(env.AI_MAX_RETRIES, DEFAULT_AI_MAX_RETRIES, { min: 0, max: 5 }),
    }),
  });
}

module.exports = {
  loadV2Config, parseInteger, DEFAULT_AI_TIMEOUT_MS, DEFAULT_AI_MAX_RETRIES,
  OPENAI_MODEL_DEFAULTS,
};
