const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';

const db = require('../backend/db');
const centerService = require('../backend/services/centerService');

let server;
let baseUrl;

before(async () => {
  const app = require('../backend/server');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server.close(resolve)));
beforeEach(() => db.resetAll());

async function seed() {
  const center = await centerService.createCenter({ name:'ศูนย์ทดสอบ', ownerLineId:'U-OWNER' });
  await db.CenterStaff.insert({ staff_id:'S-M', center_id:center.center_id,
    line_user_id:'U-MANAGER', role:'manager', status:'active' });
  await db.CenterStaff.insert({ staff_id:'S-S', center_id:center.center_id,
    line_user_id:'U-STAFF', role:'staff', status:'active' });
  await db.CareProfiles.insert({ care_profile_id:'CP-1', owner_line_id:null,
    patient_name:'คุณสมใจ', center_id:center.center_id, status:'linked', managed_by_center:true });
  await db.Residents.insert({ resident_id:'R-1', center_id:center.center_id, full_name:'คุณสมใจ',
    care_profile_id:'CP-1', status:'active', link_status:'center_managed' });
  return center;
}

async function issue(centerId, userId, residentId = 'R-1') {
  return fetch(`${baseUrl}/api/residents/${residentId}/family-group-binding-token`, {
    method:'POST', headers:{ 'Content-Type':'application/json', 'X-Line-User-Id':userId },
    body:JSON.stringify({ centerId }),
  });
}

test('Center Owner can issue CGROUP through the authenticated Resident route', async () => {
  const center = await seed();
  const response = await issue(center.center_id, 'U-OWNER');
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.code, /^CGROUP-[A-F0-9]{32}$/);
  assert.ok(body.expiresAt);
  assert.deepEqual(Object.keys(body).sort(), ['code', 'expiresAt']);
});

test('Center Manager is allowed, while Staff, unrelated actor and forged Center are denied', async () => {
  const center = await seed();
  assert.equal((await issue(center.center_id, 'U-MANAGER')).status, 201);

  db.resetAll();
  const next = await seed();
  assert.equal((await issue(next.center_id, 'U-STAFF')).status, 403);
  assert.equal((await issue(next.center_id, 'U-UNRELATED')).status, 403);
  assert.equal((await issue('CTR-FORGED', 'U-OWNER')).status, 403);
});

test('request body cannot select another Resident or Care Profile across Centers', async () => {
  const first = await seed();
  const second = await centerService.createCenter({ name:'ศูนย์อื่น', ownerLineId:'U-OTHER-OWNER' });
  await db.CareProfiles.insert({ care_profile_id:'CP-OTHER', owner_line_id:null,
    patient_name:'คุณอื่น', center_id:second.center_id, status:'linked', managed_by_center:true });
  await db.Residents.insert({ resident_id:'R-OTHER', center_id:second.center_id, full_name:'คุณอื่น',
    care_profile_id:'CP-OTHER', status:'active', link_status:'center_managed' });
  const response = await issue(first.center_id, 'U-OWNER', 'R-OTHER');
  assert.equal(response.status, 404);
  assert.equal((await db.GroupBindingTokens.findAll()).length, 0);
});
