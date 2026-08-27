process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const { projectCenter } = require('../backend/services/centerProjection');

let server; let baseUrl;
test.before(async()=>{const app=require('../backend/server');server=http.createServer(app);await new Promise((resolve)=>server.listen(0,resolve));baseUrl=`http://127.0.0.1:${server.address().port}`});
test.after(async()=>{await new Promise((resolve)=>server.close(resolve))});
test.beforeEach(()=>db.resetAll());

test('Center projection always removes legacy external_api_key', () => {
  const projected = projectCenter({ center_id:'CTR-1', name:'Center', external_api_key:'EXT-secret', externalApiKey:'also-secret' });
  assert.deepEqual(projected, { center_id:'CTR-1', name:'Center' });
});

test('/api/center/me never returns external_api_key to active Center staff', async () => {
  const center = await centerService.createCenter({ name:'Center', ownerLineId:'U_OWNER' });
  assert.ok(center.external_api_key, 'legacy key remains internally for compatibility');
  const response = await fetch(`${baseUrl}/api/center/me`, { headers:{ 'X-Line-User-Id':'U_OWNER' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.centers[0].center_id, center.center_id);
  assert.doesNotMatch(JSON.stringify(body), /external_api_key|EXT-/i);
});

test('registration and Admin detail projections explicitly redact the legacy key', () => {
  const externalRoute = fs.readFileSync(path.join(__dirname,'..','backend','routes','external.js'),'utf8');
  const subscription = fs.readFileSync(path.join(__dirname,'..','backend','services','subscriptionService.js'),'utf8');
  assert.match(externalRoute, /projectCenter\(duplicate\)/);
  assert.match(externalRoute, /projectCenter\(newCenter\)/);
  assert.match(subscription, /center:\s*projectCenter\(center\)/);
});

test('System Admin Center detail does not accidentally serialize the stored legacy key', async () => {
  const center = await centerService.createCenter({ name:'Center', ownerLineId:'U_OWNER' });
  const response = await fetch(`${baseUrl}/api/admin/centers/${center.center_id}`, {
    headers:{ 'X-Admin-Key':'test-admin-key' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.center.center_id, center.center_id);
  assert.doesNotMatch(JSON.stringify(body.center), /external_api_key|EXT-/i);
});

test('legacy vitals remains available but source_system is server-derived and route is deprecated', () => {
  const source = fs.readFileSync(path.join(__dirname,'..','backend','routes','external.js'),'utf8');
  assert.match(source, /source_system:\s*'legacy_center_api_key'/);
  assert.match(source, /legacy_reported_source/);
  assert.match(source, /Deprecation/);
  assert.doesNotMatch(source, /source_system:\s*source\s*\|\|/);
});
