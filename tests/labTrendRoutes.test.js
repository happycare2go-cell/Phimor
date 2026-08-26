const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';

const { requireAuth } = require('../backend/middleware/auth');
const { createLabsRouter, parseRateLimit } = require('../backend/routes/labs');
const { PlusEntitlementError } = require('../backend/services/plusEntitlementService');
const rateLimiter = require('../backend/utils/rateLimiter');

function labService() {
  return {
    async listReports() { return { items: [], nextCursor: null }; },
    async createDraft() { return {}; }, async getReport() { return {}; },
    async updateDraft() { return {}; }, async confirmDraft() { return {}; },
    async createCorrectionDraft() { return {}; }, async voidReport() { return {}; },
  };
}

async function withApi(overrides, callback) {
  const app = express(); app.use(express.json());
  app.use('/api/care-profile', createLabsRouter({ requireAuth, labService: labService(), ...overrides }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (route, options = {}, lineUserId = 'U-FAMILY') => fetch(`${base}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(lineUserId ? { 'X-Line-User-Id': lineUserId } : {}), ...(options.headers || {}) },
  });
  try { await callback(api); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('confirmed Lab trend route forwards authenticated profile scope identity and bounded pagination', async () => {
  let seen;
  await withApi({
    async labTrendService(input) { seen = input; return { status: 'available', observations: [], hasMore: false, nextCursor: null }; },
  }, async (api) => {
    const response = await api('/api/care-profile/CP-1/lab-trends?loincCode=4548-4&limit=10&cursor=opaque&centerId=C-1');
    assert.equal(response.status, 200);
  });
  assert.deepEqual(seen, {
    careProfileId: 'CP-1', lineUserId: 'U-FAMILY', centerId: 'C-1',
    identity: { loincCode: '4548-4' }, limit: '10', cursor: 'opaque',
  });
});

test('trend route rejects missing, duplicate or unsupported identity input before service access', async () => {
  let calls = 0;
  await withApi({ async labTrendService() { calls += 1; return {}; } }, async (api) => {
    assert.equal((await api('/api/care-profile/CP-1/lab-trends')).status, 400);
    assert.equal((await api('/api/care-profile/CP-1/lab-trends?loincCode=1&comparisonKey=x')).status, 400);
    assert.equal((await api('/api/care-profile/CP-1/lab-trends?loincCode=1&actorId=evil')).status, 400);
  });
  assert.equal(calls, 0);
});

test('ordinary confirmed trend reads are not consumed by the AI rate limiter', async () => {
  let rateCalls = 0;
  await withApi({
    async labTrendService() { return { status: 'not_comparable', observations: [], hasMore: false }; },
    rateLimiter: { checkAndRecord() { rateCalls += 1; return { allowed: true, remaining: 0, retryAfterMs: 0 }; } },
  }, async (api) => {
    assert.equal((await api('/api/care-profile/CP-1/lab-trends?comparisonKey=hba1c')).status, 200);
  });
  assert.equal(rateCalls, 0);
});

test('Lab explanation route accepts only identity and optional question and derives LINE identity from auth', async () => {
  let seen;
  await withApi({
    async labExplanationService(input) { seen = input; return { status: 'answer', summary: 'safe' }; },
    rateLimiter: { checkAndRecord() { return { allowed: true, remaining: 9, retryAfterMs: 0 }; } },
  }, async (api) => {
    const response = await api('/api/care-profile/CP-1/lab-explanations?centerId=C-1', {
      method: 'POST', body: JSON.stringify({ identity: { comparisonKey: 'hba1c' }, question: 'อธิบายผล' }),
    }, 'U-OWNER');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-ratelimit-remaining'), '9');
  });
  assert.deepEqual(seen, {
    careProfileId: 'CP-1', lineUserId: 'U-OWNER', centerId: 'C-1',
    identity: { comparisonKey: 'hba1c' }, question: 'อธิบายผล',
  });
});

test('explanation request cannot inject clinical context actor provider or AI output', async () => {
  let calls = 0;
  await withApi({
    async labExplanationService() { calls += 1; return { status: 'answer' }; },
  }, async (api) => {
    const response = await api('/api/care-profile/CP-1/lab-explanations', {
      method: 'POST', body: JSON.stringify({ identity: { loincCode: '4548-4' }, provider: 'evil', context: { draft: true } }),
    });
    assert.equal(response.status, 400);
  });
  assert.equal(calls, 0);
});

test('AI explanation rate limit uses safe Retry-After and malformed configuration falls back', async () => {
  rateLimiter.reset();
  await withApi({
    async labExplanationService() { return { status: 'answer' }; },
    explanationRateLimit: 1, explanationRateWindowMs: 60000,
  }, async (api) => {
    const options = { method: 'POST', body: JSON.stringify({ identity: { loincCode: '4548-4' } }) };
    assert.equal((await api('/api/care-profile/CP-1/lab-explanations', options)).status, 200);
    const limited = await api('/api/care-profile/CP-1/lab-explanations', options);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal((await limited.json()).errorCode, 'PLUS_RATE_LIMITED');
  });
  assert.equal(parseRateLimit('bad'), 10);
  assert.equal(parseRateLimit('0'), 10);
  assert.equal(parseRateLimit('12'), 12);
  rateLimiter.reset();
});

test('missing Plus entitlement and provider unavailable use safe response envelopes', async () => {
  await withApi({
    async labExplanationService() { throw new PlusEntitlementError('PLUS_FEATURE_NOT_INCLUDED'); },
    rateLimiter: { checkAndRecord() { return { allowed: true, remaining: 9, retryAfterMs: 0 }; } },
  }, async (api) => {
    const response = await api('/api/care-profile/CP-1/lab-explanations', {
      method: 'POST', body: JSON.stringify({ identity: { loincCode: '4548-4' } }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).errorCode, 'PLUS_FEATURE_NOT_INCLUDED');
  });
  await withApi({
    async labExplanationService() { return { status: 'unavailable', errorCode: 'AI_TIMEOUT', message: 'safe' }; },
    rateLimiter: { checkAndRecord() { return { allowed: true, remaining: 9, retryAfterMs: 0 }; } },
  }, async (api) => {
    const response = await api('/api/care-profile/CP-1/lab-explanations', {
      method: 'POST', body: JSON.stringify({ identity: { loincCode: '4548-4' } }),
    });
    assert.equal(response.status, 503);
    assert.equal(JSON.stringify(await response.json()).includes('provider secret'), false);
  });
});

test('Lab trend and explanation endpoints require verified Family authentication', async () => {
  await withApi({}, async (api) => {
    assert.equal((await api('/api/care-profile/CP-1/lab-trends?loincCode=4548-4', {}, null)).status, 401);
    assert.equal((await api('/api/care-profile/CP-1/lab-explanations', {
      method: 'POST', body: JSON.stringify({ identity: { loincCode: '4548-4' } }),
    }, null)).status, 401);
  });
});
