const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { GeminiProvider } = require('../backend/providers/GeminiProvider');
const { AI_ERROR_CODES } = require('../backend/providers/aiErrors');
const { validateDocumentResult } = require('../backend/providers/documentAI');
const aiProvider = require('../backend/providers/aiProvider');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

function providerResult(value) {
  return response(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
}

function medical(overrides = {}) {
  return {
    documentType: 'medical', unrelatedNote: '', nameGuess: 'สมชาย ใจดี', nameConfidence: 0.9,
    appointment: null, medications: [], doctorNote: null, ...overrides,
  };
}

function createProvider(fetchImpl, options = {}) {
  return new GeminiProvider({
    apiKey: 'secret-test-key', model: 'gemini-test', timeoutMs: 100, maxRetries: 0,
    fetchImpl, retryDelayMs: 0, ...options,
  });
}

async function generate(provider) {
  return provider.generateStructured({
    task: 'document_interpretation', systemInstructions: 'medical prompt',
    input: { imageBuffer: Buffer.from('private-health-image'), imageMimeType: 'image/jpeg' },
    outputSchema: validateDocumentResult,
  });
}

test('Gemini structured document succeeds', async () => {
  const result = await generate(createProvider(async () => providerResult(medical())));
  assert.equal(result.documentType, 'medical');
  assert.equal(result.nameGuess, 'สมชาย ใจดี');
});

test('unrelated document is a validated domain result, not a provider failure', async () => {
  const result = await generate(createProvider(async () => providerResult({ documentType: 'unrelated', unrelatedNote: 'เป็นรูปอาหาร' })));
  assert.equal(result.documentType, 'unrelated');
  assert.equal(result.domainCode, AI_ERROR_CODES.UNRELATED_DOCUMENT);
});

test('request timeout maps to AI_TIMEOUT', async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(generate(createProvider(fetchImpl, { timeoutMs: 10 })), (error) => error.code === AI_ERROR_CODES.AI_TIMEOUT);
});

test('a transient timeout retries within the single total timeout budget', async () => {
  let calls = 0;
  const fetchImpl = async (_url, { signal }) => {
    calls += 1;
    if (calls > 1) return providerResult(medical());
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  const result = await generate(createProvider(fetchImpl, { timeoutMs: 80, maxRetries: 1 }));
  assert.equal(result.documentType, 'medical');
  assert.equal(calls, 2);
});

test('HTTP 429 maps to AI_RATE_LIMIT', async () => {
  await assert.rejects(generate(createProvider(async () => response(429, {}))), (error) => error.code === AI_ERROR_CODES.AI_RATE_LIMIT);
});

test('rate limit is retried only within configured policy', async () => {
  let calls = 0;
  const provider = createProvider(async () => {
    calls += 1;
    return calls === 1 ? response(429, {}) : providerResult(medical());
  }, { maxRetries: 1 });
  assert.equal((await generate(provider)).documentType, 'medical');
  assert.equal(calls, 2);
});

test('provider 5xx maps to AI_PROVIDER_ERROR', async () => {
  await assert.rejects(generate(createProvider(async () => response(503, {}))), (error) => error.code === AI_ERROR_CODES.AI_PROVIDER_ERROR);
});

test('invalid JSON maps to AI_INVALID_RESPONSE without retry', async () => {
  let calls = 0;
  const provider = createProvider(async () => {
    calls += 1;
    return response(200, { candidates: [{ content: { parts: [{ text: '{bad json}' }] } }] });
  }, { maxRetries: 3 });
  await assert.rejects(generate(provider), (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
  assert.equal(calls, 1);
});

test('missing required fields maps to AI_INVALID_RESPONSE', async () => {
  await assert.rejects(generate(createProvider(async () => providerResult({ documentType: 'medical' }))), (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
});

test('API failure never becomes unrelated document through compatibility facade', async () => {
  aiProvider.clearMockQueue();
  aiProvider.setProviderForTests({
    async generateStructured() { throw Object.assign(new Error('provider unavailable'), { code: AI_ERROR_CODES.AI_UNAVAILABLE }); },
  });
  await assert.rejects(aiProvider.interpretDocument(Buffer.from('image')), (error) => {
    assert.equal(error.code, AI_ERROR_CODES.AI_UNAVAILABLE);
    assert.notEqual(error.documentType, 'unrelated');
    return true;
  });
  aiProvider.clearMockQueue();
});

test('transient failures retry and then succeed', async () => {
  let calls = 0;
  const provider = createProvider(async () => {
    calls += 1;
    return calls === 1 ? response(503, {}) : providerResult(medical());
  }, { maxRetries: 1 });
  assert.equal((await generate(provider)).documentType, 'medical');
  assert.equal(calls, 2);
});

test('retry count never exceeds configured maximum', async () => {
  let calls = 0;
  const provider = createProvider(async () => { calls += 1; return response(503, {}); }, { maxRetries: 2 });
  await assert.rejects(generate(provider), (error) => error.code === AI_ERROR_CODES.AI_PROVIDER_ERROR);
  assert.equal(calls, 3);
});

test('model discovery keeps legacy selection order and is cached', async () => {
  let listCalls = 0;
  let generationCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/models?')) {
      listCalls += 1;
      return response(200, { models: [
        { name: 'models/gemini-fallback', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-pro', supportedGenerationMethods: ['generateContent'] },
      ] });
    }
    generationCalls += 1;
    assert.match(url, /models\/gemini-3\.5-pro:generateContent/);
    return providerResult(medical());
  };
  const provider = createProvider(fetchImpl, { model: '' });
  await generate(provider);
  await generate(provider);
  assert.equal(listCalls, 1);
  assert.equal(generationCalls, 2);
});

test('logs contain metadata only and exclude secrets, prompt and health payload', async () => {
  const events = [];
  const provider = createProvider(async () => providerResult(medical()), { logger: (event) => events.push(event) });
  await generate(provider);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /secret-test-key/);
  assert.doesNotMatch(serialized, /private-health-image/);
  assert.doesNotMatch(serialized, /medical prompt/);
  assert.deepEqual(Object.keys(events[0]).sort(), ['durationMs', 'model', 'provider', 'requestId', 'resultStatus', 'task'].sort());
});
