const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';

const { createPlusRouter } = require('../backend/routes/plus');

const FLAGS = { plus: { enabled: true, paymentEnabled: true, internalEntitlementOnly: false, aiExplanation: true, medicationDiff: true, pharmacistEscalation: false } };
function noLimit() { return { checkAndRecord: () => ({ allowed: true, remaining: 9, retryAfterMs: 0 }) }; }

async function withApi(service, run, overrides = {}) {
  const app = express(); app.use(express.json());
  app.use('/api/plus', createPlusRouter({ flags: FLAGS, plusPaymentService: service, rateLimiter: noLimit(), getPlusEntitlement: async ({ lineUserId }) => lineUserId === 'U-A' ? { allowed: false, reasonCode: 'NO_PLUS_ENTITLEMENT' } : { allowed: false, reasonCode: 'NO_PLUS_ENTITLEMENT' }, ...overrides }));
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, resolve));
  const api = (path, options = {}, actor = 'U-A') => fetch(`http://127.0.0.1:${server.address().port}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(actor ? { 'X-Line-User-Id': actor } : {}), ...(options.headers || {}) } });
  try { await run(api); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('offer publishes fixed 59 THB / 30-day manual renewal without future capabilities', async () => {
  await withApi({}, async (api) => {
    const body = await (await api('/api/plus/offer')).json();
    assert.equal(body.amountMinor, 5900); assert.equal(body.durationDays, 30);
    assert.equal(body.automaticRenewal, false); assert.equal(body.renewal, 'manual');
    assert.equal(body.liveCapabilities.includes('monthly_health_summary'), false);
    assert.equal(body.liveCapabilities.includes('smart_reminders'), false);
  });
});

test('Plus routes use the shared limiter domain and fail closed without leaking storage errors', async () => {
  const seen = [];
  await withApi({}, async (api) => {
    const response = await api('/api/plus/offer');
    assert.equal(response.status, 200);
  }, { rateLimiter: { async checkAndRecord(identity, limit, windowMs, options) {
    seen.push({ identity, limit, windowMs, options });
    return { allowed: true, remaining: 8, retryAfterMs: 0 };
  } } });
  assert.equal(seen[0].identity, 'plus:U-A');
  assert.equal(seen[0].options.domain, 'plus_api');

  await withApi({}, async (api) => {
    const response = await api('/api/plus/offer');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: 'unavailable', errorCode: 'RATE_LIMIT_UNAVAILABLE',
      message: 'Phimor Plus ยังไม่พร้อมใช้งานสำหรับบัญชีนี้',
    });
  }, { rateLimiter: { async checkAndRecord() { throw new Error('database secret'); } } });
});

test('authenticated actor owns Plus order projections and another actor gets no delegated identifier', async () => {
  const calls = [];
  const service = {
    async getCurrent(input) { calls.push(input); return { status: 'none', order: null }; },
    async getHistory(input) { calls.push(input); return { orders: [], nextCursor: null }; },
    async getStatus(input) { calls.push(input); if (input.lineUserId !== 'U-A') { const error = new Error(); error.code = 'PLUS_ORDER_NOT_FOUND'; error.status = 404; throw error; } return { orderId: input.orderId, status: 'payment_pending' }; },
    async createCheckout(input) { calls.push(input); return { orderId: 'PLUSORD-1', status: 'payment_pending', resumed: false }; },
  };
  await withApi(service, async (api) => {
    assert.equal((await api('/api/plus/orders/current', {}, null)).status, 401);
    await api('/api/plus/orders/current', {}, 'U-A');
    assert.equal(calls[0].lineUserId, 'U-A');
    const denied = await api('/api/plus/orders/PLUSORD-1/status', {}, 'U-B');
    assert.equal(denied.status, 404); assert.equal((await denied.json()).errorCode, 'PLUS_ORDER_NOT_FOUND');
  });
});

test('checkout accepts symbolic return targets only and rejects open redirects and clinical fields', async () => {
  let calls = 0;
  const service = { async createCheckout() { calls += 1; return { orderId: 'PLUSORD-1', status: 'payment_pending', resumed: false }; } };
  await withApi(service, async (api) => {
    for (const body of [
      { returnTarget: 'https://evil.example', idempotencyKey: 'key-1' },
      { returnTarget: 'lab_explanation', idempotencyKey: 'key-2', careProfileId: 'CP-SECRET' },
      { returnTarget: 'lab_explanation', idempotencyKey: 'key-3', labId: 'LAB-SECRET' },
    ]) {
      const response = await api('/api/plus/orders', { method: 'POST', body: JSON.stringify(body) });
      assert.equal(response.status, 400);
    }
    assert.equal(calls, 0);
  });
});

test('duplicate checkout service result is returned as resume without creating another payment', async () => {
  const service = { async createCheckout(input) { return { orderId: 'PLUSORD-1', status: 'payment_pending', resumed: true, returnTarget: input.returnTarget }; } };
  await withApi(service, async (api) => {
    const response = await api('/api/plus/orders', { method: 'POST', body: JSON.stringify({ returnTarget: 'doctor_question_prep', idempotencyKey: 'same-device-retry' }) });
    assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.resumed, true); assert.equal(body.returnTarget, 'doctor_question_prep');
  });
});
