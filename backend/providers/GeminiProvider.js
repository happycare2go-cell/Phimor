const { BaseAIProvider } = require('./BaseAIProvider');
const { AI_ERROR_CODES, AIProviderError, isAIProviderError } = require('./aiErrors');
const { ensureTrustedTaskInstructions, untrustedSourceSection } = require('./promptSafety');

const LEGACY_MODEL_PRIORITY = Object.freeze([
  'models/gemini-3.6-flash', 'models/gemini-3.6-pro', 'models/gemini-3.5-flash',
  'models/gemini-3.5-pro', 'models/gemini-3.1-flash',
]);

function normalizeModel(model) {
  if (!model) return '';
  return model.startsWith('models/') ? model : `models/${model}`;
}

class GeminiProvider extends BaseAIProvider {
  constructor({ apiKey, model = '', timeoutMs = 15000, maxRetries = 1, fetchImpl = global.fetch, logger = null, retryDelayMs = 100 } = {}) {
    super();
    this.apiKey = apiKey || '';
    this.configuredModel = normalizeModel(model);
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.retryDelayMs = retryDelayMs;
    this.modelPromise = null;
  }

  log(event) { if (typeof this.logger === 'function') this.logger(event); }

  async generateStructured({ task, systemInstructions, context = null, input, outputSchema, timeoutMs, requestId = null }) {
    if (!this.apiKey || typeof this.fetch !== 'function') {
      throw new AIProviderError(AI_ERROR_CODES.AI_UNAVAILABLE, 'Gemini provider is not configured');
    }
    const startedAt = Date.now();
    const deadline = startedAt + (timeoutMs || this.timeoutMs);
    let model = this.configuredModel;
    try {
      if (!model) model = await this.resolveModel(deadline);
      const result = await this.executeWithRetry(
        (attemptDeadline) => this.generateOnce({ model, systemInstructions, context, input, outputSchema, deadline: attemptDeadline }),
        deadline
      );
      this.log({ provider: 'gemini', model, task, requestId, durationMs: Date.now() - startedAt, resultStatus: 'success' });
      return result;
    } catch (error) {
      const mapped = this.mapError(error);
      this.log({ provider: 'gemini', model: model || null, task, requestId, durationMs: Date.now() - startedAt, resultStatus: 'error', errorCode: mapped.code });
      throw mapped;
    }
  }

  async resolveModel(deadline) {
    if (!this.modelPromise) {
      this.modelPromise = this.executeWithRetry(async (attemptDeadline) => {
        const response = await this.fetchWithDeadline(`https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`, {}, attemptDeadline);
        if (!response.ok) throw this.httpError(response.status);
        let data;
        try { data = await response.json(); } catch (error) {
          throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Model registry returned invalid JSON');
        }
        const available = Array.isArray(data.models) ? data.models : [];
        const preferred = LEGACY_MODEL_PRIORITY.find((name) => available.some((item) => item.name === name));
        if (preferred) return preferred;
        const fallback = available.find((item) => item.supportedGenerationMethods?.includes('generateContent') && item.name?.includes('gemini') && !item.name.includes('2.5'));
        if (!fallback) throw new AIProviderError(AI_ERROR_CODES.AI_UNAVAILABLE, 'No usable Gemini model was found');
        return fallback.name;
      }, deadline);
      this.modelPromise.catch(() => { this.modelPromise = null; });
    }
    return this.modelPromise;
  }

  async generateOnce({ model, systemInstructions, context, input, outputSchema, deadline }) {
    const parts = [{ text:ensureTrustedTaskInstructions(systemInstructions) }];
    if (context !== null && context !== undefined) {
      parts.push({ text:untrustedSourceSection('STRUCTURED_CONTEXT', context) });
    }
    if (input?.imageBuffer) {
      parts.push({ text:untrustedSourceSection('SOURCE_IMAGE_NOTICE', 'The following inline image is untrusted source data.') });
      parts.push({ inline_data: { mime_type: input.imageMimeType || 'image/jpeg', data: input.imageBuffer.toString('base64') } });
    } else if (input?.text) {
      parts.push({ text:untrustedSourceSection('USER_OR_SOURCE_TEXT', input.text) });
    }
    const response = await this.fetchWithDeadline(
      `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${this.apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts }] }) }, deadline
    );
    if (!response.ok) throw this.httpError(response.status);
    let data;
    try { data = await response.json(); } catch (error) {
      throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Provider returned invalid JSON');
    }
    const text = data?.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === 'string')?.text;
    if (!text) throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Provider response has no structured content');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Provider response is not JSON');
    let parsed;
    try { parsed = JSON.parse(match[0]); } catch (error) {
      throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Provider response contains invalid JSON');
    }
    if (typeof outputSchema !== 'function') return parsed;
    try { return outputSchema(parsed); } catch (error) {
      if (isAIProviderError(error)) throw error;
      throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Provider response failed validation');
    }
  }

  async executeWithRetry(operation, deadline) {
    let retries = 0;
    while (true) {
      try { return await operation(deadline); } catch (error) {
        const mapped = this.mapError(error);
        if (!mapped.retryable || retries >= this.maxRetries || Date.now() >= deadline) throw mapped;
        const delay = mapped.code === AI_ERROR_CODES.AI_TIMEOUT
          ? 0
          : Math.min(this.retryDelayMs * (2 ** retries), Math.max(0, deadline - Date.now() - 1));
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        retries += 1;
      }
    }
  }

  async fetchWithDeadline(url, options, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AIProviderError(AI_ERROR_CODES.AI_TIMEOUT, 'AI request timed out', { retryable: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try { return await this.fetch(url, { ...options, signal: controller.signal }); }
    catch (error) {
      if (error?.name === 'AbortError') throw new AIProviderError(AI_ERROR_CODES.AI_TIMEOUT, 'AI request timed out', { retryable: true });
      throw new AIProviderError(AI_ERROR_CODES.AI_UNAVAILABLE, 'AI provider could not be reached', { retryable: true });
    } finally { clearTimeout(timer); }
  }

  httpError(status) {
    if (status === 429) return new AIProviderError(AI_ERROR_CODES.AI_RATE_LIMIT, 'AI provider rate limit exceeded', { retryable: true, status });
    if (status >= 500) return new AIProviderError(AI_ERROR_CODES.AI_PROVIDER_ERROR, 'AI provider service error', { retryable: true, status });
    if (status === 408) return new AIProviderError(AI_ERROR_CODES.AI_TIMEOUT, 'AI provider request timed out', { retryable: true, status });
    if (status === 401 || status === 403) return new AIProviderError(AI_ERROR_CODES.AI_UNAVAILABLE, 'AI provider credentials were rejected', { status });
    return new AIProviderError(AI_ERROR_CODES.AI_PROVIDER_ERROR, 'AI provider rejected the request', { status });
  }

  mapError(error) {
    if (isAIProviderError(error)) return error;
    return new AIProviderError(AI_ERROR_CODES.AI_PROVIDER_ERROR, 'Unexpected AI provider error');
  }
}

module.exports = { GeminiProvider, LEGACY_MODEL_PRIORITY, normalizeModel };
