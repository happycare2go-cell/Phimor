process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../backend/db');
const { createVitalSignsRouter } = require('../backend/routes/vitalSigns');
const { VitalSignsError } = require('../backend/domain/vitalSigns');

async function withApi(service, callback) {
  db.resetAll();
  await db.Centers.insert({ center_id:'CTR-A', name:'Center A', status:'active', subscription_status:'active', subscription_end:'2099-01-01T00:00:00Z' });
  await db.CenterStaff.insert({ staff_id:'STF-1', center_id:'CTR-A', line_user_id:'U-STAFF', role:'staff', status:'active' });
  await db.CenterStaff.insert({ staff_id:'STF-2', center_id:'CTR-A', line_user_id:'U-MANAGER', role:'manager', status:'active' });
  const app = express(); app.use(express.json()); app.locals.vitalSignService = service;
  app.use('/api', createVitalSignsRouter());
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, resolve));
  const request = (route, options = {}, user = 'U-STAFF') => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    ...options, headers:{'Content-Type':'application/json',...(user?{'X-Line-User-Id':user}:{}),...(options.headers||{})},
  });
  try { await callback(request); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function service(overrides = {}) {
  return {
    async listHistory() { return { items:[], nextCursor:null }; },
    async recordNative() { return { duplicate:false, item:{ vitalSetId:'VSET-1' } }; },
    async voidVitalSet() { return { vitalSetId:'VSET-1', status:'voided' }; },
    ...overrides,
  };
}

test('vital routes require LINE authentication and preserve backend authority', async () => {
  await withApi(service(), async (request) => {
    assert.equal((await request('/api/care-profile/CP-A/vital-signs', {}, null)).status, 401);
    assert.equal((await request('/api/center/CTR-A/residents/RES-A/vital-signs', { method:'POST', body:'{}' }, null)).status, 401);
  });
});

test('history forwards only authenticated profile scope and bounded query inputs', async () => {
  let seen;
  await withApi(service({ async listHistory(input) { seen = input; return { items:[], nextCursor:null }; } }), async (request) => {
    const response = await request('/api/care-profile/CP-A/vital-signs?centerId=CTR-A&from=2026-01-01T00%3A00%3A00Z&limit=10', {}, 'U-OWNER');
    assert.equal(response.status, 200);
  });
  assert.deepEqual(seen, { lineUserId:'U-OWNER', careProfileId:'CP-A', centerId:'CTR-A', from:'2026-01-01T00:00:00Z', to:null, cursor:null, limit:'10' });
});

test('native record derives actor from authentication and ignores forged tenant/provenance', async () => {
  let seen;
  await withApi(service({ async recordNative(input) { seen = input; return { duplicate:false,item:{vitalSetId:'VSET-1'} }; } }), async (request) => {
    const response = await request('/api/center/CTR-A/residents/RES-A/vital-signs', { method:'POST', body:JSON.stringify({ occurredAt:'2026-08-27T01:00:00Z', observations:[], organizationId:'ORG-EVIL', actorReference:'evil' }) });
    assert.equal(response.status, 201);
  });
  assert.deepEqual(seen, { lineUserId:'U-STAFF', centerId:'CTR-A', residentId:'RES-A', occurredAt:'2026-08-27T01:00:00Z', observations:[] });
});

test('staff cannot void while manager can void through explicit operation', async () => {
  let calls = 0;
  await withApi(service({ async voidVitalSet() { calls += 1; return {vitalSetId:'VSET-1',status:'voided'}; } }), async (request) => {
    assert.equal((await request('/api/center/CTR-A/vital-signs/VSET-1/void', {method:'POST',body:JSON.stringify({reason:'ผิด'})}, 'U-STAFF')).status, 403);
    assert.equal((await request('/api/center/CTR-A/vital-signs/VSET-1/void', {method:'POST',body:JSON.stringify({reason:'ผิด'})}, 'U-MANAGER')).status, 200);
  });
  assert.equal(calls, 1);
});

test('vital domain errors are safe and raw SQL or identity details never leak', async () => {
  await withApi(service({ async listHistory() { throw new Error('SELECT * FROM secret WHERE line_user_id=U-X'); } }), async (request) => {
    const response = await request('/api/care-profile/CP-A/vital-signs', {}, 'U-OWNER');
    assert.equal(response.status, 500); assert.doesNotMatch(JSON.stringify(await response.json()), /SELECT|line_user|U-X|stack/i);
  });
  await withApi(service({ async listHistory() { throw new VitalSignsError('DATE_RANGE_TOO_LARGE','ช่วงวันที่ต้องไม่เกิน 366 วัน',400); } }), async (request) => {
    const response = await request('/api/care-profile/CP-A/vital-signs', {}, 'U-OWNER');
    assert.equal(response.status, 400); assert.equal((await response.json()).errorCode, 'DATE_RANGE_TOO_LARGE');
  });
});

test('production server mounts vital routes in the existing backend app', () => {
  const source = fs.readFileSync(path.resolve(__dirname,'..','backend','server.js'),'utf8');
  assert.match(source, /require\('\.\/routes\/vitalSigns'\)/);
  assert.match(source, /app\.use\('\/api', createVitalSignsRouter\(\)\)/);
});
