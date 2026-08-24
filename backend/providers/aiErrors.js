const AI_ERROR_CODES = Object.freeze({
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  AI_TIMEOUT: 'AI_TIMEOUT',
  AI_RATE_LIMIT: 'AI_RATE_LIMIT',
  AI_INVALID_RESPONSE: 'AI_INVALID_RESPONSE',
  AI_PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
  UNRELATED_DOCUMENT: 'UNRELATED_DOCUMENT',
});

class AIProviderError extends Error {
  constructor(code, message, { retryable = false, cause = null, status = null } = {}) {
    super(message || code, cause ? { cause } : undefined);
    this.name = 'AIProviderError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function isAIProviderError(error) { return error instanceof AIProviderError; }

module.exports = { AI_ERROR_CODES, AIProviderError, isAIProviderError };
