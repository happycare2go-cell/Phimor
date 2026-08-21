const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');

let server, baseUrl;
before(async () => {
  server = http.createServer(require('../backend/server'));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => new Promise((resolve) => server.close(resolve)));
beforeEach(() => db.resetAll());

async function setup() {
  const center = await centerService.createCenter({ name: 'ศูนย์การ์ด', ownerLineId: 'U_OWNER' });
  await db.CenterStaff.insert({ staff_id: 'SM', center_id: center.center_id, line_user_id: 'U_MANAGER', role: 'manager', status: 'active' });
  const card = await db.PendingCards.insert({ card_id: 'CARD1', center_id: center.center_id, status: 'pending', ai_result: {} });
  return { center, card };
}

function getCard(user) {
  return fetch(`${baseUrl}/api/cards/CARD1`, { headers: { 'X-Line-User-Id': user } });
}

test('ผู้จัดการ active เปิดการ์ดได้', async () => {
  await setup();
  assert.strictEqual((await getCard('U_MANAGER')).status, 200);
});

test('ผู้จัดการ revoked เปิดการ์ดจากลิงก์เดิมไม่ได้ทันที', async () => {
  await setup();
  await db.CenterStaff.update((s) => s.line_user_id === 'U_MANAGER', { status: 'revoked' });
  assert.strictEqual((await getCard('U_MANAGER')).status, 403);
});

test('ศูนย์ถูกระงับหรือแพ็กเกจหมดอายุ เปิดการ์ดไม่ได้', async () => {
  const { center } = await setup();
  await db.Centers.update((c) => c.center_id === center.center_id, { status: 'suspended' });
  assert.strictEqual((await getCard('U_MANAGER')).status, 402);
});
