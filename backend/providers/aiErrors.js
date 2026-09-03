const AI_ERROR_CODES = Object.freeze({
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  AI_TIMEOUT: 'AI_TIMEOUT',
  AI_RATE_LIMIT: 'AI_RATE_LIMIT',
  AI_INVALID_RESPONSE: 'AI_INVALID_RESPONSE',
  AI_PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
  UNRELATED_DOCUMENT: 'UNRELATED_DOCUMENT',
});

const AI_VALIDATION_STAGES = Object.freeze({
  PROVIDER_SCHEMA_OR_PARSE: 'provider_schema_or_parse',
  LOCAL_CONTRACT_VALIDATION: 'local_contract_validation',
  GROUNDING_VALIDATION: 'grounding_validation',
  EVIDENCE_REFERENCE_VALIDATION: 'evidence_reference_validation',
  UNSUPPORTED_NO_INTERACTION_CLAIM: 'unsupported_no_interaction_claim',
});

const AI_PROVIDER_FAILURE_KINDS = Object.freeze({
  SCHEMA_REJECTED: 'provider_schema_rejected',
  HTTP_JSON_INVALID: 'provider_http_json_invalid',
  RESPONSE_INCOMPLETE: 'provider_response_incomplete',
  REFUSAL: 'provider_refusal',
  STRUCTURED_OUTPUT_MISSING: 'provider_structured_output_missing',
  STRUCTURED_OUTPUT_INVALID_JSON: 'provider_structured_output_invalid_json',
});

const SAFE_VALIDATION_STAGES = new Set(Object.values(AI_VALIDATION_STAGES));
const SAFE_PROVIDER_FAILURE_KINDS = new Set(Object.values(AI_PROVIDER_FAILURE_KINDS));

function safeValidationStage(value) {
  return SAFE_VALIDATION_STAGES.has(value) ? value : null;
}

function safeProviderFailureKind(value) {
  return SAFE_PROVIDER_FAILURE_KINDS.has(value) ? value : null;
}

function logAIValidationFailure(logger, { event, task, error } = {}) {
  const validationStage = safeValidationStage(error?.validationStage);
  if (!validationStage || typeof logger !== 'function') return false;
  logger(Object.freeze({
    event:String(event || 'ai_contract_rejected').slice(0, 64),
    task:String(task || 'unspecified').slice(0, 64),
    errorCode:AI_ERROR_CODES.AI_INVALID_RESPONSE,
    validationStage,
  }));
  return true;
}

class AIProviderError extends Error {
  constructor(code, message, {
    retryable = false, cause = null, status = null, validationStage = null,
    providerFailureKind = null,
  } = {}) {
    super(message || code, cause ? { cause } : undefined);
    this.name = 'AIProviderError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.validationStage = safeValidationStage(validationStage);
    this.providerFailureKind = safeProviderFailureKind(providerFailureKind);
  }
}

function isAIProviderError(error) { return error instanceof AIProviderError; }

module.exports = {
  AI_ERROR_CODES, AI_VALIDATION_STAGES, AI_PROVIDER_FAILURE_KINDS,
  AIProviderError, isAIProviderError, safeValidationStage, safeProviderFailureKind,
  logAIValidationFailure,
};
