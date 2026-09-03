const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenAIProvider, OPENAI_RESPONSES_URL } = require('../backend/providers/OpenAIProvider');
const { createAIProvider } = require('../backend/providers/AIProviderFactory');
const { loadV2Config } = require('../backend/config/v2Config');
const { AI_ERROR_CODES, AIProviderError } = require('../backend/providers/aiErrors');

function response(status, body, requestId = 'req-safe') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === 'x-request-id' ? requestId : null },
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

function completed(value, overrides = {}) {
  return response(200, {
    id: 'resp-safe', status: 'completed', model: 'gpt-test',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }] }],
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, output_tokens_details: { reasoning_tokens: 3 } },
    ...overrides,
  });
}

function createProvider(fetchImpl, overrides = {}) {
  return new OpenAIProvider({
    apiKey: 'sk-private-test', model: 'gpt-test', reasoningEffort: 'medium',
    timeoutMs: 100, maxRetries: 0, retryDelayMs: 0, fetchImpl, ...overrides,
  });
}

function generate(provider, overrides = {}) {
  return provider.generateStructured({
    task: 'safe_task', systemInstructions: 'trusted instructions',
    context: JSON.stringify({ sensitive: 'patient-context' }), input: { text: 'private user text' },
    responseSchema: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } },
    responseSchemaName: 'safe-answer', outputSchema: (value) => ({ answer: String(value.answer) }),
    ...overrides,
  });
}

test('OpenAI provider uses fixed Responses endpoint, store false, strict schema and selected reasoning', async () => {
  let captured;
  const result = await generate(createProvider(async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return completed({ answer: 'ok' });
  }));
  assert.deepStrictEqual(result, { answer: 'ok' });
  assert.strictEqual(captured.url, OPENAI_RESPONSES_URL);
  assert.strictEqual(captured.body.store, false);
  assert.strictEqual(captured.body.reasoning.effort, 'medium');
  assert.strictEqual(captured.body.text.format.type, 'json_schema');
  assert.strictEqual(captured.body.text.format.strict, true);
  assert.strictEqual(captured.body.text.format.name, 'safe-answer');
  assert.strictEqual(captured.body.previous_response_id, undefined);
  assert.strictEqual(captured.options.headers.Authorization, 'Bearer sk-private-test');
});

test('OpenAI image input uses an inline data URL and is never placed in metadata logs', async () => {
  const logs = [];
  let serializedBody = '';
  const provider = createProvider(async (_url, options) => {
    serializedBody = options.body;
    return completed({ answer: 'ok' });
  }, { logger: (event) => logs.push(event) });
  await generate(provider, {
    context: null, input: { imageBuffer: Buffer.from('private-image-bytes'), imageMimeType: 'image/png' },
  });
  assert.match(serializedBody, /data:image\/png;base64/);
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /private-image|private user|patient-context|sk-private/);
  assert.deepStrictEqual(Object.keys(logs[0]).sort(), ['durationMs', 'model', 'provider', 'requestId', 'resultStatus', 'task'].sort());
});

test('OpenAI provider returns safe usage and actual web source metadata', async () => {
  let metadata;
  await generate(createProvider(async () => completed({ answer: 'researched' }, {
    output: [
      { type: 'web_search_call', action: { sources: [
        { url: 'https://www.who.int/example', title: 'WHO' },
        { url: 'javascript:alert(1)', title: 'unsafe' },
      ] } },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ answer: 'researched' }), annotations: [
        { type: 'url_citation', url: 'https://www.who.int/example', title: 'WHO duplicate' },
        { type: 'url_citation', url: 'https://www.fda.gov/example', title: 'FDA' },
      ] }] },
    ],
  })), {
    webSearch: { allowedDomains: ['who.int'], maxCalls: 1 },
    onMetadata: (value) => { metadata = value; },
  });
  assert.deepStrictEqual(metadata.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18, reasoningTokens: 3 });
  assert.strictEqual(metadata.webSearchCalls, 1);
  assert.deepStrictEqual(metadata.sources.map((source) => source.url), [
    'https://www.who.int/example', 'https://www.fda.gov/example',
  ]);
});

test('web search request includes only configured domains and bounded tool calls', async () => {
  let body;
  await generate(createProvider(async (_url, options) => {
    body = JSON.parse(options.body);
    return completed({ answer: 'ok' });
  }), { webSearch: { allowedDomains: ['WHO.INT', '', 'fda.gov'], maxCalls: 2, searchContextSize: 'low', country:'TH' } });
  assert.deepStrictEqual(body.tools, [{
    type: 'web_search', search_context_size: 'low', filters: { allowed_domains: ['who.int', 'fda.gov'] },
    user_location:{ type:'approximate', country:'TH' },
  }]);
  assert.strictEqual(body.max_tool_calls, 2);
  assert.deepStrictEqual(body.include, ['web_search_call.action.sources']);
});

test('OpenAI provider maps refusal, incomplete, malformed JSON and local validation safely', async () => {
  const refusal = completed({}, { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private' }] }] });
  await assert.rejects(generate(createProvider(async () => refusal)), (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
  await assert.rejects(generate(createProvider(async () => response(200, { status: 'incomplete', output: [] }))), (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
  await assert.rejects(generate(createProvider(async () => completed({}, { output_text: '{bad' }))), (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
  await assert.rejects(generate(createProvider(async () => completed({ answer: 'ok' })), { outputSchema: () => { throw new Error('private validation'); } }), (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
});

test('OpenAI provider maps HTTP and network failures with bounded retry', async () => {
  await assert.rejects(generate(createProvider(async () => response(429, {}))), (error) => error.code === AI_ERROR_CODES.AI_RATE_LIMIT);
  await assert.rejects(generate(createProvider(async () => response(503, {}))), (error) => error.code === AI_ERROR_CODES.AI_PROVIDER_ERROR);
  await assert.rejects(generate(createProvider(async () => { throw new Error('private network'); })), (error) => error.code === AI_ERROR_CODES.AI_UNAVAILABLE);
  let calls = 0;
  const result = await generate(createProvider(async () => {
    calls += 1;
    return calls === 1 ? response(503, {}) : completed({ answer: 'ok' });
  }, { maxRetries: 1 }));
  assert.deepStrictEqual(result, { answer: 'ok' });
  assert.strictEqual(calls, 2);
});

test('OpenAI provider timeout is bounded by AbortController', async () => {
  let calls = 0;
  const provider = createProvider(async (_url, { signal }) => new Promise((_resolve, reject) => {
    calls += 1;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }), { timeoutMs: 10, maxRetries:1 });
  await assert.rejects(generate(provider), (error) => error.code === AI_ERROR_CODES.AI_TIMEOUT);
  assert.equal(calls,1);
});

test('OpenAI first attempt receives the full overall deadline even when a retry is available', async () => {
  const provider = createProvider(async () => completed({ answer:'ok' }), { maxRetries:1 });
  const deadline = Date.now() + 10_000;
  const attemptDeadlines = [];
  const result = await provider.executeWithRetry(async (attemptDeadline) => {
    attemptDeadlines.push(attemptDeadline);
    return 'ok';
  }, deadline);
  assert.equal(result, 'ok');
  assert.deepEqual(attemptDeadlines, [deadline]);
});

test('OpenAI retries early 429 and 5xx failures inside the unchanged overall deadline', async () => {
  for (const status of [429, 503]) {
    const provider = createProvider(async () => completed({ answer:'ok' }), { maxRetries:1 });
    const deadline = Date.now() + 10_000;
    const attemptDeadlines = [];
    let calls = 0;
    const result = await provider.executeWithRetry(async (attemptDeadline) => {
      attemptDeadlines.push(attemptDeadline);
      calls += 1;
      if (calls === 1) throw provider.httpError(status);
      return 'ok';
    }, deadline);
    assert.equal(result, 'ok');
    assert.deepEqual(attemptDeadlines, [deadline, deadline]);
  }
});

test('OpenAI does not retry after the overall deadline is exhausted', async () => {
  const provider = createProvider(async () => completed({ answer:'ok' }), { maxRetries:1 });
  let calls = 0;
  await assert.rejects(provider.executeWithRetry(async () => {
    calls += 1;
    throw new AIProviderError(AI_ERROR_CODES.AI_TIMEOUT, 'timed out', { retryable:true });
  }, Date.now()), (error) => error.code === AI_ERROR_CODES.AI_TIMEOUT);
  assert.equal(calls, 1);
});

test('factory selects OpenAI explicitly without fallback and chooses purpose models', () => {
  const config = loadV2Config({ AI_PROVIDER:'openai', AI_TIMEOUT_CLINICAL_RESEARCH_MS:'90000' });
  const provider = createAIProvider({ config, env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: async () => completed({}) });
  assert.ok(provider instanceof OpenAIProvider);
  assert.strictEqual(provider.model, 'gpt-5.6-luna');
  const research = createAIProvider({ config, env: { OPENAI_API_KEY: 'test-key' }, modelPurpose: 'clinical_research' });
  assert.strictEqual(research.model, 'gpt-5.6-sol');
  assert.strictEqual(research.reasoningEffort, 'high');
  assert.strictEqual(research.timeoutMs, 90000);
  assert.throws(() => createAIProvider({ config: { ai: { ...config.ai, provider: 'unknown' } } }), (error) => error.code === AI_ERROR_CODES.AI_UNAVAILABLE);
});

test('factory routes Pharmacist and Clinical Research to OpenAI while other ordinary AI remains on Gemini', () => {
  const config = loadV2Config({
    AI_PROVIDER:'gemini', AI_PROVIDER_PHARMACIST:'openai', AI_PROVIDER_CLINICAL_RESEARCH:'openai',
    AI_MODEL_DOCUMENT:'gpt-5.6-luna', AI_MODEL_EXPLANATION:'gpt-5.6-terra',
    AI_MODEL_PHARMACIST:'gpt-5.6-terra', AI_MODEL_CLINICAL_RESEARCH:'gpt-5.6-sol',
    AI_TIMEOUT_PHARMACIST_MS:'45000', AI_TIMEOUT_CLINICAL_RESEARCH_MS:'90000',
  });
  const ordinary = createAIProvider({ config, env:{ GEMINI_API_KEY:'test-gemini' } });
  const explanation = createAIProvider({ config, modelPurpose:'explanation', env:{ GEMINI_API_KEY:'test-gemini' } });
  const pharmacist = createAIProvider({
    config, modelPurpose:'pharmacist', env:{ OPENAI_API_KEY:'test-openai' },
  });
  const research = createAIProvider({
    config, providerName:config.ai.clinicalResearchProvider,
    modelPurpose:'clinical_research', env:{ OPENAI_API_KEY:'test-openai' },
  });
  assert.strictEqual(ordinary.constructor.name, 'GeminiProvider');
  assert.strictEqual(explanation.constructor.name, 'GeminiProvider');
  assert.strictEqual(ordinary.configuredModel, '');
  assert.ok(pharmacist instanceof OpenAIProvider);
  assert.strictEqual(pharmacist.model, 'gpt-5.6-terra');
  assert.strictEqual(pharmacist.timeoutMs, 45000);
  assert.ok(research instanceof OpenAIProvider);
  assert.strictEqual(research.model, 'gpt-5.6-sol');
  assert.strictEqual(research.timeoutMs, 90000);
});

test('absent Pharmacist override falls back to global provider without failure fallback', async () => {
  const compatible = loadV2Config({ AI_PROVIDER:'gemini', GEMINI_MODEL_PHARMACIST:'gemini-pharmacist' });
  const legacy = createAIProvider({
    config:compatible, modelPurpose:'pharmacist', env:{ GEMINI_API_KEY:'test-gemini' },
  });
  assert.strictEqual(legacy.constructor.name, 'GeminiProvider');
  assert.strictEqual(legacy.configuredModel, 'models/gemini-pharmacist');

  let fetchCalls = 0;
  const isolated = loadV2Config({ AI_PROVIDER:'gemini', AI_PROVIDER_PHARMACIST:'openai' });
  const selected = createAIProvider({
    config:isolated, modelPurpose:'pharmacist', env:{ GEMINI_API_KEY:'test-gemini' },
    fetchImpl:async () => { fetchCalls += 1; return completed({}); },
  });
  assert.ok(selected instanceof OpenAIProvider);
  await assert.rejects(generate(selected), (error) => error.code === AI_ERROR_CODES.AI_UNAVAILABLE);
  assert.equal(fetchCalls, 0);
});

test('Pharmacist OpenAI failure never falls back to the configured Gemini provider', async () => {
  const urls = [];
  const config = loadV2Config({
    AI_PROVIDER:'gemini', AI_PROVIDER_PHARMACIST:'openai', AI_MAX_RETRIES:'0',
  });
  const provider = createAIProvider({
    config, modelPurpose:'pharmacist',
    env:{ OPENAI_API_KEY:'test-openai', GEMINI_API_KEY:'test-gemini' },
    fetchImpl:async (url) => { urls.push(url); return response(503, {}); },
  });
  await assert.rejects(generate(provider), (error) => error.code === AI_ERROR_CODES.AI_PROVIDER_ERROR);
  assert.deepEqual(urls, [OPENAI_RESPONSES_URL]);
});

test('missing OpenAI key fails closed without invoking fetch', async () => {
  let called = false;
  const provider = createProvider(async () => { called = true; return completed({ answer: 'ok' }); }, { apiKey: '' });
  await assert.rejects(generate(provider), (error) => error.code === AI_ERROR_CODES.AI_UNAVAILABLE);
  assert.strictEqual(called, false);
});

test('provider errors and logs never expose response body, prompt, context or key', async () => {
  const logs = [];
  const provider = createProvider(async () => response(400, { error: { message: 'raw patient and secret response' } }), { logger: (event) => logs.push(event) });
  await assert.rejects(generate(provider), (error) => {
    assert.doesNotMatch(error.message, /patient|secret response|private user|patient-context|sk-private/);
    return true;
  });
  assert.doesNotMatch(JSON.stringify(logs), /patient|secret response|private user|patient-context|sk-private/);
});
