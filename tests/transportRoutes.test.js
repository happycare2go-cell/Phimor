const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const transportService = require('../backend/services/transportService');

let server;
let baseUrl;

before(async () => {
  server = http.createServer(require('../backend/server'));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server.close(resolve)));
beforeEach(() => db.resetAll());

test('หน้า pending เรียก collection route และไม่ถูกตีความเป็น plan id', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await db.TransportPlans.insert({
    plan_id: 'PLAN1',
    center_id: center.center_id,
    appointment_id: 'APPT1',
    status: 'awaiting_center',
  });

  const response = await fetch(`${baseUrl}/api/transport/pending?centerId=${center.center_id}`, {
    headers: { 'X-Line-User-Id': 'U_OWNER' },
  });
  const body = await response.json();

  assert.strictEqual(response.status, 200);
  assert.strictEqual(body.pending.length, 1);
  assert.strictEqual(body.pending[0].plan_id, 'PLAN1');
});

test('Family owner ของ Care Profile อิสระเลือกไปเองได้โดยไม่ต้องมี Center linkage', async () => {
  const profile = await db.CareProfiles.insert({ care_profile_id:'CP-INDEPENDENT', owner_line_id:'U_FAMILY', patient_name:'คุณยายอิสระ', center_id:null, status:'independent' });
  const plan = await transportService.createTransportPlan({ appointmentId:'AP-INDEPENDENT', careProfileId:profile.care_profile_id, centerId:null });
  const response = await fetch(`${baseUrl}/api/transport/${plan.plan_id}/family-choice`, {
    method:'POST', headers:{'Content-Type':'application/json','X-Line-User-Id':'U_FAMILY'}, body:JSON.stringify({choice:'self'}),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'family_handled');
  const updated = await db.TransportPlans.findOne((item) => item.plan_id === plan.plan_id);
  assert.equal(updated.family_choice, 'self');
  assert.equal(updated.center_id, null);
});

test('ผู้ใช้คนอื่นเลือกการเดินทางของ Care Profile อิสระไม่ได้และสถานะไม่เปลี่ยน', async () => {
  const profile = await db.CareProfiles.insert({ care_profile_id:'CP-PRIVATE', owner_line_id:'U_OWNER', patient_name:'คุณยายส่วนตัว', center_id:null, status:'independent' });
  const plan = await transportService.createTransportPlan({ appointmentId:'AP-PRIVATE', careProfileId:profile.care_profile_id, centerId:null });
  const response = await fetch(`${baseUrl}/api/transport/${plan.plan_id}/family-choice`, {
    method:'POST', headers:{'Content-Type':'application/json','X-Line-User-Id':'U_OTHER'}, body:JSON.stringify({choice:'self'}),
  });
  assert.equal(response.status, 403);
  const unchanged = await db.TransportPlans.findOne((item) => item.plan_id === plan.plan_id);
  assert.equal(unchanged.status, 'awaiting_family');
  assert.equal(unchanged.family_choice, null);
});
