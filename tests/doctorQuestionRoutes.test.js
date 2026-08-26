const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';

const { requireAuth } = require('../backend/middleware/auth');
const {
  createDoctorQuestionsRouter, parseRateLimit,
} = require('../backend/routes/doctorQuestions');
const { PlusEntitlementError } = require('../backend/services/plusEntitlementService');

async function withApi(overrides, callback) {
  const app = express();
  app.use(express.json());
  app.use('/api/care-profile', createDoctorQuestionsRouter({
    requireAuth,
    rateLimiter: { checkAndRecord: () => ({ allowed: true, remaining: 9, retryAfterMs: 0 }) },
    ...overrides,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (route, options = {}, lineUserId = 'U-FAMILY') => fetch(`${base}${route}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(lineUserId ? { 'X-Line-User-Id': lineUserId } : {}),
      ...(options.headers || {}),
    },
  });
  try { await callback(api); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('doctor question route derives identity from verified auth and forwards only appointment focus and center scope', async () => {
  let seen;
  await withApi({
    async doctorQuestionService(input) {
      seen = input;
      return { status: 'questions', questions: [] };
    },
  }, async (api) => {
    const response = await api('/api/care-profile/CP-1/doctor-questions?centerId=CTR-1', {
      method: 'POST', body: JSON.stringify({ appointmentId: 'APT-1', focus: 'อยากถามเรื่องยา' }),
    }, 'U-OWNER');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-ratelimit-remaining'), '9');
  });
  assert.deepEqual(seen, {
    careProfileId: 'CP-1', lineUserId: 'U-OWNER', centerId: 'CTR-1',
    appointmentId: 'APT-1', focus: 'อยากถามเรื่องยา',
  });
});

test('frontend cannot inject context provider actor entitlement or generated output', async () => {
  let calls = 0;
  await withApi({ async doctorQuestionService() { calls += 1; return { status: 'questions' }; } }, async (api) => {
    for (const field of ['context', 'provider', 'lineUserId', 'questions', 'entitlement']) {
      const response = await api('/api/care-profile/CP-1/doctor-questions', {
        method: 'POST', body: JSON.stringify({ [field]: 'evil' }),
      });
      assert.equal(response.status, 400);
    }
  });
  assert.equal(calls, 0);
});

test('endpoint requires verified LINE authentication and validates profile appointment and query identifiers', async () => {
  await withApi({ async doctorQuestionService() { return { status: 'questions' }; } }, async (api) => {
    assert.equal((await api('/api/care-profile/CP-1/doctor-questions', { method: 'POST', body: '{}' }, null)).status, 401);
    assert.equal((await api('/api/care-profile/bad%20id/doctor-questions', { method: 'POST', body: '{}' })).status, 400);
    assert.equal((await api('/api/care-profile/CP-1/doctor-questions?actor=evil', { method: 'POST', body: '{}' })).status, 400);
    assert.equal((await api('/api/care-profile/CP-1/doctor-questions', {
      method: 'POST', body: JSON.stringify({ appointmentId: '../other' }),
    })).status, 400);
  });
});

test('Plus denial and provider failure use safe response envelopes', async () => {
  await withApi({
    async doctorQuestionService() { throw new PlusEntitlementError('PLUS_FEATURE_NOT_INCLUDED'); },
  }, async (api) => {
    const response = await api('/api/care-profile/CP-1/doctor-questions', { method: 'POST', body: '{}' });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.errorCode, 'PLUS_FEATURE_NOT_INCLUDED');
    assert.equal(JSON.stringify(body).includes('database'), false);
  });
  await withApi({
    async doctorQuestionService() { return { status: 'unavailable', errorCode: 'AI_TIMEOUT', message: 'safe' }; },
  }, async (api) => {
    const response = await api('/api/care-profile/CP-1/doctor-questions', { method: 'POST', body: '{}' });
    assert.equal(response.status, 503);
    assert.equal(JSON.stringify(await response.json()).includes('provider secret'), false);
  });
});

test('generation rate limit returns safe Retry-After and malformed config falls back', async () => {
  await withApi({
    rateLimiter: { checkAndRecord: () => ({ allowed: false, remaining: 0, retryAfterMs: 2500 }) },
    async doctorQuestionService() { throw new Error('must not run'); },
  }, async (api) => {
    const response = await api('/api/care-profile/CP-1/doctor-questions', { method: 'POST', body: '{}' });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '3');
    assert.equal((await response.json()).errorCode, 'PLUS_RATE_LIMITED');
  });
  assert.equal(parseRateLimit('bad'), 10);
  assert.equal(parseRateLimit('0'), 10);
  assert.equal(parseRateLimit('12'), 12);
});

test('emergency focus reaches approved safety response even when generation limit is exhausted', async () => {
  let calls = 0;
  await withApi({
    rateLimiter: { checkAndRecord: () => ({ allowed: false, remaining: 0, retryAfterMs: 60000 }) },
    async doctorQuestionService(input) {
      calls += 1;
      assert.equal(input.focus, 'หายใจไม่ออก');
      return { status: 'escalation', reasonCode: 'POSSIBLE_EMERGENCY', message: 'ติดต่อบริการฉุกเฉินทันที' };
    },
  }, async (api) => {
    const response = await api('/api/care-profile/CP-1/doctor-questions', {
      method: 'POST', body: JSON.stringify({ focus: 'หายใจไม่ออก' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'escalation');
  });
  assert.equal(calls, 1);
});
