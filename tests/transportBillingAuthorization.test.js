const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const transportService = require('../backend/services/transportService');
const lineClient = require('../backend/providers/lineClient');

let server;
let baseUrl;

before(async () => {
  server = http.createServer(require('../backend/server'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server.close(resolve)));
beforeEach(() => { db.resetAll(); lineClient.clearSentLog(); });

async function request(path, user, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'X-Line-User-Id':user },
    body: JSON.stringify(body),
  });
  return { response, body:await response.json() };
}

async function setupTwoCenters() {
  const centerA = await centerService.createCenter({ name:'ศูนย์ A', ownerLineId:'OWNER-A' });
  const centerB = await centerService.createCenter({ name:'ศูนย์ B', ownerLineId:'OWNER-B' });
  await db.CenterStaff.insert({
    staff_id:'STAFF-MANAGER-A', center_id:centerA.center_id, line_user_id:'MANAGER-A', role:'manager', status:'active',
  });
  const profileA = await db.CareProfiles.insert({
    care_profile_id:'CP-A', owner_line_id:'FAMILY-A', patient_name:'ผู้พัก A', center_id:centerA.center_id, status:'linked',
  });
  const profileB = await db.CareProfiles.insert({
    care_profile_id:'CP-B', owner_line_id:'FAMILY-B', patient_name:'ผู้พัก B', center_id:centerB.center_id, status:'linked',
  });
  await db.Residents.insert({ resident_id:'RES-A', center_id:centerA.center_id, care_profile_id:'CP-A', full_name:'ผู้พัก A', status:'active' });
  await db.Residents.insert({ resident_id:'RES-B', center_id:centerB.center_id, care_profile_id:'CP-B', full_name:'ผู้พัก B', status:'active' });
  await db.Appointments.insert({ appointment_id:'APT-A', care_profile_id:'CP-A', datetime:'2099-01-01T09:00:00+07:00', hospital:'รพ. A', status:'confirmed' });
  await db.Appointments.insert({ appointment_id:'APT-B', care_profile_id:'CP-B', datetime:'2099-01-02T09:00:00+07:00', hospital:'รพ. B', status:'confirmed' });
  const planA = await transportService.createTransportPlan({ appointmentId:'APT-A', careProfileId:'CP-A', centerId:centerA.center_id });
  const planB = await transportService.createTransportPlan({ appointmentId:'APT-B', careProfileId:'CP-B', centerId:centerB.center_id });
  await db.TransportPlans.update((item) => item.plan_id === planA.plan_id, { status:'care2go_requested' });
  await db.TransportPlans.update((item) => item.plan_id === planB.plan_id, { status:'care2go_requested' });
  return { centerA, centerB, profileA, profileB, planA, planB };
}

test('Transport manager may mark a plan unavailable only in the authoritative same Center', async () => {
  const { centerA, planA } = await setupTwoCenters();
  const result = await request(`/api/transport/${planA.plan_id}/care2go-unavailable`, 'MANAGER-A', { centerId:centerA.center_id });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.ok, true);
});

test('Transport manager and owner cannot access another Center plan', async () => {
  const { centerA, planB } = await setupTwoCenters();
  for (const user of ['MANAGER-A', 'OWNER-A']) {
    const result = await request(`/api/transport/${planB.plan_id}/care2go-unavailable`, user, { centerId:centerA.center_id });
    assert.equal(result.response.status, 404);
    assert.deepEqual(result.body, { error:'not_found', message:'ไม่พบข้อมูล' });
  }
});

test('Transport request-supplied Center cannot forge access and unknown plan is equally safe', async () => {
  const { centerB, planB } = await setupTwoCenters();
  const forged = await request(`/api/transport/${planB.plan_id}/care2go-unavailable`, 'MANAGER-A', { centerId:centerB.center_id });
  const unknown = await request('/api/transport/PLAN-UNKNOWN/care2go-unavailable', 'MANAGER-A', { centerId:centerB.center_id });
  assert.equal(forged.response.status, 404);
  assert.equal(unknown.response.status, 404);
  assert.deepEqual(forged.body, unknown.body);
});

test('Bill creation succeeds for one authoritative same-Center Appointment/Profile relationship', async () => {
  const { centerA } = await setupTwoCenters();
  const result = await request('/api/bills', 'MANAGER-A', {
    centerId:centerA.center_id, careProfileId:'CP-A', appointmentId:'APT-A', items:[{ label:'ค่าพาหนะ', amount:500 }],
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.center_id, centerA.center_id);
  assert.equal((await db.Bills.findAll()).length, 1);
});

test('Bill creation denies an Appointment belonging to another Center', async () => {
  const { centerA } = await setupTwoCenters();
  lineClient.clearSentLog();
  const result = await request('/api/bills', 'MANAGER-A', {
    centerId:centerA.center_id, careProfileId:'CP-B', appointmentId:'APT-B', items:[{ label:'ค่าพาหนะ', amount:500 }],
  });
  assert.equal(result.response.status, 404);
  assert.equal((await db.Bills.findAll()).length, 0);
  assert.equal(lineClient.getSentLog().length, 0);
});

test('Bill creation denies unrelated Care Profile and mixed Appointment/Profile combinations', async () => {
  const { centerA } = await setupTwoCenters();
  lineClient.clearSentLog();
  for (const input of [
    { careProfileId:'CP-B', appointmentId:'APT-A' },
    { careProfileId:'CP-A', appointmentId:'APT-B' },
  ]) {
    const result = await request('/api/bills', 'MANAGER-A', {
      centerId:centerA.center_id, ...input, items:[{ label:'ค่าพาหนะ', amount:500 }],
    });
    assert.equal(result.response.status, 404);
  }
  assert.equal((await db.Bills.findAll()).length, 0);
  assert.equal(lineClient.getSentLog().length, 0);
});

test('Bill authorization failures do not reveal whether a tenant record exists', async () => {
  const { centerA } = await setupTwoCenters();
  const existingOtherTenant = await request('/api/bills', 'MANAGER-A', {
    centerId:centerA.center_id, careProfileId:'CP-B', appointmentId:'APT-B', items:[{ label:'ค่าพาหนะ', amount:500 }],
  });
  const unknown = await request('/api/bills', 'MANAGER-A', {
    centerId:centerA.center_id, careProfileId:'CP-UNKNOWN', appointmentId:'APT-UNKNOWN', items:[{ label:'ค่าพาหนะ', amount:500 }],
  });
  assert.equal(existingOtherTenant.response.status, 404);
  assert.equal(unknown.response.status, 404);
  assert.deepEqual(existingOtherTenant.body, unknown.body);
});
