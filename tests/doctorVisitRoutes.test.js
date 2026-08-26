const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';

const { requireAuth } = require('../backend/middleware/auth');
const { createDoctorVisitsRouter } = require('../backend/routes/doctorVisits');
const { DoctorVisitDomainError } = require('../backend/domain/doctorVisit');

function recordService(overrides = {}) {
  const record = { visitRecordId: 'DVR-1', status: 'draft', sourceText: 'ข้อความ', items: [] };
  return {
    async listRecords() { return { items: [], nextCursor: null }; },
    async createDraft() { return record; },
    async getRecord() { return record; },
    async updateDraft() { return record; },
    async confirmDraft() { return { ...record, status: 'confirmed' }; },
    async createCorrectionDraft() { return { ...record, visitRecordId: 'DVR-2', versionNo: 2 }; },
    async voidRecord() { return { ...record, status: 'voided' }; },
    ...overrides,
  };
}

async function withApi({ service = recordService(), organizationService = async () => ({ status: 'draft', record: { status: 'draft' } }), limiter } = {}, callback) {
  const app = express(); app.use(express.json());
  app.use('/api/care-profile', createDoctorVisitsRouter({
    requireAuth, doctorVisitService: service, organizationService,
    ...(limiter ? { rateLimiter: limiter, rateLimit: 1 } : {}),
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

test('doctor visit routes require verified LINE authentication', async () => {
  await withApi({}, async (api) => {
    assert.equal((await api('/api/care-profile/CP-1/doctor-visits', {}, null)).status, 401);
  });
});

test('manual create derives actor identity from auth and cannot trust frontend confirmation metadata', async () => {
  let seen;
  await withApi({ service: recordService({ async createDraft(input) { seen = input; return { status: 'draft' }; } }) }, async (api) => {
    const response = await api('/api/care-profile/CP-1/doctor-visits/drafts', {
      method: 'POST', body: JSON.stringify({ sourceText: 'หมอบอกให้ติดตาม', confirmedByActorType: 'system_admin' }),
    }, 'U-OWNER');
    assert.equal(response.status, 201);
  });
  assert.equal(seen.lineUserId, 'U-OWNER'); assert.equal(seen.careProfileId, 'CP-1');
  assert.equal('actorType' in seen, false); assert.equal(seen.input.confirmedByActorType, 'system_admin');
});

test('list supports bounded history options and forwards fresh identity scope', async () => {
  let seen;
  await withApi({ service: recordService({ async listRecords(input) { seen = input; return { items: [], nextCursor: null }; } }) }, async (api) => {
    assert.equal((await api('/api/care-profile/CP-1/doctor-visits?includeDrafts=true&includeHistory=true&limit=10&cursor=opaque')).status, 200);
  });
  assert.deepEqual(seen, {
    careProfileId: 'CP-1', lineUserId: 'U-FAMILY', centerId: null,
    includeDrafts: true, includeHistory: true, limit: '10', cursor: 'opaque',
  });
});

test('confirm correction and void accept only explicit safe input', async () => {
  let calls = 0;
  await withApi({ service: recordService({
    async confirmDraft() { calls += 1; return { status: 'confirmed' }; },
    async createCorrectionDraft() { calls += 1; return { status: 'draft' }; },
    async voidRecord() { calls += 1; return { status: 'voided' }; },
  }) }, async (api) => {
    assert.equal((await api('/api/care-profile/CP-1/doctor-visits/DVR-1/confirm', { method: 'POST', body: '{}' })).status, 200);
    assert.equal((await api('/api/care-profile/CP-1/doctor-visits/DVR-1/confirm', { method: 'POST', body: JSON.stringify({ actor: 'admin' }) })).status, 400);
    assert.equal((await api('/api/care-profile/CP-1/doctor-visits/DVR-1/corrections', { method: 'POST', body: JSON.stringify({ reason: 'แก้ไข' }) })).status, 201);
    assert.equal((await api('/api/care-profile/CP-1/doctor-visits/DVR-1/void', { method: 'POST', body: JSON.stringify({ reason: 'ผิดคน' }) })).status, 200);
  });
  assert.equal(calls, 3);
});

test('AI organization route is Plus-rate-limited with safe Retry-After', async () => {
  const limiter = { checkAndRecord: (() => { let count = 0; return () => (++count === 1
    ? { allowed: true, remaining: 0, retryAfterMs: 0 }
    : { allowed: false, remaining: 0, retryAfterMs: 1200 }); })() };
  let calls = 0;
  await withApi({ limiter, organizationService: async () => { calls += 1; return { status: 'draft', record: {} }; } }, async (api) => {
    const first = await api('/api/care-profile/CP-1/doctor-visits/DVR-1/organize', { method: 'POST', body: '{}' });
    const second = await api('/api/care-profile/CP-1/doctor-visits/DVR-1/organize', { method: 'POST', body: '{}' });
    assert.equal(first.status, 200); assert.equal(second.status, 429);
    assert.equal(second.headers.get('Retry-After'), '2');
  });
  assert.equal(calls, 1);
});

test('manual API remains available independently from AI unavailable response', async () => {
  await withApi({ organizationService: async () => ({ status: 'unavailable', errorCode: 'AI_TIMEOUT' }) }, async (api) => {
    assert.equal((await api('/api/care-profile/CP-1/doctor-visits/drafts', { method: 'POST', body: JSON.stringify({ sourceText: 'บันทึกเอง' }) })).status, 201);
    assert.equal((await api('/api/care-profile/CP-1/doctor-visits/DVR-1/organize', { method: 'POST', body: '{}' })).status, 503);
  });
});

test('invalid identifiers and unknown query fields fail before service access', async () => {
  let calls = 0;
  await withApi({ service: recordService({ async listRecords() { calls += 1; return { items: [] }; } }) }, async (api) => {
    assert.equal((await api('/api/care-profile/bad%20id/doctor-visits')).status, 400);
    assert.equal((await api('/api/care-profile/CP-1/doctor-visits?secret=true')).status, 400);
  });
  assert.equal(calls, 0);
});

test('route errors never expose SQL stack actor identity or clinical source text', async () => {
  await withApi({ service: recordService({ async getRecord() { throw new Error('SELECT source_text WHERE actor=U-SECRET หมอให้หยุดยา'); } }) }, async (api) => {
    const response = await api('/api/care-profile/CP-1/doctor-visits/DVR-1');
    assert.equal(response.status, 503);
    assert.doesNotMatch(JSON.stringify(await response.json()), /SELECT|source_text|U-SECRET|หยุดยา|stack/i);
  });
  await withApi({ service: recordService({ async getRecord() { throw new DoctorVisitDomainError('RECORD_NOT_FOUND'); } }) }, async (api) => {
    assert.equal((await api('/api/care-profile/CP-1/doctor-visits/DVR-1')).status, 404);
  });
});

test('production server mounts doctor visit routes in the existing app', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '..', 'backend', 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/routes\/doctorVisits'\)/);
  assert.match(server, /app\.use\('\/api\/care-profile', doctorVisitsRouter\)/);
  assert.equal((server.match(/const app = express\(\)/g) || []).length, 1);
});
