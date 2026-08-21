// tests/familyRoutes.test.js — ทดสอบ Route ฝั่งครอบครัวผ่าน HTTP จริง

const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';
process.env.PDF_DOWNLOAD_SECRET = process.env.PDF_DOWNLOAD_SECRET || 'test-pdf-download-secret';

const db = require('../backend/db');
const familyService = require('../backend/services/familyService');

let server, baseUrl;

before(async () => {
  const app = require('../backend/server');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => db.resetAll());

async function api(path, opts = {}, lineUserId = 'U_FAMILY') {
  return fetch(`${baseUrl}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Line-User-Id': lineUserId, ...(opts.headers || {}) },
  });
}

test('GET /api/consent/check คืนค่า false เมื่อยังไม่เคยยินยอม', async () => {
  const res = await api('/api/consent/check');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.hasConsent, false);
});

test('POST /api/consent แล้ว GET /api/consent/check ต้องเป็น true', async () => {
  await api('/api/consent', { method: 'POST', body: JSON.stringify({ accepted: true }) });
  const res = await api('/api/consent/check');
  const body = await res.json();
  assert.strictEqual(body.hasConsent, true);
});

test('POST /api/export/pdf ผ่าน HTTP จริง ต้องคืนไฟล์ PDF พร้อม Header ที่ถูกต้อง', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U_FAMILY', patientName: 'คุณยายทองดี' });
  await db.Appointments.insert({ appointment_id: 'A1', care_profile_id: profile.care_profile_id, hospital: 'รพ.ทดสอบ', datetime: '2050-01-01T09:00:00+07:00' });

  const res = await api('/api/export/pdf', { method: 'POST', body: JSON.stringify({ careProfileId: profile.care_profile_id }) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
  assert.ok(res.headers.get('content-disposition').includes('attachment'));

  const buf = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(buf.slice(0, 4).toString(), '%PDF');
});

test('ลิงก์ PDF ชั่วคราวเปิดโดยไม่ใช้ Authorization header และเหมาะกับ Safari', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U_FAMILY', patientName: 'คุณยายทองดี' });
  await db.Appointments.insert({ appointment_id: 'A1', care_profile_id: profile.care_profile_id, hospital: 'รพ.ทดสอบ', datetime: '2050-01-01T09:00:00+07:00' });

  const issued = await api('/api/export/pdf-link', {
    method: 'POST', body: JSON.stringify({ careProfileId: profile.care_profile_id, fromDate: '2050-01-01', toDate: '2050-01-01' }),
  });
  assert.strictEqual(issued.status, 200);
  const links = await issued.json();
  assert.ok(links.previewUrl.includes('/api/export/pdf/download?token='));
  assert.ok(links.downloadUrl.includes('download=1'));

  const preview = await fetch(links.previewUrl);
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.headers.get('content-type'), 'application/pdf');
  assert.ok(preview.headers.get('content-disposition').startsWith('inline'));
  assert.strictEqual(preview.headers.get('cache-control'), 'private, no-store, max-age=0');
  const buf = Buffer.from(await preview.arrayBuffer());
  assert.strictEqual(buf.slice(0, 4).toString(), '%PDF');

  const download = await fetch(links.downloadUrl);
  assert.strictEqual(download.status, 200);
  assert.ok(download.headers.get('content-disposition').startsWith('attachment'));
});

test('ลิงก์ PDF ที่ถูกแก้ไขต้องถูกปฏิเสธ', async () => {
  const res = await fetch(`${baseUrl}/api/export/pdf/download?token=invalid.token`);
  assert.strictEqual(res.status, 401);
});

test('POST /api/export/pdf โดยคนที่ไม่ใช่เจ้าของ ต้องถูกปฏิเสธ', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U_OWNER_REAL', patientName: 'คุณยายทองดี' });
  const res = await api('/api/export/pdf', { method: 'POST', body: JSON.stringify({ careProfileId: profile.care_profile_id }) }, 'U_STRANGER');
  assert.strictEqual(res.status, 403);
});

test('POST /api/care-profile/independent ต้องมีความยินยอมก่อนจึงสร้างได้ (ข้อ H6)', async () => {
  const withoutConsent = await api('/api/care-profile/independent', { method: 'POST', body: JSON.stringify({ patientName: 'ทดสอบ' }) });
  assert.strictEqual(withoutConsent.status, 412, 'ยังไม่ยินยอม ต้องถูกบล็อกด้วย 412');

  await api('/api/consent', { method: 'POST', body: JSON.stringify({ accepted: true }) });
  const withConsent = await api('/api/care-profile/independent', { method: 'POST', body: JSON.stringify({ patientName: 'ทดสอบ' }) });
  assert.strictEqual(withConsent.status, 201);
});
