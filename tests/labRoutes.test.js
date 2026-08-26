const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';

const { requireAuth } = require('../backend/middleware/auth');
const { createLabsRouter } = require('../backend/routes/labs');
const { LabDomainError } = require('../backend/domain/lab');

function labService(overrides = {}) {
  const report = {
    reportId:'LABR-1', reportGroupId:'LABG-1', versionNo:1, status:'draft',
    observations:[], sources:[], events:[],
  };
  return {
    async listReports() { return {items:[],nextCursor:null}; },
    async createDraft() { return report; },
    async getReport() { return report; },
    async updateDraft() { return report; },
    async confirmDraft() { return {...report,status:'confirmed'}; },
    async createCorrectionDraft() { return {...report,reportId:'LABR-2',versionNo:2}; },
    async voidReport() { return {...report,status:'voided'}; },
    ...overrides,
  };
}

async function withApi(service, callback) {
  const app = express(); app.use(express.json());
  app.use('/api/care-profile', createLabsRouter({ requireAuth, labService:service }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (route, options = {}, lineUserId = 'U-FAMILY') => fetch(`${base}${route}`, {
    ...options,
    headers:{'Content-Type':'application/json',...(lineUserId?{'X-Line-User-Id':lineUserId}:{}),...(options.headers||{})},
  });
  try { await callback(api); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('Lab routes require verified LINE authentication', async () => {
  await withApi(labService(), async (api) => {
    assert.equal((await api('/api/care-profile/CP-1/lab-reports', {}, null)).status, 401);
  });
});

test('list route forwards only authenticated identity, profile scope and safe pagination options', async () => {
  let seen;
  await withApi(labService({async listReports(input){seen=input;return {items:[],nextCursor:null};}}), async (api) => {
    const response = await api('/api/care-profile/CP-1/lab-reports?includeDrafts=true&includeHistory=false&limit=10&cursor=opaque&centerId=C-1');
    assert.equal(response.status, 200);
  });
  assert.deepEqual(seen, {
    careProfileId:'CP-1', lineUserId:'U-FAMILY', centerId:'C-1',
    includeDrafts:true, includeHistory:false, limit:'10', cursor:'opaque',
  });
});

test('draft creation derives user identity from authentication and never from request body', async () => {
  let seen;
  await withApi(labService({async createDraft(input){seen=input;return {reportId:'LABR-1',status:'draft'};}}), async (api) => {
    const response = await api('/api/care-profile/CP-1/lab-reports/drafts', {
      method:'POST', body:JSON.stringify({laboratoryName:'Lab',observations:[]}),
    }, 'U-OWNER');
    assert.equal(response.status, 201);
  });
  assert.equal(seen.lineUserId, 'U-OWNER');
  assert.equal(seen.careProfileId, 'CP-1');
  assert.deepEqual(seen.input, {laboratoryName:'Lab',observations:[]});
  assert.equal('actorType' in seen, false); assert.equal('source' in seen, false);
});

test('confirm route accepts no frontend confirmation actor or metadata', async () => {
  let calls = 0;
  await withApi(labService({async confirmDraft(){calls += 1;return {status:'confirmed'};}}), async (api) => {
    const injected = await api('/api/care-profile/CP-1/lab-reports/LABR-1/confirm', {
      method:'POST', body:JSON.stringify({confirmedByActorType:'system_admin'}),
    });
    assert.equal(injected.status, 400);
    const good = await api('/api/care-profile/CP-1/lab-reports/LABR-1/confirm', {
      method:'POST', body:JSON.stringify({}),
    });
    assert.equal(good.status, 200);
  });
  assert.equal(calls, 1);
});

test('correction and void routes allow only the explicit reason input', async () => {
  const seen = [];
  await withApi(labService({
    async createCorrectionDraft(input){seen.push(['correction',input]);return {status:'draft',versionNo:2};},
    async voidReport(input){seen.push(['void',input]);return {status:'voided'};},
  }), async (api) => {
    assert.equal((await api('/api/care-profile/CP-1/lab-reports/LABR-1/corrections', {
      method:'POST', body:JSON.stringify({reason:'แก้ไข',observations:[]}),
    })).status, 400);
    assert.equal((await api('/api/care-profile/CP-1/lab-reports/LABR-1/corrections', {
      method:'POST', body:JSON.stringify({reason:'แก้ไข'}),
    })).status, 201);
    assert.equal((await api('/api/care-profile/CP-1/lab-reports/LABR-1/void', {
      method:'POST', body:JSON.stringify({reason:'เอกสารผิด'}),
    })).status, 200);
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0][1].lineUserId, 'U-FAMILY');
  assert.equal(seen[1][1].reason, 'เอกสารผิด');
});

test('invalid identifiers and malformed boolean parameters fail safely before service access', async () => {
  let calls = 0;
  await withApi(labService({async listReports(){calls += 1;return {items:[]};}}), async (api) => {
    assert.equal((await api('/api/care-profile/bad%20id/lab-reports')).status, 400);
    assert.equal((await api('/api/care-profile/CP-1/lab-reports?includeDrafts=yes')).status, 400);
    assert.equal((await api('/api/care-profile/CP-1/lab-reports/bad%20id')).status, 400);
  });
  assert.equal(calls, 0);
});

test('Lab errors use a safe envelope and do not leak SQL, stack traces or actor identifiers', async () => {
  await withApi(labService({async getReport(){throw new Error('SELECT secret FROM lab WHERE line_user_id=U-SECRET');}}), async (api) => {
    const response = await api('/api/care-profile/CP-1/lab-reports/LABR-1');
    assert.equal(response.status, 503);
    const body = await response.json(); const serialized = JSON.stringify(body);
    assert.equal(body.errorCode, 'LAB_UNAVAILABLE');
    assert.doesNotMatch(serialized, /SELECT|line_user|U-SECRET|stack/i);
  });
  await withApi(labService({async getReport(){throw new LabDomainError('REPORT_NOT_FOUND');}}), async (api) => {
    const response = await api('/api/care-profile/CP-1/lab-reports/LABR-1');
    assert.equal(response.status, 404); assert.equal((await response.json()).errorCode, 'REPORT_NOT_FOUND');
  });
});

test('production server mounts Lab routes in the existing backend without a second app', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '..', 'backend', 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/routes\/labs'\)/);
  assert.match(server, /app\.use\('\/api\/care-profile', labsRouter\)/);
  assert.equal((server.match(/const app = express\(\)/g) || []).length, 1);
});
