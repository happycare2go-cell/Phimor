const DEFAULT_AI_TIMEOUT_MS = 15000;
const DEFAULT_AI_MAX_RETRIES = 1;

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function loadV2Config(env = process.env) {
  return Object.freeze({
    ai: Object.freeze({
      provider: String(env.AI_PROVIDER || 'gemini').trim().toLowerCase() || 'gemini',
      // Empty model values intentionally mean "use the existing provider behavior".
      // Foundation 1A does not change the current Gemini document model selection.
      documentModel: String(env.AI_MODEL_DOCUMENT || '').trim(),
      explanationModel: String(env.AI_MODEL_EXPLANATION || '').trim(),
      timeoutMs: parseInteger(env.AI_TIMEOUT_MS, DEFAULT_AI_TIMEOUT_MS, { min: 1000, max: 120000 }),
      maxRetries: parseInteger(env.AI_MAX_RETRIES, DEFAULT_AI_MAX_RETRIES, { min: 0, max: 5 }),
    }),
  });
}

module.exports = { loadV2Config, parseInteger, DEFAULT_AI_TIMEOUT_MS, DEFAULT_AI_MAX_RETRIES };
