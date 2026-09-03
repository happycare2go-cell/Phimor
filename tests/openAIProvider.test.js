const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenAIProvider, OPENAI_RESPONSES_URL } = require('../backend/providers/OpenAIProvider');
const { createAIProvider } = require('../backend/providers/AIProviderFactory');
const { loadV2Config } = require('../backend/config/v2Config');
const { AI_ERROR_CODES } = require('../backend/providers/aiErrors');

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
  }), { webSearch: { allowedDomains: ['WHO.INT', '', 'fda.gov'], maxCalls: 2, searchContextSize: 'low' } });
  assert.deepStrictEqual(body.tools, [{ type: 'web_search', search_context_size: 'low', filters: { allowed_domains: ['who.int', 'fda.gov'] } }]);
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
  const provider = createProvider(async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }), { timeoutMs: 10 });
  await assert.rejects(generate(provider), (error) => error.code === AI_ERROR_CODES.AI_TIMEOUT);
});

test('factory selects OpenAI explicitly without fallback and chooses purpose models', () => {
  const config = loadV2Config({ AI_PROVIDER: 'openai' });
  const provider = createAIProvider({ config, env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: async () => completed({}) });
  assert.ok(provider instanceof OpenAIProvider);
  assert.strictEqual(provider.model, 'gpt-5.6-luna');
  const research = createAIProvider({ config, env: { OPENAI_API_KEY: 'test-key' }, modelPurpose: 'clinical_research' });
  assert.strictEqual(research.model, 'gpt-5.6-sol');
  assert.strictEqual(research.reasoningEffort, 'high');
  assert.throws(() => createAIProvider({ config: { ai: { ...config.ai, provider: 'unknown' } } }), (error) => error.code === AI_ERROR_CODES.AI_UNAVAILABLE);
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
