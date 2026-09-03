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

function createAIProvider({ config, env = process.env, fetchImpl = global.fetch, logger = null, modelPurpose = 'document', providerName = null } = {}) {
  const provider = String(providerName || config?.ai?.provider || 'gemini').trim().toLowerCase();
  const selected = purposeConfig(config, modelPurpose, provider);
  if (provider === 'openai') {
    return new OpenAIProvider({
      apiKey: env.OPENAI_API_KEY,
      model: selected.model,
      reasoningEffort: selected.reasoningEffort,
      timeoutMs: config.ai.timeoutMs,
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
    timeoutMs: config.ai.timeoutMs,
    maxRetries: config.ai.maxRetries,
    fetchImpl,
    logger,
  });
}

module.exports = { createAIProvider, purposeConfig };
