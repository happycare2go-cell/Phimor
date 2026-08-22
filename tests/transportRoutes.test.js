const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');

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
