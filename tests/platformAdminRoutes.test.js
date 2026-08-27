process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'platform-admin-key';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../backend/db');
const { createPlatformService } = require('../backend/services/platformService');
const { createMemoryPlatformRepository } = require('./helpers/platformMemoryRepository');

let app; let server; let baseUrl; let service; let repository; let sequence;

test.before(async () => {
  app = require('../backend/server');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => { await new Promise((resolve) => server.close(resolve)); });

test.beforeEach(async () => {
  db.resetAll(); sequence = 0;
  repository = createMemoryPlatformRepository();
  let randomSequence = 1;
  service = createPlatformService({
    repository, idFactory:(prefix)=>`${prefix}-${++sequence}`,
    randomBytes:(size)=>Buffer.alloc(size,(randomSequence++%250)+1),
    withTransaction:async(_key,fn)=>fn(), now:()=>new Date('2026-08-27T00:00:00Z'),
  });
  app.locals.platformService = service;
});

function call(path, options = {}) {
  return fetch(`${baseUrl}${path}`, { ...options, headers:{ 'Content-Type':'application/json', ...(options.headers||{}) } });
}
const admin = { 'X-Admin-Key':'platform-admin-key' };

async function setupCenter(centerId='CTR-A') {
  await db.Centers.insert({ center_id:centerId, name:centerId, status:'active' });
  return service.ensureOrganizationForCenter({ centerId, displayName:centerId, actorReference:'ADM-1' });
}

test('System Admin capability API lists missing rows as OFF and can enable/disable', async () => {
  await setupCenter();
  let response = await call('/api/admin/platform/centers/CTR-A/capabilities', { headers:admin });
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.deepEqual(body.capabilities.map((row)=>[row.capabilityKey,row.enabled]), [
    ['vital_signs_v1',false], ['daily_care_v1',false],
  ]);
  response = await call('/api/admin/platform/centers/CTR-A/capabilities/vital_signs_v1', {
    method:'PATCH', headers:admin, body:JSON.stringify({ enabled:true }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).capability.enabled, true);
  response = await call('/api/admin/platform/centers/CTR-A/capabilities/vital_signs_v1', {
    method:'PATCH', headers:admin, body:JSON.stringify({ enabled:false }),
  });
  assert.equal((await response.json()).capability.enabled, false);
});

test('System Admin resident-option API returns only active residents from the requested Center', async () => {
  await setupCenter('CTR-A');
  await setupCenter('CTR-B');
  await db.Residents.insert({ resident_id:'RES-A', center_id:'CTR-A', care_profile_id:'CP-A', full_name:'คุณยายเอ', room:'A-1', status:'active', phone:'081-secret' });
  await db.Residents.insert({ resident_id:'RES-B', center_id:'CTR-B', care_profile_id:'CP-B', full_name:'คุณยายบี', room:'B-1', status:'active' });
  const response = await call('/api/admin/platform/centers/CTR-A/resident-options?search=%E0%B8%A2%E0%B8%B2%E0%B8%A2&limit=20', { headers:admin });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.residents, [{ residentId:'RES-A', displayName:'คุณยายเอ', room:'A-1', careProfileLinked:true }]);
  assert.doesNotMatch(JSON.stringify(body), /081-secret|CP-A|RES-B/);
});

test('Center actor cannot mutate Platform capability and unknown key is rejected', async () => {
  await setupCenter();
  let response = await call('/api/admin/platform/centers/CTR-A/capabilities/vital_signs_v1', {
    method:'PATCH', headers:{ 'X-Line-User-Id':'U_CENTER_OWNER' }, body:JSON.stringify({enabled:true}),
  });
  assert.equal(response.status, 401);
  response = await call('/api/admin/platform/centers/CTR-A/capabilities/vendor_special', {
    method:'PATCH', headers:admin, body:JSON.stringify({enabled:true}),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).errorCode, 'UNKNOWN_CAPABILITY');
});

test('System Admin onboards Organization and Integration Client without returning secrets in metadata', async () => {
  let response = await call('/api/admin/platform/organizations', {
    method:'POST', headers:admin,
    body:JSON.stringify({ organizationCode:'vendor-a', displayName:'Vendor A' }),
  });
  assert.equal(response.status, 201);
  const organization = (await response.json()).organization;
  response = await call(`/api/admin/platform/organizations/${organization.organizationId}/integration-clients`, {
    method:'POST', headers:admin,
    body:JSON.stringify({ clientCode:'vendor-a-prod', displayName:'Vendor A Production', sourceSystem:'vendor_a' }),
  });
  assert.equal(response.status, 201);
  const client = (await response.json()).integrationClient;
  response = await call(`/api/admin/platform/integration-clients/${client.integrationClientId}/credentials`, { method:'POST', headers:admin, body:'{}' });
  assert.equal(response.status, 201);
  const issued = await response.json();
  assert.match(issued.token, /^pim_int_/);
  response = await call(`/api/admin/platform/integration-clients/${client.integrationClientId}`, { headers:admin });
  const inspected = await response.json();
  assert.doesNotMatch(JSON.stringify(inspected), /pim_int_|secret_hash|secret_salt/i);
});

test('Center receives read-only capability visibility but no feature-toggle endpoint', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname,'..','backend','routes','centers.js'),'utf8');
  assert.match(source, /router\.get\('\/center\/:centerId\/capabilities'/);
  assert.doesNotMatch(source, /router\.(?:post|patch|put|delete)\([^\n]*capabilit/i);
  assert.doesNotMatch(source, /setCenterCapability/);
});

test('System Admin can inspect minimized group reconciliation state and request an explicit retry',async()=>{
  const calls=[];app.locals.integrationEventService={
    async listOperationalStatus(input){calls.push(['list',input]);return{items:[{integrationEventId:'IEVT-1',groupReconciliationStatus:'group_binding_mismatch',expectedLineGroupId:'G-EX…CTED',verifiedLineGroupId:'G-VE…FIED'}],summary:{group_binding_mismatch:1}};},
    async reconcileGroupRouting(input){calls.push(['reconcile',input]);return{integrationEventId:input.integrationEventId,groupReconciliationStatus:'verified_match',notificationIntentStatus:'queued'};},
  };
  let response=await call('/api/admin/platform/integration-events/status?groupStatus=group_binding_mismatch&limit=20',{headers:admin});
  assert.equal(response.status,200);let body=await response.json();assert.equal(body.summary.group_binding_mismatch,1);assert.doesNotMatch(JSON.stringify(body),/clinical|canonical_payload/i);assert.doesNotMatch(JSON.stringify(body),/G-EXPECTED|G-VERIFIED/);
  response=await call('/api/admin/platform/integration-events/IEVT-1/reconcile-group',{method:'POST',headers:admin,body:'{}'});
  assert.equal(response.status,200);body=await response.json();assert.equal(body.notificationIntentStatus,'queued');
  assert.equal(calls[0][1].groupStatus,'group_binding_mismatch');assert.deepEqual(calls[1],["reconcile",{integrationEventId:'IEVT-1'}]);
});
