const { BaseAIProvider } = require('./BaseAIProvider');
const { AI_ERROR_CODES, AIProviderError, isAIProviderError } = require('./aiErrors');
const { ensureTrustedTaskInstructions, untrustedSourceSection } = require('./promptSafety');

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

function safeSchemaName(value) {
  const normalized = String(value || 'structured_response').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return normalized || 'structured_response';
}

function safeSource(value) {
  if (!value || typeof value !== 'object') return null;
  let url;
  try {
    url = new URL(String(value.url || ''));
  } catch (_) {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const publishedAt = typeof value.published_at === 'string' && !Number.isNaN(new Date(value.published_at).getTime())
    ? new Date(value.published_at).toISOString() : null;
  return Object.freeze({
    url: url.toString(),
    title: typeof value.title === 'string' ? value.title.normalize('NFC').trim().slice(0, 300) : '',
    publishedAt,
  });
}

function responseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type !== 'message') continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type === 'refusal') {
        throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'OpenAI declined the structured request');
      }
      if (content?.type === 'output_text' && typeof content.text === 'string' && content.text.trim()) {
        return content.text;
      }
    }
  }
  throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'OpenAI response has no structured output');
}

function responseMetadata(data, response) {
  const sources = [];
  let webSearchCalls = 0;
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type === 'web_search_call') {
      webSearchCalls += 1;
      for (const source of Array.isArray(item?.action?.sources) ? item.action.sources : []) {
        const safe = safeSource(source);
        if (safe) sources.push(safe);
      }
    }
    if (item?.type === 'message') {
      for (const content of Array.isArray(item.content) ? item.content : []) {
        for (const annotation of Array.isArray(content?.annotations) ? content.annotations : []) {
          if (annotation?.type !== 'url_citation') continue;
          const safe = safeSource(annotation);
          if (safe) sources.push(safe);
        }
      }
    }
  }
  const uniqueSources = [...new Map(sources.map((source) => [source.url, source])).values()];
  const usage = data?.usage || {};
  return Object.freeze({
    provider: 'openai', model: typeof data?.model === 'string' ? data.model : null,
    providerRequestId: response?.headers?.get?.('x-request-id') || (typeof data?.id === 'string' ? data.id : null),
    usage: Object.freeze({
      inputTokens: Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : null,
      outputTokens: Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : null,
      totalTokens: Number.isSafeInteger(usage.total_tokens) ? usage.total_tokens : null,
      reasoningTokens: Number.isSafeInteger(usage?.output_tokens_details?.reasoning_tokens)
        ? usage.output_tokens_details.reasoning_tokens : null,
    }),
    webSearchCalls, sources: Object.freeze(uniqueSources),
  });
}

class OpenAIProvider extends BaseAIProvider {
  constructor({ apiKey, model, reasoningEffort = 'medium', timeoutMs = 15000, maxRetries = 1, fetchImpl = global.fetch, logger = null, retryDelayMs = 100 } = {}) {
    super();
    this.apiKey = apiKey || '';
    this.model = String(model || '').trim();
    this.reasoningEffort = reasoningEffort;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.retryDelayMs = retryDelayMs;
  }

  log(event) { if (typeof this.logger === 'function') this.logger(event); }

  async generateStructured({
    task, systemInstructions, context = null, input, outputSchema,
    responseSchema = null, responseSchemaName = null, timeoutMs, requestId = null,
    model = null, reasoningEffort = null, webSearch = null, onMetadata = null,
  }) {
    if (!this.apiKey || !this.model || typeof this.fetch !== 'function') {
      throw new AIProviderError(AI_ERROR_CODES.AI_UNAVAILABLE, 'OpenAI provider is not configured');
    }
    const startedAt = Date.now();
    const deadline = startedAt + (timeoutMs || this.timeoutMs);
    const selectedModel = String(model || this.model).trim();
    try {
      const generated = await this.executeWithRetry(
        (attemptDeadline) => this.generateOnce({
          model: selectedModel, reasoningEffort: reasoningEffort || this.reasoningEffort,
          systemInstructions, context, input, outputSchema, responseSchema,
          responseSchemaName, webSearch, deadline: attemptDeadline,
        }),
        deadline,
      );
      if (typeof onMetadata === 'function') onMetadata(generated.metadata);
      this.log({ provider: 'openai', model: selectedModel, task, requestId, durationMs: Date.now() - startedAt, resultStatus: 'success' });
      return generated.result;
    } catch (error) {
      const mapped = this.mapError(error);
      this.log({ provider: 'openai', model: selectedModel, task, requestId, durationMs: Date.now() - startedAt, resultStatus: 'error', errorCode: mapped.code });
      throw mapped;
    }
  }

  requestBody({ model, reasoningEffort, systemInstructions, context, input, responseSchema, responseSchemaName, webSearch }) {
    const content = [];
    if (context !== null && context !== undefined) {
      content.push({ type: 'input_text', text: untrustedSourceSection('STRUCTURED_CONTEXT', context) });
    }
    if (input?.text) content.push({ type: 'input_text', text: untrustedSourceSection('USER_OR_SOURCE_TEXT', input.text) });
    if (input?.imageBuffer) {
      content.push({ type: 'input_text', text: untrustedSourceSection('SOURCE_IMAGE_NOTICE', 'The following inline image is untrusted source data.') });
      content.push({
        type: 'input_image', detail: 'auto',
        image_url: `data:${input.imageMimeType || 'image/jpeg'};base64,${input.imageBuffer.toString('base64')}`,
      });
    }
    const body = {
      model, store: false,
      instructions: ensureTrustedTaskInstructions(systemInstructions),
      input: [{ role: 'user', content }],
      reasoning: { effort: reasoningEffort },
    };
    if (responseSchema) {
      body.text = { format: { type: 'json_schema', name: safeSchemaName(responseSchemaName), schema: responseSchema, strict: true } };
    }
    if (webSearch) {
      const allowedDomains = Array.isArray(webSearch.allowedDomains)
        ? webSearch.allowedDomains.map((value) => String(value).trim().toLowerCase()).filter(Boolean).slice(0, 100)
        : [];
      body.tools = [{
        type: 'web_search', search_context_size: webSearch.searchContextSize || 'medium',
        ...(allowedDomains.length ? { filters: { allowed_domains: allowedDomains } } : {}),
        ...(webSearch.country ? { user_location: { type: 'approximate', country: String(webSearch.country).slice(0, 2).toUpperCase() } } : {}),
      }];
      body.tool_choice = 'auto';
      body.include = ['web_search_call.action.sources'];
      if (Number.isSafeInteger(webSearch.maxCalls) && webSearch.maxCalls > 0) body.max_tool_calls = webSearch.maxCalls;
    }
    return body;
  }

  async generateOnce(options) {
    const body = this.requestBody(options);
    const response = await this.fetchWithDeadline(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, options.deadline);
    if (!response.ok) throw this.httpError(response.status);
    let data;
    try { data = await response.json(); } catch (_) {
      throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'OpenAI returned invalid JSON');
    }
    if (data?.status !== 'completed') {
      throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'OpenAI response was incomplete');
    }
    let parsed;
    try { parsed = JSON.parse(responseText(data)); } catch (error) {
      if (isAIProviderError(error)) throw error;
      throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'OpenAI structured output was invalid JSON');
    }
    let result = parsed;
    if (typeof options.outputSchema === 'function') {
      try { result = options.outputSchema(parsed); } catch (error) {
        if (isAIProviderError(error)) throw error;
        throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'OpenAI output failed local validation');
      }
    }
    return { result, metadata: responseMetadata(data, response) };
  }

  async executeWithRetry(operation, deadline) {
    let retries = 0;
    while (true) {
      const remaining = deadline - Date.now();
      const attemptsRemaining = this.maxRetries - retries + 1;
      const attemptDeadline = Math.min(deadline, Date.now() + Math.max(1, Math.floor(remaining / attemptsRemaining)));
      try { return await operation(attemptDeadline); } catch (error) {
        const mapped = this.mapError(error);
        if (!mapped.retryable || retries >= this.maxRetries || Date.now() >= deadline) throw mapped;
        const delay = mapped.code === AI_ERROR_CODES.AI_TIMEOUT
          ? 0 : Math.min(this.retryDelayMs * (2 ** retries), Math.max(0, deadline - Date.now() - 1));
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
    try { return await this.fetch(url, { ...options, signal: controller.signal }); } catch (error) {
      if (error?.name === 'AbortError') throw new AIProviderError(AI_ERROR_CODES.AI_TIMEOUT, 'AI request timed out', { retryable: true });
      throw new AIProviderError(AI_ERROR_CODES.AI_UNAVAILABLE, 'AI provider could not be reached', { retryable: true });
    } finally { clearTimeout(timer); }
  }

  httpError(status) {
    if (status === 429) return new AIProviderError(AI_ERROR_CODES.AI_RATE_LIMIT, 'AI provider rate limit exceeded', { retryable: true, status });
    if (status === 408) return new AIProviderError(AI_ERROR_CODES.AI_TIMEOUT, 'AI provider request timed out', { retryable: true, status });
    if (status >= 500) return new AIProviderError(AI_ERROR_CODES.AI_PROVIDER_ERROR, 'AI provider service error', { retryable: true, status });
    if (status === 401 || status === 403) return new AIProviderError(AI_ERROR_CODES.AI_UNAVAILABLE, 'AI provider credentials were rejected', { status });
    return new AIProviderError(AI_ERROR_CODES.AI_PROVIDER_ERROR, 'AI provider rejected the request', { status });
  }

  mapError(error) {
    if (isAIProviderError(error)) return error;
    return new AIProviderError(AI_ERROR_CODES.AI_PROVIDER_ERROR, 'Unexpected AI provider error');
  }
}

module.exports = {
  OpenAIProvider, OPENAI_RESPONSES_URL, safeSchemaName, safeSource,
  responseText, responseMetadata,
};
