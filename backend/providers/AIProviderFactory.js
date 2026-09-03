const { GeminiProvider } = require('./GeminiProvider');
const { OpenAIProvider } = require('./OpenAIProvider');
const { AI_ERROR_CODES, AIProviderError } = require('./aiErrors');

function purposeConfig(config, modelPurpose, providerName = config?.ai?.provider || 'gemini') {
  const purpose = modelPurpose === 'clinical_research' ? 'clinicalResearch'
    : modelPurpose === 'pharmacist' ? 'pharmacist'
      : modelPurpose === 'explanation' ? 'explanation' : 'document';
  const providerModel = config?.ai?.providers?.[providerName]?.models?.[purpose];
  if (providerModel !== undefined) {
    const effortKey = `${purpose}ReasoningEffort`;
    return { model:providerModel, reasoningEffort:config.ai[effortKey] };
  }
  if (modelPurpose === 'clinical_research') {
    return { model: config.ai.clinicalResearchModel, reasoningEffort: config.ai.clinicalResearchReasoningEffort };
  }
  if (modelPurpose === 'pharmacist') {
    return { model: config.ai.pharmacistModel, reasoningEffort: config.ai.pharmacistReasoningEffort };
  }
  if (modelPurpose === 'explanation') {
    return { model: config.ai.explanationModel, reasoningEffort: config.ai.explanationReasoningEffort };
  }
  return { model: config.ai.documentModel, reasoningEffort: config.ai.documentReasoningEffort };
}

function purposeTimeout(config, modelPurpose) {
  if (modelPurpose === 'clinical_research') {
    return config?.ai?.clinicalResearchTimeoutMs ?? config?.ai?.timeoutMs;
  }
  if (modelPurpose === 'pharmacist') {
    return config?.ai?.pharmacistTimeoutMs ?? config?.ai?.timeoutMs;
  }
  return config?.ai?.timeoutMs;
}

function purposeProvider(config, modelPurpose, providerName = null) {
  if (providerName) return String(providerName).trim().toLowerCase();
  if (modelPurpose === 'clinical_research') {
    return String(config?.ai?.clinicalResearchProvider || config?.ai?.provider || 'gemini').trim().toLowerCase();
  }
  if (modelPurpose === 'pharmacist') {
    return String(config?.ai?.pharmacistProvider || config?.ai?.provider || 'gemini').trim().toLowerCase();
  }
  return String(config?.ai?.provider || 'gemini').trim().toLowerCase();
}

function createAIProvider({ config, env = process.env, fetchImpl = global.fetch, logger = null, modelPurpose = 'document', providerName = null } = {}) {
  const provider = purposeProvider(config, modelPurpose, providerName);
  const selected = purposeConfig(config, modelPurpose, provider);
  const timeoutMs = purposeTimeout(config, modelPurpose);
  if (provider === 'openai') {
    return new OpenAIProvider({
      apiKey: env.OPENAI_API_KEY,
      model: selected.model,
      reasoningEffort: selected.reasoningEffort,
      timeoutMs,
      maxRetries: config.ai.maxRetries,
      fetchImpl,
      logger,
    });
  }
  if (provider !== 'gemini') {
    throw new AIProviderError(AI_ERROR_CODES.AI_UNAVAILABLE, `Configured AI provider is not available: ${provider}`);
  }
  return new GeminiProvider({
    apiKey: env.GEMINI_API_KEY,
    model: selected.model,
    timeoutMs,
    maxRetries: config.ai.maxRetries,
    fetchImpl,
    logger,
  });
}

module.exports = { createAIProvider, purposeConfig, purposeTimeout, purposeProvider };
