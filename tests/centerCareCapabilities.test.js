process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const db = require('../backend/db');
const centersRouter = require('../backend/routes/centers');

async function withApi(rows, callback) {
  db.resetAll();
  await db.Centers.insert({ center_id:'CTR-CAP', name:'Capability Center', status:'active' });
  await db.CenterStaff.insert({ staff_id:'STF-CAP', center_id:'CTR-CAP', line_user_id:'U-CAP', role:'staff', status:'active' });
  const app = express(); app.use(express.json());
  app.locals.platformService = { async listCenterCapabilities(centerId) { assert.equal(centerId, 'CTR-CAP'); return rows; } };
  app.use('/api', centersRouter);
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, resolve));
  try {
    const request = (user = 'U-CAP') => fetch(`http://127.0.0.1:${server.address().port}/api/center/CTR-CAP/capabilities`, {
      headers:user ? { 'X-Line-User-Id':user } : {},
    });
    await callback(request);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('Center capability projection is authenticated and backend authoritative', async () => {
  await withApi([
    { capabilityKey:'vital_signs_v1', enabled:true },
    { capabilityKey:'daily_care_v1', enabled:false },
  ], async (request) => {
    assert.equal((await request(null)).status, 401);
    const response = await request();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { capabilities:{ vital_signs_v1:true, daily_care_v1:false } });
  });
});

test('Center capability projection fails closed for absent values and leaks no platform secrets', async () => {
  await withApi([{ capabilityKey:'vital_signs_v1', enabled:false, integrationSecret:'must-not-leak' }], async (request) => {
    const body = await (await request()).json();
    assert.deepEqual(body, { capabilities:{ vital_signs_v1:false, daily_care_v1:false } });
    assert.doesNotMatch(JSON.stringify(body), /secret|credential|token|organization/i);
  });
});
