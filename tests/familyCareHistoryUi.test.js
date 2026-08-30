const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = require('../liff-app/family/care-history-ui');
const html = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'index.html'), 'utf8');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'care-history-ui.js'), 'utf8');
const css = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'care-history-ui.css'), 'utf8');

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function vital(overrides = {}) { return { vitalSetId:'VS-1', status:'recorded', occurredAt:'2026-08-27T07:00:00+07:00', recordedAt:'2026-08-27T07:01:00+07:00', centerName:'ศูนย์ตัวอย่าง', sourceType:'native_phimor', observations:[{ measurementType:'blood_glucose', numericValue:108, sourceValueText:'108', sourceUnit:'mg/dL', context:'before_meal' }, { measurementType:'weight', numericValue:55.2, sourceValueText:'55.2', sourceUnit:'kg' }], ...overrides }; }
function daily(overrides = {}) { return { dailyReportId:'DC-1', status:'finalized', occurredAt:'2026-08-27T19:00:00+07:00', careDate:'2026-08-27', shift:{code:'day',sourceLabel:'D'}, finalizedAt:'2026-08-27T20:00:00+07:00', centerName:'ศูนย์ตัวอย่าง', sourceType:'external_integration', recorderDisplayName:'ผู้ดูแลตัวอย่าง', items:[{itemType:'nutrition',valueType:'text',textValue:'รับประทานอาหารได้ครึ่งจาน'}], vitalSigns:[vital()], ...overrides }; }

test('Family Health presents one unified Health Report experience and secondary standalone Vital history', () => {
  assert.equal((html.match(/id="familyCareHistoryPanel"/g) || []).length, 1);
  assert.match(html, /รายงานสุขภาพล่าสุด/); assert.match(html, /ดูรายงานสุขภาพทั้งหมด/);
  assert.match(html, /ประวัติสัญญาณชีพเดิม/);
  assert.match(html, /care-history-ui\.js/); assert.match(html, /care-history-ui\.css/);
  assert.match(html, /ensureCareHistoryUI/); assert.match(html, /care\?\.controller\.open/);
});

test('history requests are Care Profile scoped, bounded and support a bounded date filter', () => {
  const vitalRequest = ui.buildHistoryRequest('vital', 'CP A', { from:'2026-08-01', to:'2026-08-27', cursor:'opaque' });
  assert.match(vitalRequest.path, /^\/api\/care-profile\/CP%20A\/vital-signs\?/);
  assert.match(vitalRequest.path, /limit=10/); assert.match(vitalRequest.path, /cursor=opaque/);
  assert.match(vitalRequest.path, /from=2026-08-01T00%3A00%3A00%2B07%3A00/);
  assert.match(vitalRequest.path, /to=2026-08-27T23%3A59%3A59%2B07%3A00/);
  const dailyRequest = ui.buildHistoryRequest('daily', 'CP-1'); assert.match(dailyRequest.path, /\/daily-care\?/);
  assert.doesNotMatch(`${vitalRequest.path}${dailyRequest.path}`, /lineUser|residentId|phone|group/);
});

test('Vital projection displays only controlled recorded measurements and omits unknown/missing values', () => {
  const projected = ui.projectVitalSet(vital({ observations:[
    { measurementType:'temperature', numericValue:36.6, sourceValueText:'36.6', sourceUnit:'Cel' },
    { measurementType:'vendor_secret', numericValue:999, sourceUnit:'x' },
    { measurementType:'spo2', numericValue:null, sourceValueText:null, sourceUnit:'%' },
  ], lineUserId:'U-SECRET', phone:'081-secret' }));
  assert.deepEqual(projected.observations.map((item) => item.measurementType), ['temperature']);
  assert.doesNotMatch(JSON.stringify(projected), /U-SECRET|081-secret|vendor_secret/);
});

test('linked Vital projection carries only its safe report association for duplicate-presentation filtering',()=>{
  const projected=ui.projectVitalSet(vital({linkedDailyReportId:'DCR-SAFE',dailyReport:{privatePayload:'secret'},residentId:'RES-SECRET'}));
  assert.equal(projected.linkedDailyReportId,'DCR-SAFE');
  assert.doesNotMatch(JSON.stringify(projected),/privatePayload|RES-SECRET/);
  assert.match(source,/state\.vitals\.find\(\(item\) => !item\.linkedDailyReportId\)/);
  assert.match(source,/สัญญาณชีพชุดนี้อยู่ในรายงานสุขภาพ/);
});

test('Family display formats clinical units without mutating canonical source facts', () => {
  const inputs = [
    { measurementType:'temperature', numericValue:36.6, sourceValueText:'36.6', sourceUnit:'Cel', canonicalUnit:'Cel' },
    { measurementType:'blood_pressure_systolic', numericValue:128, sourceValueText:'128', sourceUnit:'mm[Hg]', canonicalUnit:'mm[Hg]' },
    { measurementType:'pulse', numericValue:72, sourceValueText:'72', sourceUnit:'/min', canonicalUnit:'/min' },
    { measurementType:'spo2', numericValue:97, sourceValueText:'97', sourceUnit:'%', canonicalUnit:'%' },
  ];
  const projected = inputs.map(ui.projectObservation);
  assert.deepEqual(projected.map(ui.observationValue), ['36.6 °C', '128 mmHg', '72 ครั้ง/นาที', '97%']);
  assert.deepEqual(projected.map((item) => [item.sourceValueText, item.sourceUnit, item.canonicalUnit]), inputs.map((item) => [item.sourceValueText, item.sourceUnit, item.canonicalUnit]));
});

test('blood glucose context and weight remain factual without interpretation', () => {
  const projected = ui.projectVitalSet(vital());
  assert.equal(projected.observations[0].context, 'before_meal');
  assert.equal(ui.GLUCOSE_CONTEXT_LABELS[projected.observations[0].context], 'ก่อนอาหาร');
  assert.equal(ui.observationValue(projected.observations[0]), '108 mg/dL');
  assert.equal(ui.observationValue(projected.observations[1]), '55.2 kg');
  assert.doesNotMatch(JSON.stringify(projected), /normal|abnormal|high|low|critical|diagnosis/i);
});

test('Daily Care projection accepts finalized records only and preserves linked factual Vitals', () => {
  const projected = ui.projectDailyReport(daily());
  assert.equal(projected.status, 'finalized'); assert.equal(projected.items[0].value, 'รับประทานอาหารได้ครึ่งจาน');
  assert.equal(projected.vitalSigns[0].observations[0].measurementType, 'blood_glucose');
  assert.equal(ui.projectDailyReport(daily({status:'submitted'})), null);
  assert.equal(ui.projectDailyReport(daily({status:'changes_requested'})), null);
});

test('unified Health Report projection exposes safe Care Profile display context without raw subject identifiers',()=>{
  const projected=ui.projectDailyReport(daily({careRecipientName:'คุณยายตัวอย่าง',room:'A-12',residentId:'RES-RAW',careProfileId:'CP-RAW'}));
  assert.equal(projected.careRecipientName,'คุณยายตัวอย่าง');assert.equal(projected.room,'A-12');
  assert.doesNotMatch(JSON.stringify(projected),/RES-RAW|CP-RAW/);
  assert.match(source,/รายงานสุขภาพ/);assert.match(source,/อาการ \/ รายงานทั่วไป/);
});

test('Family uses Thai day/night labels and preserves a factual future shift label', () => {
  assert.equal(ui.shiftLabel({code:'day',sourceLabel:'D'}), 'กลางวัน');
  assert.equal(ui.shiftLabel({code:'night',sourceLabel:'N'}), 'กลางคืน');
  assert.equal(ui.shiftLabel({code:'evening',sourceLabel:'Evening A'}), 'Evening A');
  assert.equal(ui.sourceLabel('external_integration'), 'ข้อมูลจากศูนย์ที่ดูแล');
});

test('Daily Care projection allowlists fields and drops subject/internal data', () => {
  const projected = ui.projectDailyReport(daily({ residentId:'RES-SECRET', careProfileId:'CP-SECRET', lineUserId:'U-SECRET', internalPayload:{clinical:'secret'} }));
  const serialized = JSON.stringify(projected);
  for (const secret of ['RES-SECRET','CP-SECRET','U-SECRET','internalPayload']) assert.equal(serialized.includes(secret), false);
});

test('opening loads Vital and finalized Daily history from the same selected Care Profile', async () => {
  const calls = []; const session = ui.createSession({ request:async (requestPath) => { calls.push(requestPath); return requestPath.includes('vital-signs') ? {items:[vital()],nextCursor:null} : {items:[daily()],nextCursor:null}; } });
  session.setProfile('CP-1'); await session.open(); const state = session.snapshot();
  assert.equal(state.vitals.length, 1); assert.equal(state.daily.length, 1); assert.equal(calls.length, 2);
  assert.ok(calls.every((requestPath) => requestPath.includes('/care-profile/CP-1/')));
});

test('pagination appends without duplicates for Vital and Daily Care', async () => {
  const calls = new Map(); const session = ui.createSession({ request:async (requestPath) => {
    const kind = requestPath.includes('vital-signs') ? 'vital' : 'daily'; const count = (calls.get(kind) || 0) + 1; calls.set(kind, count);
    if (kind === 'vital') return count === 1 ? {items:[vital()],nextCursor:'V-NEXT'} : {items:[vital(),vital({vitalSetId:'VS-2'})],nextCursor:null};
    return count === 1 ? {items:[daily()],nextCursor:'D-NEXT'} : {items:[daily(),daily({dailyReportId:'DC-2'})],nextCursor:null};
  } });
  session.setProfile('CP-1'); await session.open(); await session.loadMoreVitals(); await session.loadMoreDaily();
  assert.deepEqual(session.snapshot().vitals.map((item) => item.vitalSetId), ['VS-1','VS-2']);
  assert.deepEqual(session.snapshot().daily.map((item) => item.dailyReportId), ['DC-1','DC-2']);
});

test('Care Profile switching clears clinical state immediately and ignores every stale response', async () => {
  const waits = [deferred(), deferred()]; let index = 0;
  const session = ui.createSession({ request:() => waits[index++].promise });
  session.setProfile('CP-A'); const pending = session.open(); session.setProfile('CP-B');
  assert.deepEqual(session.snapshot().vitals, []); assert.deepEqual(session.snapshot().daily, []); assert.equal(session.snapshot().profileId, 'CP-B');
  waits[0].resolve({items:[vital()],nextCursor:null}); waits[1].resolve({items:[daily()],nextCursor:null}); await pending;
  assert.deepEqual(session.snapshot().vitals, []); assert.deepEqual(session.snapshot().daily, []);
});

test('a failed read exposes only a safe state and remains retryable', async () => {
  let fail = true; const session = ui.createSession({ request:async (requestPath) => {
    if (requestPath.includes('vital-signs') && fail) { fail = false; throw Object.assign(new Error('SELECT secret'), {errorCode:'VITAL_DOWN',status:503}); }
    return {items:[],nextCursor:null};
  } });
  session.setProfile('CP-1'); await session.open(); assert.deepEqual(session.snapshot().vitalError, {errorCode:'VITAL_DOWN',status:503});
  assert.doesNotMatch(JSON.stringify(session.snapshot()), /SELECT secret/); await session.loadVitals(); assert.equal(session.snapshot().vitalError, null);
});

test('Family care UI has mobile/no-overflow structure and no browser clinical persistence', () => {
  assert.match(css, /overflow-wrap:anywhere/); assert.match(css, /min-height:44px/); assert.match(css, /focus-visible/); assert.match(css, /@media\(max-width:640px\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|history\.pushState|location\.(?:hash|search)/);
  assert.doesNotMatch(source, /innerHTML/);
});
