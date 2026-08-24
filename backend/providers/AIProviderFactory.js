const { GeminiProvider } = require('./GeminiProvider');
const { AI_ERROR_CODES, AIProviderError } = require('./aiErrors');

function createAIProvider({ config, env = process.env, fetchImpl = global.fetch, logger = null } = {}) {
  const provider = config?.ai?.provider || 'gemini';
  if (provider !== 'gemini') {
    throw new AIProviderError(AI_ERROR_CODES.AI_UNAVAILABLE, `Configured AI provider is not available: ${provider}`);
  }
  return new GeminiProvider({
    apiKey: env.GEMINI_API_KEY,
    model: config.ai.documentModel,
    timeoutMs: config.ai.timeoutMs,
    maxRetries: config.ai.maxRetries,
    fetchImpl,
    logger,
  });
}

module.exports = { createAIProvider };
