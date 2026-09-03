const DEFAULT_AI_TIMEOUT_MS = 15000;
const DEFAULT_AI_TIMEOUT_PHARMACIST_MS = 45000;
const DEFAULT_AI_TIMEOUT_CLINICAL_RESEARCH_MS = 90000;
const DEFAULT_AI_MAX_RETRIES = 1;
const OPENAI_MODEL_DEFAULTS = Object.freeze({
  document: 'gpt-5.6-luna',
  explanation: 'gpt-5.6-terra',
  pharmacist: 'gpt-5.6-terra',
  clinicalResearch: 'gpt-5.6-sol',
});
const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
const DEFAULT_CLINICAL_ALLOWED_DOMAINS = Object.freeze([
  'moph.go.th', 'fda.moph.go.th', 'ddc.moph.go.th', 'who.int', 'cdc.gov',
  'fda.gov', 'dailymed.nlm.nih.gov', 'ema.europa.eu', 'nice.org.uk',
  'idsociety.org', 'pubmed.ncbi.nlm.nih.gov',
]);

function parseDomainList(value, fallback = DEFAULT_CLINICAL_ALLOWED_DOMAINS) {
  if (typeof value !== 'string' || !value.trim()) return Object.freeze([...fallback]);
  const domains = [...new Set(value.split(',').map((item) => item.trim().toLowerCase())
    .filter((item) => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(item)))].slice(0, 50);
  return Object.freeze(domains.length ? domains : [...fallback]);
}

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function providerName(value, fallback = 'gemini') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

function configuredModel(value, fallback = '') {
  return String(value || fallback).trim();
}

function legacyGeminiModel(value) {
  const normalized = configuredModel(value);
  return /^(?:models\/)?gemini-/i.test(normalized) ? normalized : '';
}

function loadV2Config(env = process.env) {
  const provider = providerName(env.AI_PROVIDER);
  const pharmacistProvider = providerName(env.AI_PROVIDER_PHARMACIST, provider);
  const clinicalResearchProvider = providerName(env.AI_PROVIDER_CLINICAL_RESEARCH, provider);
  const openAIModels = Object.freeze({
    document:configuredModel(env.AI_MODEL_DOCUMENT, OPENAI_MODEL_DEFAULTS.document),
    explanation:configuredModel(env.AI_MODEL_EXPLANATION, OPENAI_MODEL_DEFAULTS.explanation),
    pharmacist:configuredModel(env.AI_MODEL_PHARMACIST, OPENAI_MODEL_DEFAULTS.pharmacist),
    clinicalResearch:configuredModel(env.AI_MODEL_CLINICAL_RESEARCH, OPENAI_MODEL_DEFAULTS.clinicalResearch),
  });
  // AI_MODEL_* historically accepted Gemini names. Preserve that compatibility,
  // while never routing a configured gpt-* model to the Gemini provider.
  const geminiModels = Object.freeze({
    document:configuredModel(env.GEMINI_MODEL_DOCUMENT, legacyGeminiModel(env.AI_MODEL_DOCUMENT)),
    explanation:configuredModel(env.GEMINI_MODEL_EXPLANATION, legacyGeminiModel(env.AI_MODEL_EXPLANATION)),
    pharmacist:configuredModel(env.GEMINI_MODEL_PHARMACIST, legacyGeminiModel(env.AI_MODEL_PHARMACIST)),
    clinicalResearch:configuredModel(
      env.GEMINI_MODEL_CLINICAL_RESEARCH,
      legacyGeminiModel(env.AI_MODEL_CLINICAL_RESEARCH),
    ),
  });
  const selectedModel = (selectedProvider, purpose) => (
    selectedProvider === 'openai' ? openAIModels[purpose] : geminiModels[purpose]
  );
  const effort = (value, fallback) => {
    const normalized = String(value || fallback).trim().toLowerCase();
    return REASONING_EFFORTS.has(normalized) ? normalized : fallback;
  };
  const timeoutMs = parseInteger(env.AI_TIMEOUT_MS, DEFAULT_AI_TIMEOUT_MS, { min: 1000, max: 120000 });
  const purposeTimeout = (value, invalidFallback) => {
    if (value === undefined || value === null || String(value).trim() === '') return timeoutMs;
    return parseInteger(value, invalidFallback, { min: 5000, max: 120000 });
  };
  return Object.freeze({
    ai: Object.freeze({
      provider,
      pharmacistProvider,
      clinicalResearchProvider,
      providers:Object.freeze({
        openai:Object.freeze({ models:openAIModels }),
        gemini:Object.freeze({ models:geminiModels }),
      }),
      // Empty model values intentionally mean "use the existing provider behavior".
      // Foundation 1A does not change the current Gemini document model selection.
      documentModel:selectedModel(provider, 'document'),
      explanationModel:selectedModel(provider, 'explanation'),
      pharmacistModel:selectedModel(pharmacistProvider, 'pharmacist'),
      clinicalResearchModel:selectedModel(clinicalResearchProvider, 'clinicalResearch'),
      documentReasoningEffort: effort(env.AI_REASONING_DOCUMENT, 'low'),
      explanationReasoningEffort: effort(env.AI_REASONING_EXPLANATION, 'medium'),
      pharmacistReasoningEffort: effort(env.AI_REASONING_PHARMACIST, 'medium'),
      clinicalResearchReasoningEffort: effort(env.AI_REASONING_CLINICAL_RESEARCH, 'high'),
      clinicalAllowedDomains: parseDomainList(env.OPENAI_CLINICAL_ALLOWED_DOMAINS),
      timeoutMs,
      pharmacistTimeoutMs: purposeTimeout(env.AI_TIMEOUT_PHARMACIST_MS, DEFAULT_AI_TIMEOUT_PHARMACIST_MS),
      clinicalResearchTimeoutMs: purposeTimeout(
        env.AI_TIMEOUT_CLINICAL_RESEARCH_MS, DEFAULT_AI_TIMEOUT_CLINICAL_RESEARCH_MS,
      ),
      maxRetries: parseInteger(env.AI_MAX_RETRIES, DEFAULT_AI_MAX_RETRIES, { min: 0, max: 5 }),
    }),
  });
}

module.exports = {
  loadV2Config, parseInteger, DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_AI_TIMEOUT_PHARMACIST_MS, DEFAULT_AI_TIMEOUT_CLINICAL_RESEARCH_MS,
  DEFAULT_AI_MAX_RETRIES,
  OPENAI_MODEL_DEFAULTS, DEFAULT_CLINICAL_ALLOWED_DOMAINS,
  parseDomainList, providerName, legacyGeminiModel,
};
