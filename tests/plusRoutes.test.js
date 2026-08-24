const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';

const db = require('../backend/db');
const { createPlusRouter, parseRateLimit } = require('../backend/routes/plus');
const { createPlusOrchestrator } = require('../backend/services/plusOrchestrationService');
const { AIProviderError, AI_ERROR_CODES } = require('../backend/providers/aiErrors');

const ENABLED_FLAGS = {
  plus: {
    enabled: true, internalEntitlementOnly: true, aiExplanation: true,
    medicationDiff: true, pharmacistEscalation: false,
  },
};
const DISABLED_FLAGS = { plus: { ...ENABLED_FLAGS.plus, enabled: false } };

test.beforeEach(() => db.resetAll());

function activeEntitlement(overrides = {}) {
  return {
    allowed: true, planCode: 'family_plus', source: 'internal', status: 'active',
    startsAt: '2026-08-01T00:00:00.000Z', expiresAt: '2099-09-01T00:00:00.000Z',
    features: ['*'], ...overrides,
  };
}

function noLimit() {
  return { checkAndRecord: () => ({ allowed: true, remaining: 9, retryAfterMs: 0 }) };
}

async function withApi(overrides, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/plus', createPlusRouter({ rateLimiter: noLimit(), ...overrides }));
  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(500).json({ status: 'unavailable', errorCode: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาดในระบบ' });
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const api = (path, options = {}, lineUserId = 'U-1') => fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(lineUserId ? { 'X-Line-User-Id': lineUserId } : {}),
      ...(options.headers || {}),
    },
  });
  try { await fn(api); } finally { await new Promise((resolve) => server.close(resolve)); }
}

async function seed(ownerLineId = 'U-1') {
  await db.CareProfiles.insert({
    care_profile_id: 'CP-1', owner_line_id: ownerLineId, patient_name: 'คุณแม่', status: 'independent',
    chronic_conditions: ['เบาหวาน'], drug_allergies: 'Penicillin', phone: '0812345678', raw_image: 'PRIVATE-IMAGE',
  });
  await db.MedicationSnapshots.insert({
    snapshot_id: 'S-1', care_profile_id: 'CP-1', recorded_at: '2026-08-20T00:00:00Z',
    items: [{ name: 'Metformin', dose: '500 mg', instruction: 'หลังอาหาร' }], source_image_base64: 'PRIVATE-IMAGE',
  });
  await db.Appointments.insert({
    appointment_id: 'A-1', care_profile_id: 'CP-1', datetime: '2099-09-01T09:00:00Z',
    status: 'confirmed', hospital: 'โรงพยาบาลกลาง', reason_for_visit: 'ติดตามอาการ',
  });
}

function explanationProvider({ error = null } = {}) {
  const calls = [];
  return {
    calls,
    provider: {
      async generateStructured(request) {
        calls.push(request);
        if (error) throw error;
        return { summary: 'สรุปข้อมูล', keyPoints: ['ข้อมูลที่บันทึก'], missingInformation: [], disclaimer: 'ไม่ใช่คำวินิจฉัย' };
      },
    },
  };
}

function realOrchestration(provider) {
  return createPlusOrchestrator({
    flags: ENABLED_FLAGS,
    config: { ai: { provider: 'gemini', explanationModel: 'test-model', timeoutMs: 2000 } },
    provider,
    getPlusEntitlement: async () => activeEntitlement(),
    recordAudit: async () => ({ recorded: true }),
  });
}

test('unauthenticated Plus request is denied before feature handling', async () => {
  await withApi({ flags: ENABLED_FLAGS, getPlusEntitlement: async () => activeEntitlement() }, async (api) => {
    const response = await api('/api/plus/entitlement', {}, null);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'unauthorized');
  });
});

test('invalid Plus rate-limit configuration falls back to conservative default', () => {
  assert.equal(parseRateLimit('not-a-number'), 10);
  assert.equal(parseRateLimit('0'), 10);
  assert.equal(parseRateLimit('101'), 10);
  assert.equal(parseRateLimit('7'), 7);
});

test('Plus router is mounted by the real server while remaining disabled by default', async () => {
  const previous = process.env.PLUS_ENABLED;
  process.env.PLUS_ENABLED = 'false';
  const app = require('../backend/server');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/plus/entitlement`, { headers: { 'X-Line-User-Id': 'U-1' } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).errorCode, 'PLUS_DISABLED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.PLUS_ENABLED;
    else process.env.PLUS_ENABLED = previous;
  }
});

test('PLUS_ENABLED=false returns structured unavailable and calls no entitlement, context, or provider', async () => {
  let entitlementCalls = 0; let orchestratorCalls = 0;
  await withApi({
    flags: DISABLED_FLAGS,
    getPlusEntitlement: async () => { entitlementCalls += 1; return activeEntitlement(); },
    handlePlusRequest: async () => { orchestratorCalls += 1; return { action: 'answer' }; },
  }, async (api) => {
    const response = await api('/api/plus/care-profiles/CP-1/ask', { method: 'POST', body: JSON.stringify({ question: 'ช่วยสรุปข้อมูล' }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).errorCode, 'PLUS_DISABLED');
    assert.equal(entitlementCalls, 0);
    assert.equal(orchestratorCalls, 0);
  });
});

test('Basic user receives internal-test upgrade response and cannot reach Care Profile data', async () => {
  let authorizationCalls = 0;
  await withApi({
    flags: ENABLED_FLAGS,
    getPlusEntitlement: async () => ({ allowed: false, reasonCode: 'NO_PLUS_ENTITLEMENT' }),
    authorizeCareProfileAccess: async () => { authorizationCalls += 1; },
  }, async (api) => {
    const response = await api('/api/plus/care-profiles/CP-1/ask', { method: 'POST', body: JSON.stringify({ question: 'ช่วยสรุปข้อมูล' }) });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.status, 'upgrade_required');
    assert.equal(body.upgradeAvailable, false);
    assert.equal(authorizationCalls, 0);
  });
});

for (const reasonCode of ['ENTITLEMENT_EXPIRED', 'ENTITLEMENT_SUSPENDED']) {
  test(`${reasonCode} entitlement is denied`, async () => {
    await withApi({ flags: ENABLED_FLAGS, getPlusEntitlement: async () => ({ allowed: false, reasonCode }) }, async (api) => {
      const response = await api('/api/plus/care-profiles/CP-1/ask', { method: 'POST', body: JSON.stringify({ question: 'ช่วยสรุปข้อมูล' }) });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).errorCode, reasonCode);
    });
  });
}

test('active internal Plus user can retrieve entitlement status', async () => {
  await withApi({ flags: ENABLED_FLAGS, getPlusEntitlement: async () => activeEntitlement() }, async (api) => {
    const response = await api('/api/plus/entitlement');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'active');
    assert.equal(body.source, 'internal');
  });
});

test('non-internal entitlement is rejected while internal-only mode is enabled', async () => {
  await withApi({ flags: ENABLED_FLAGS, getPlusEntitlement: async () => activeEntitlement({ source: 'promotion' }) }, async (api) => {
    const entitlementResponse = await api('/api/plus/entitlement');
    assert.equal(entitlementResponse.status, 403);
    assert.equal((await entitlementResponse.json()).errorCode, 'INTERNAL_ENTITLEMENT_REQUIRED');
    const response = await api('/api/plus/care-profiles/CP-1/ask', { method: 'POST', body: JSON.stringify({ question: 'ช่วยสรุปข้อมูล' }) });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).errorCode, 'INTERNAL_ENTITLEMENT_REQUIRED');
  });
});

for (const [name, path, body, code] of [
  ['empty question', '/api/plus/care-profiles/CP-1/ask', { question: '   ' }, 'QUESTION_REQUIRED'],
  ['oversized question', '/api/plus/care-profiles/CP-1/ask', { question: 'ก'.repeat(4001) }, 'INVALID_QUESTION'],
  ['invalid Care Profile id', '/api/plus/care-profiles/CP!1/ask', { question: 'ช่วยสรุปข้อมูล' }, 'INVALID_CARE_PROFILE_ID'],
  ['invalid purpose hint', '/api/plus/care-profiles/CP-1/ask', { question: 'ช่วยสรุปข้อมูล', purposeHint: 'arbitrary_prompt' }, 'INVALID_PURPOSE_HINT'],
]) {
  test(`${name} is rejected before orchestration`, async () => {
    let calls = 0;
    await withApi({
      flags: ENABLED_FLAGS, getPlusEntitlement: async () => activeEntitlement(),
      handlePlusRequest: async () => { calls += 1; return { action: 'answer' }; },
    }, async (api) => {
      const response = await api(path, { method: 'POST', body: JSON.stringify(body) });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).errorCode, code);
      assert.equal(calls, 0);
    });
  });
}

test('cross-profile requester is denied before orchestration', async () => {
  await seed('U-OWNER');
  let calls = 0;
  await withApi({
    flags: ENABLED_FLAGS, getPlusEntitlement: async () => activeEntitlement(),
    handlePlusRequest: async () => { calls += 1; return { action: 'answer' }; },
  }, async (api) => {
    const response = await api('/api/plus/care-profiles/CP-1/ask', { method: 'POST', body: JSON.stringify({ question: 'ช่วยสรุปข้อมูล' }) }, 'U-OTHER');
    assert.equal(response.status, 403);
    assert.equal((await response.json()).errorCode, 'ACCESS_DENIED');
    assert.equal(calls, 0);
  });
});

test('risky medication question returns pharmacist escalation with provider zero calls', async () => {
  await seed();
  const ai = explanationProvider();
  await withApi({
    flags: ENABLED_FLAGS, getPlusEntitlement: async () => activeEntitlement(),
    handlePlusRequest: realOrchestration(ai.provider),
  }, async (api) => {
    const response = await api('/api/plus/care-profiles/CP-1/ask', { method: 'POST', body: JSON.stringify({ question: 'กินยาสองตัวนี้ด้วยกันได้ไหม' }) });
    const body = await response.json();
    assert.equal(body.status, 'escalation');
    assert.equal(body.type, 'pharmacist');
    assert.equal(ai.calls.length, 0);
  });
});

test('safe Care Profile summary returns answer envelope', async () => {
  await seed();
  const ai = explanationProvider();
  await withApi({ flags: ENABLED_FLAGS, getPlusEntitlement: async () => activeEntitlement(), handlePlusRequest: realOrchestration(ai.provider) }, async (api) => {
    const response = await api('/api/plus/care-profiles/CP-1/ask', { method: 'POST', body: JSON.stringify({ question: 'ช่วยสรุปข้อมูลคุณแม่' }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'answer');
    assert.equal(body.data.summary, 'สรุปข้อมูล');
  });
});

test('medication retrieval is built server-side and returns answer', async () => {
  await seed();
  const ai = explanationProvider();
  await withApi({ flags: ENABLED_FLAGS, getPlusEntitlement: async () => activeEntitlement(), handlePlusRequest: realOrchestration(ai.provider) }, async (api) => {
    const response = await api('/api/plus/care-profiles/CP-1/ask', { method: 'POST', body: JSON.stringify({ question: 'ตอนนี้มียาอะไรบ้าง' }) });
    assert.equal((await response.json()).purpose, 'medication_summary');
    const context = JSON.parse(ai.calls[0].context);
    assert.equal(context.data.currentSnapshot.snapshotId, 'S-1');
  });
});

test('prepare endpoint accepts appointment belonging to the requested Care Profile', async () => {
  await seed();
  const ai = explanationProvider();
  await withApi({ flags: ENABLED_FLAGS, getPlusEntitlement: async () => activeEntitlement(), handlePlusRequest: realOrchestration(ai.provider) }, async (api) => {
    const response = await api('/api/plus/care-profiles/CP-1/appointments/A-1/prepare', { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).purpose, 'doctor_visit_preparation');
  });
});

test('prepare endpoint denies appointment from a different Care Profile before AI', async () => {
  await seed();
  await db.Appointments.insert({ appointment_id: 'A-OTHER', care_profile_id: 'CP-2', datetime: '2099-09-01T09:00:00Z', status: 'confirmed' });
  let calls = 0;
  await withApi({
    flags: ENABLED_FLAGS, getPlusEntitlement: async () => activeEntitlement(),
    handlePlusRequest: async () => { calls += 1; return { action: 'answer' }; },
  }, async (api) => {
    const response = await api('/api/plus/care-profiles/CP-1/appointments/A-OTHER/prepare', { method: 'POST', body: '{}' });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).errorCode, 'APPOINTMENT_NOT_FOUND');
    assert.equal(calls, 0);
  });
});

test('AI timeout returns safe envelope without raw provider error', async () => {
  await seed();
  const ai = explanationProvider({ error: new AIProviderError(AI_ERROR_CODES.AI_TIMEOUT, 'secret upstream timeout detail') });
  await withApi({ flags: ENABLED_FLAGS, getPlusEntitlement: async () => activeEntitlement(), handlePlusRequest: realOrchestration(ai.provider) }, async (api) => {
    const response = await api('/api/plus/care-profiles/CP-1/ask', { method: 'POST', body: JSON.stringify({ question: 'ช่วยสรุปข้อมูลคุณแม่' }) });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(JSON.parse(text).errorCode, 'AI_TIMEOUT');
    assert.equal(text.includes('secret upstream'), false);
    assert.equal(text.includes('stack'), false);
  });
});

test('Plus rate limit is keyed by authenticated LINE user', async () => {
  const windows = new Map();
  const limiter = {
    checkAndRecord(key, limit) {
      const count = windows.get(key) || 0;
      if (count >= limit) return { allowed: false, remaining: 0, retryAfterMs: 1000 };
      windows.set(key, count + 1);
      return { allowed: true, remaining: limit - count - 1, retryAfterMs: 0 };
    },
  };
  await withApi({
    flags: ENABLED_FLAGS, rateLimiter: limiter, rateLimit: 2,
    getPlusEntitlement: async () => activeEntitlement(),
  }, async (api) => {
    assert.equal((await api('/api/plus/entitlement', {}, 'U-A')).status, 200);
    assert.equal((await api('/api/plus/entitlement', {}, 'U-A')).status, 200);
    assert.equal((await api('/api/plus/entitlement', {}, 'U-A')).status, 429);
    assert.equal((await api('/api/plus/entitlement', {}, 'U-B')).status, 200);
  });
});

for (const injectedField of ['context', 'model', 'systemInstruction']) {
  test(`frontend cannot inject ${injectedField}`, async () => {
    let calls = 0;
    await withApi({
      flags: ENABLED_FLAGS, getPlusEntitlement: async () => activeEntitlement(),
      handlePlusRequest: async () => { calls += 1; return { action: 'answer' }; },
    }, async (api) => {
      const response = await api('/api/plus/care-profiles/CP-1/ask', {
        method: 'POST', body: JSON.stringify({ question: 'ช่วยสรุปข้อมูล', [injectedField]: 'malicious override' }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).errorCode, 'UNSUPPORTED_FIELD');
      assert.equal(calls, 0);
    });
  });
}

test('middleware order is auth, flag, entitlement, Care Profile authorization, orchestration', async () => {
  const order = [];
  await withApi({
    requireAuth(req, res, next) { order.push('auth'); req.user = { lineUserId: 'U-1' }; next(); },
    loadFeatureFlags() { order.push('flag'); return ENABLED_FLAGS; },
    getPlusEntitlement: async () => { order.push('entitlement'); return activeEntitlement(); },
    authorizeCareProfileAccess: async () => { order.push('authorization'); return {}; },
    handlePlusRequest: async () => { order.push('orchestration'); return { action: 'answer', intent: 'summarize', purpose: 'care_profile_summary', content: explanationProvider().provider }; },
  }, async (api) => {
    const response = await api('/api/plus/care-profiles/CP-1/ask', { method: 'POST', body: JSON.stringify({ question: 'ช่วยสรุปข้อมูล' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(order, ['auth', 'flag', 'entitlement', 'authorization', 'orchestration']);
  });
});
