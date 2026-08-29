// tests/externalRoutes.test.js — ทดสอบ API รับสัญญาณชีพจากภายนอก (ข้อ J4)

const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const db = require('../backend/db');
const centerService = require('../backend/services/centerService');

let server, baseUrl;

before(async () => {
  process.env.ADMIN_API_KEY = 'test-admin-key';
  const app = require('../backend/server');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => db.resetAll());

async function callExternal(path, opts = {}) {
  return fetch(`${baseUrl}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
}

test('ข้อ J4: สร้างศูนย์แล้วต้องได้ external_api_key มาด้วยทันที', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  assert.ok(center.external_api_key, 'ทุกศูนย์ต้องมี API Key สำหรับระบบภายนอกตั้งแต่สร้าง');
});

test('self-registration grants a server-authored calendar-month trial and ignores browser dates', async () => {
  const nativeFetch = global.fetch;
  const previousChannel = process.env.LINE_LOGIN_CHANNEL_ID;
  process.env.LINE_LOGIN_CHANNEL_ID = 'test-line-login-channel';
  global.fetch = async (input, options) => {
    if (String(input).startsWith('https://api.line.me/oauth2/v2.1/verify')) {
      return new Response(JSON.stringify({ sub:'U-SELF-REGISTER' }), {
        status:200, headers:{ 'content-type':'application/json' },
      });
    }
    return nativeFetch(input, options);
  };
  try {
    const response = await callExternal('/api/external/register-center', {
      method:'POST',
      body:JSON.stringify({
        centerName:'ศูนย์สมัครเอง', address:'กรุงเทพฯ', contactPhone:'0812345678',
        idToken:'verified-test-token', lineUserId:'U-FORGED',
        subscriptionStartAt:'1900-01-01T00:00:00Z', subscriptionEndAt:'2999-01-01T00:00:00Z',
      }),
    });
    assert.strictEqual(response.status, 201);
    const body = await response.json();
    assert.match(body.message, /ทดลองใช้พี่หมอได้ฟรี 1 เดือน/);
    assert.strictEqual(body.subscription.state, 'trial');
    assert.strictEqual(body.subscription.allowed, true);
    const center = await db.Centers.findOne((item) => item.name === 'ศูนย์สมัครเอง');
    assert.strictEqual(center.owner_line_id, 'U-SELF-REGISTER');
    assert.strictEqual(center.subscription_package_type, 'trial');
    assert.notStrictEqual(center.subscription_start_at, '1900-01-01T00:00:00Z');
    assert.notStrictEqual(center.subscription_end_at, '2999-01-01T00:00:00Z');
    assert.strictEqual(
      center.subscription_end_at,
      require('../backend/services/subscriptionService').addBangkokCalendarMonth(center.subscription_start_at).toISOString(),
    );
    const owner = await db.CenterStaff.findOne((item) => item.center_id === center.center_id && item.role === 'owner');
    assert.strictEqual(owner.line_user_id, 'U-SELF-REGISTER');
  } finally {
    global.fetch = nativeFetch;
    if (previousChannel === undefined) delete process.env.LINE_LOGIN_CHANNEL_ID;
    else process.env.LINE_LOGIN_CHANNEL_ID = previousChannel;
  }
});

test('ส่งสัญญาณชีพโดยไม่มี API Key ต้องถูกปฏิเสธ 401', async () => {
  const res = await callExternal('/api/external/vitals', {
    method: 'POST', body: JSON.stringify({ residentId: 'R-1', systolic: 120 }),
  });
  assert.strictEqual(res.status, 401);
});

test('ส่งสัญญาณชีพด้วย API Key ผิด ต้องถูกปฏิเสธ 401', async () => {
  const res = await callExternal('/api/external/vitals', {
    method: 'POST', headers: { 'X-Center-Api-Key': 'wrong-key' }, body: JSON.stringify({ residentId: 'R-1', systolic: 120 }),
  });
  assert.strictEqual(res.status, 401);
});

test('ส่งสัญญาณชีพด้วย API Key ที่ถูกต้อง ต้องบันทึกสำเร็จพร้อมที่มาครบ (ข้อ J5)', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });

  const res = await callExternal('/api/external/vitals', {
    method: 'POST', headers: { 'X-Center-Api-Key': center.external_api_key },
    body: JSON.stringify({
      residentId: resident.resident_id, recordedAt: '2569-08-17T08:00:00+07:00',
      systolic: 128, diastolic: 76, pulse: 72, temperature: 36.6, source: 'HappyHomeSenior-Internal',
    }),
  });
  assert.strictEqual(res.status, 201);

  const records = await db.Vitals.findAll();
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].source_center_id, center.center_id, 'ต้องรู้ว่ามาจากศูนย์ไหน (ข้อ J5)');
  assert.strictEqual(records[0].source_system, 'legacy_center_api_key', 'trusted source ต้องมาจากวิธียืนยันตัวตน ไม่ใช่ payload');
  assert.strictEqual(records[0].legacy_reported_source, 'HappyHomeSenior-Internal', 'เก็บ source เดิมเป็น compatibility metadata ที่ไม่ใช่ตัวตนผู้ส่ง');
  assert.ok(records[0].ingested_at, 'ต้องรู้ว่าเข้าระบบเมื่อใด (ข้อ J5)');
  assert.strictEqual(res.headers.get('deprecation'), 'true');
});

test('ศูนย์ A ส่ง API Key ของตัวเอง แต่ระบุ residentId ของศูนย์ B ต้องถูกปฏิเสธ (กันข้ามศูนย์)', async () => {
  const centerA = await centerService.createCenter({ name: 'ศูนย์ A', ownerLineId: 'U_A' });
  const centerB = await centerService.createCenter({ name: 'ศูนย์ B', ownerLineId: 'U_B' });
  const { resident: residentB } = await centerService.addResident({ centerId: centerB.center_id, fullName: 'ผู้พักศูนย์ B' });

  const res = await callExternal('/api/external/vitals', {
    method: 'POST', headers: { 'X-Center-Api-Key': centerA.external_api_key },
    body: JSON.stringify({ residentId: residentB.resident_id, systolic: 120 }),
  });
  assert.strictEqual(res.status, 404, 'ต้องไม่พบผู้พักนี้ในศูนย์ A ทั้งที่มีอยู่จริงในศูนย์ B');
});

test('ข้อ J4: ศูนย์ที่ไม่เคยใช้ Endpoint นี้เลย ยังใช้ฟีเจอร์อื่นได้ครบปกติ (เป็นทางเลือก ไม่บังคับ)', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ไม่ใช้ Vitals', ownerLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมชาย ใจดี' });
  assert.ok(resident.resident_id, 'เพิ่มผู้พักได้ปกติโดยไม่ต้องยุ่งกับ Vitals API เลย');

  const vitals = await db.Vitals.findWhere((v) => v.resident_id === resident.resident_id);
  assert.strictEqual(vitals.length, 0);
});

test('หมุน API Key ใหม่แล้ว กุญแจเดิมต้องใช้ไม่ได้อีก', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const oldKey = center.external_api_key;

  const newKey = await centerService.rotateExternalApiKey(center.center_id, 'U_OWNER');
  assert.notStrictEqual(newKey, oldKey);

  const resOld = await callExternal('/api/external/vitals', {
    method: 'POST', headers: { 'X-Center-Api-Key': oldKey }, body: JSON.stringify({ residentId: 'R-1', systolic: 120 }),
  });
  assert.strictEqual(resOld.status, 401, 'กุญแจเก่าต้องถูกเพิกถอนทันทีหลังหมุนใหม่');

  const resNew = await callExternal('/api/external/vitals', {
    method: 'POST', headers: { 'X-Center-Api-Key': newKey }, body: JSON.stringify({ residentId: 'R-nonexist', systolic: 120 }),
  });
  assert.strictEqual(resNew.status, 404, 'กุญแจใหม่ต้องผ่านการตรวจสอบสิทธิ์ได้ (แค่ resident ไม่มีอยู่จริงเท่านั้น)');
});
