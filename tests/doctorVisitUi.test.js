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
  assert.match(html, /รอตรวจสอบ/); assert.match(source, /ฉบับปัจจุบัน|ฉบับก่อนหน้า/);
});

test('request builders expose CRUD and AI organize without actor or canonical-write fields', () => {
  const create = ui.buildCreateRequest('CP-1', { sourceText: 'บันทึก' });
  assert.equal(create.path, '/api/care-profile/CP-1/doctor-visits/drafts');
  assert.deepEqual(JSON.parse(create.options.body), { sourceText: 'บันทึก' });
  assert.equal(ui.buildOrganizeRequest('CP-1', 'DVR-1').path, '/api/care-profile/CP-1/doctor-visits/DVR-1/organize');
  assert.equal(ui.buildConfirmRequest('CP-1', 'DVR-1').path, '/api/care-profile/CP-1/doctor-visits/DVR-1/confirm');
  assert.doesNotMatch(JSON.stringify(create), /lineUser|confirmedBy|MedicationSnapshot|appointmentCreate|labReport/i);
});

test('Doctor Visit correction and void requests are profile-scoped and carry only the mandatory reason', () => {
  const correction=ui.buildCorrectionRequest('CP-1','DVR-1','แก้ข้อความ');
  const voidRequest=ui.buildVoidRequest('CP-1','DVR-1','บันทึกผิดคน');
  assert.equal(correction.path,'/api/care-profile/CP-1/doctor-visits/DVR-1/corrections');
  assert.deepEqual(JSON.parse(correction.options.body),{reason:'แก้ข้อความ'});
  assert.equal(voidRequest.path,'/api/care-profile/CP-1/doctor-visits/DVR-1/void');
  assert.deepEqual(JSON.parse(voidRequest.options.body),{reason:'บันทึกผิดคน'});
  assert.doesNotMatch(JSON.stringify([correction,voidRequest]),/lineUser|centerId|actor|groupId/);
  assert.equal(ui.versionLabel({status:'confirmed',isCurrent:true}),'ฉบับปัจจุบัน');
  assert.equal(ui.versionLabel({status:'confirmed',isCurrent:false}),'ฉบับก่อนหน้า');
  assert.equal(ui.versionLabel({status:'draft'}),'ฉบับรอตรวจ');
  assert.equal(ui.versionLabel({status:'voided'}),'ยกเลิกแล้ว');
});

test('Doctor Visit correction opens only V2 draft and stale profile response is ignored', async () => {
  const wait={};wait.promise=new Promise((resolve)=>{wait.resolve=resolve;});
  const calls=[];
  const session=ui.createSession({request:async(path,options)=>{
    calls.push([path,options?.method]);
    if(path.includes('/corrections'))return wait.promise;
    return{items:[]};
  }});
  await session.setProfile('CP-1');
  const pending=session.createCorrection('DVR-1','แก้ไข');
  await session.setProfile('CP-2');
  wait.resolve({visitRecordId:'DVR-V2',status:'draft',versionNo:2,sourceText:'PRIVATE-P1',items:[]});
  assert.deepEqual(await pending,{ignored:true,stale:true});
  assert.equal(session.snapshot().profileId,'CP-2');assert.equal(session.snapshot().selected,null);
  assert.doesNotMatch(JSON.stringify(session.snapshot()),/PRIVATE-P1/);
  assert.equal(calls.filter(([path])=>path.includes('/corrections')).length,1);
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

test('UI includes review-only follow-up labels and only explicit versioned correction actions', () => {
  assert.match(source, /ทบทวนรายการยา|ตรวจสอบนัดหมายครั้งถัดไป|ติดตามผลตรวจ/);
  assert.doesNotMatch(source, /createMedication|updateMedication|createAppointment|createLabReport|confirmLabReport/);
  assert.match(source,/สร้างฉบับแก้ไข/);assert.match(source,/ยกเลิกรายการ/);
});
