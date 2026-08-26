const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = require('../liff-app/family/doctor-visit-ui');
const html = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'index.html'), 'utf8');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'doctor-visit-ui.js'), 'utf8');

test('Family LIFF has one Care Profile-centered หมอว่าไง entry and clear provenance wording', () => {
  assert.equal((html.match(/id="doctorVisitPanel"/g) || []).length, 1);
  assert.match(html, />หมอว่าไง</);
  assert.match(html, /ข้อมูลนี้บันทึกโดยผู้ดูแล\/ครอบครัวจากการพบแพทย์/);
  assert.match(html, /ไม่ใช่คำสั่งแพทย์อิเล็กทรอนิกส์/);
});

test('manual workflow and AI organization are distinct actions', () => {
  assert.match(html, /id="doctorVisitSave">บันทึกร่าง/);
  assert.match(html, /id="doctorVisitOrganize">ช่วยจัดระเบียบด้วยพี่หมอ Plus/);
  assert.match(html, /id="doctorVisitConfirm">ยืนยันบันทึกจากการพบแพทย์/);
  assert.match(html, /รอตรวจสอบ/); assert.match(source, /ยืนยันแล้ว/);
});

test('request builders expose CRUD and AI organize without actor or canonical-write fields', () => {
  const create = ui.buildCreateRequest('CP-1', { sourceText: 'บันทึก' });
  assert.equal(create.path, '/api/care-profile/CP-1/doctor-visits/drafts');
  assert.deepEqual(JSON.parse(create.options.body), { sourceText: 'บันทึก' });
  assert.equal(ui.buildOrganizeRequest('CP-1', 'DVR-1').path, '/api/care-profile/CP-1/doctor-visits/DVR-1/organize');
  assert.equal(ui.buildConfirmRequest('CP-1', 'DVR-1').path, '/api/care-profile/CP-1/doctor-visits/DVR-1/confirm');
  assert.doesNotMatch(JSON.stringify(create), /lineUser|confirmedBy|MedicationSnapshot|appointmentCreate|labReport/i);
});

test('profile switching clears draft/history and ignores stale profile responses', async () => {
  let resolveFirst;
  const pending = new Promise((resolve) => { resolveFirst = resolve; });
  const session = ui.createSession({
    request: async (path) => path.includes('CP-1') ? pending : { items: [{ visitRecordId: 'DVR-CP2' }] },
  });
  const first = session.setProfile('CP-1');
  await session.setProfile('CP-2');
  resolveFirst({ items: [{ visitRecordId: 'DVR-SECRET' }] });
  await first;
  assert.equal(session.snapshot().profileId, 'CP-2');
  assert.deepEqual(session.snapshot().records.map((item) => item.visitRecordId), ['DVR-CP2']);
  assert.equal(session.snapshot().selected, null);
});

test('manual draft save works without invoking AI organization', async () => {
  const calls = [];
  const session = ui.createSession({ request: async (path, options) => {
    calls.push([path, options.method]);
    if (path.includes('/drafts')) return { visitRecordId: 'DVR-1', status: 'draft', items: [] };
    return { items: [] };
  } });
  await session.setProfile('CP-1'); session.newDraft();
  await session.save({ sourceText: 'หมอบอกให้ติดตาม', items: [] });
  assert.equal(session.snapshot().selected.status, 'draft');
  assert.equal(calls.some(([path]) => path.endsWith('/organize')), false);
});

test('AI unavailable leaves the saved manual draft selected and usable', async () => {
  const session = ui.createSession({ request: async (path) => {
    if (path.includes('/drafts')) return { visitRecordId: 'DVR-1', status: 'draft', sourceText: 'บันทึก', items: [] };
    if (path.endsWith('/organize')) { const error = new Error('unavailable'); error.errorCode = 'AI_TIMEOUT'; throw error; }
    return { items: [] };
  } });
  await session.setProfile('CP-1'); session.newDraft();
  const result = await session.organize({ sourceText: 'บันทึก', items: [] });
  assert.equal(result.status, 'unavailable');
  assert.equal(session.snapshot().selected.visitRecordId, 'DVR-1');
  assert.equal(session.snapshot().errorCode, 'AI_TIMEOUT');
});

test('confirmation saves human edits first then calls explicit confirm endpoint', async () => {
  const calls = [];
  const session = ui.createSession({ request: async (path) => {
    calls.push(path);
    if (path.includes('/drafts')) return { visitRecordId: 'DVR-1', status: 'draft', items: [] };
    if (path.endsWith('/confirm')) return { visitRecordId: 'DVR-1', status: 'confirmed', items: [], followUpSuggestions: [] };
    return { items: [] };
  } });
  await session.setProfile('CP-1'); session.newDraft();
  await session.confirm({ sourceText: 'ตรวจทานแล้ว', items: [] });
  assert.equal(session.snapshot().selected.status, 'confirmed');
  assert.ok(calls.findIndex((path) => path.includes('/drafts')) < calls.findIndex((path) => path.endsWith('/confirm')));
});

test('Family UI never stores post-visit notes in browser persistence or URL parameters', () => {
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  assert.doesNotMatch(source, /URLSearchParams|location\.(?:search|hash)/);
  assert.doesNotMatch(source, /console\.(?:log|info|debug)\s*\(/);
});

test('UI includes review-only follow-up labels and no automatic canonical mutation actions', () => {
  assert.match(source, /ทบทวนรายการยา|ตรวจสอบนัดหมายครั้งถัดไป|ติดตามผลตรวจ/);
  assert.doesNotMatch(source, /createMedication|updateMedication|createAppointment|createLabReport|confirmLab/);
});
