const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = require('../liff-app/family/lab-results-ui');
const html = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'index.html'), 'utf8');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'lab-results-ui.js'), 'utf8');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.listeners = {};
    this.attributes = {};
  }

  get firstChild() { return this.children[0] || null; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this; this.children.push(child); return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null; return child;
  }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  querySelectorAll(selector) {
    const matches = [];
    const walk = (node) => node.children.forEach((child) => {
      if (selector === 'button' && child.tagName === 'button') matches.push(child);
      walk(child);
    });
    walk(this); return matches;
  }
  set innerHTML(_) { throw new Error('Unsafe innerHTML was used'); }
}

const fakeDocument = () => ({ createElement: (tagName) => new FakeElement(tagName) });

function flattenedText(node) {
  return [node.textContent, ...node.children.flatMap((child) => flattenedText(child))]
    .filter(Boolean).join(' ');
}

function report(overrides = {}) {
  return {
    reportId: 'LABR-1', reportGroupId: 'LABG-1', status: 'confirmed',
    hospitalName: 'โรงพยาบาลกลาง', laboratoryName: 'ห้องปฏิบัติการกลาง',
    specimenCollectedAt: '2026-08-20T08:00:00.000Z', reportedAt: '2026-08-20T10:00:00.000Z',
    observations: [], ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    observationId: 'LABO-1', analyteNameSource: 'HbA1c', sourceValueText: '6.5',
    sourceUnit: '%', referenceRangeText: '4.0-6.0', abnormalFlagSource: 'H',
    specimenSource: 'Whole blood', methodSource: 'HPLC', valueType: 'numeric', numericValue: 6.5,
    loincCode: '4548-4', loincVerificationSource: 'human_verified',
    loincVerifiedAt: '2026-08-20T11:00:00.000Z', comparisonKey: 'hba1c', ...overrides,
  };
}

function trend(overrides = {}) {
  return {
    status: 'available', sourceDisplayName: 'HbA1c', direction: 'increased', rangesDiffer: false,
    observations: [
      { specimenCollectedAt: '2026-01-01T08:00:00Z', sourceValueText: '6.1', sourceUnit: '%', referenceRangeText: '4.0-6.0' },
      { specimenCollectedAt: '2026-08-01T08:00:00Z', sourceValueText: '6.5', sourceUnit: '%', referenceRangeText: '4.0-6.0' },
    ], ...overrides,
  };
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('Family LIFF exposes one Care Profile-centered ผลตรวจ entry and loads its dedicated module', () => {
  assert.equal((html.match(/id="labResultsPanel"/g) || []).length, 1);
  assert.equal((html.match(/id="labResultsEntry"/g) || []).length, 1);
  assert.match(html, />ผลตรวจ</);
  assert.match(html, /lab-results-ui\.js/);
  assert.match(html, /lab-results-ui\.css/);
});

test('history request is scoped to selected Care Profile and never requests drafts/history versions', () => {
  const request = ui.buildHistoryRequest('CP A');
  assert.match(request.path, /^\/api\/care-profile\/CP%20A\/lab-reports\?/);
  assert.match(request.path, /limit=10/);
  assert.doesNotMatch(request.path, /includeDrafts|includeHistory|centerId|lineUserId/);
});

test('opening without a selected Care Profile fails safely without a backend call', async () => {
  let calls = 0;
  const session = ui.createSession({ request: async () => { calls += 1; } });
  await session.open();
  assert.equal(calls, 0);
  assert.equal(session.snapshot().historyError.errorCode, 'CARE_PROFILE_REQUIRED');
});

test('history keeps confirmed reports and excludes draft and voided records defensively', () => {
  const result = ui.mergeReports([], [
    report(), report({ reportId: 'DRAFT', status: 'draft' }), report({ reportId: 'VOID', status: 'voided' }),
  ]);
  assert.deepEqual(result.map((item) => item.reportId), ['LABR-1']);
});

test('empty confirmed history has a deterministic empty state after loading', async () => {
  const session = ui.createSession({ request: async () => ({ items: [], nextCursor: null }) });
  session.setProfile('CP-1'); await session.open();
  assert.deepEqual(session.snapshot().reports, []);
  assert.equal(session.snapshot().historyLoading, false);
  assert.equal(session.snapshot().historyError, null);
});

test('history exposes loading state while request is pending', async () => {
  const wait = deferred();
  const snapshots = [];
  const session = ui.createSession({ request: async () => wait.promise, onChange: (state) => snapshots.push(state) });
  session.setProfile('CP-1'); const loading = session.open();
  assert.equal(session.snapshot().historyLoading, true);
  wait.resolve({ items: [], nextCursor: null }); await loading;
  assert.equal(snapshots.some((state) => state.historyLoading), true);
});

test('history failure is projected as a safe code and remains retryable', async () => {
  let fail = true;
  const session = ui.createSession({ request: async () => {
    if (fail) { fail = false; const error = new Error('SELECT clinical secret'); error.errorCode = 'LAB_UNAVAILABLE'; throw error; }
    return { items: [report()], nextCursor: null };
  } });
  session.setProfile('CP-1'); await session.open();
  assert.equal(session.snapshot().historyError.errorCode, 'LAB_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(session.snapshot()), /SELECT clinical secret/);
  await session.loadHistory();
  assert.equal(session.snapshot().reports.length, 1);
});

test('pagination appends the second page and uses the opaque cursor', async () => {
  const calls = [];
  const session = ui.createSession({ request: async (requestPath) => {
    calls.push(requestPath);
    return calls.length === 1
      ? { items: [report()], nextCursor: 'opaque cursor' }
      : { items: [report({ reportId: 'LABR-2' })], nextCursor: null };
  } });
  session.setProfile('CP-1'); await session.open(); await session.loadMore();
  assert.deepEqual(session.snapshot().reports.map((item) => item.reportId), ['LABR-1', 'LABR-2']);
  assert.match(calls[1], /cursor=opaque\+cursor|cursor=opaque%20cursor/);
  assert.equal(session.snapshot().nextCursor, null);
});

test('pagination never duplicates a report returned again by backend', async () => {
  let page = 0;
  const session = ui.createSession({ request: async () => (++page === 1
    ? { items: [report()], nextCursor: 'NEXT' }
    : { items: [report(), report({ reportId: 'LABR-2' })], nextCursor: null }) });
  session.setProfile('CP-1'); await session.open(); await session.loadMore();
  assert.deepEqual(session.snapshot().reports.map((item) => item.reportId), ['LABR-1', 'LABR-2']);
});

test('detail request is profile and report scoped without actor metadata', () => {
  const request = ui.buildDetailRequest('CP-1', 'LABR-1');
  assert.equal(request.path, '/api/care-profile/CP-1/lab-reports/LABR-1');
  assert.doesNotMatch(JSON.stringify(request), /lineUser|actor|pendingCard|sourceReference/);
});

test('Lab correction and void requests are explicit profile-scoped actions with no actor metadata', () => {
  const correction=ui.buildCorrectionRequest('CP-1','LABR-1','แก้ผลตรวจ');
  const voidRequest=ui.buildVoidRequest('CP-1','LABR-1','เอกสารผิดคน');
  const update=ui.buildDraftUpdateRequest('CP-1','LABR-V2',{hospitalName:'โรงพยาบาลตัวอย่าง',observations:[]});
  const confirm=ui.buildDraftConfirmRequest('CP-1','LABR-V2');
  assert.equal(correction.path,'/api/care-profile/CP-1/lab-reports/LABR-1/corrections');
  assert.deepEqual(JSON.parse(correction.options.body),{reason:'แก้ผลตรวจ'});
  assert.equal(voidRequest.path,'/api/care-profile/CP-1/lab-reports/LABR-1/void');
  assert.deepEqual(JSON.parse(voidRequest.options.body),{reason:'เอกสารผิดคน'});
  assert.equal(update.options.method,'PATCH');assert.match(update.path,/LABR-V2\/draft$/);
  assert.equal(confirm.options.method,'POST');assert.deepEqual(JSON.parse(confirm.options.body),{});
  assert.doesNotMatch(JSON.stringify([correction,voidRequest,update,confirm]),/lineUser|actor|centerId|groupId/);
  const draftPatch=ui.correctionDraftPatch({observations:[observation({sourceValueText:'6.5'})]});
  assert.deepEqual({valueType:draftPatch.observations[0].valueType,numericValue:draftPatch.observations[0].numericValue,textValue:draftPatch.observations[0].textValue},{valueType:'numeric',numericValue:6.5,textValue:null});
});

test('detail accepts confirmed canonical observations only', async () => {
  const detail = report({ observations: [observation()] });
  const session = ui.createSession({ request: async () => detail });
  session.setProfile('CP-1'); await session.selectReport('LABR-1');
  assert.equal(session.snapshot().selectedReport.observations[0].analyteNameSource, 'HbA1c');
  assert.equal(session.snapshot().selectedReport.status, 'confirmed');
});

test('Family Lab session allowlists detail fields and drops internal source event and actor metadata', async () => {
  const session = ui.createSession({ request: async () => report({
    createdByActorType: 'family_owner', sources: [{ sourceId: 'SOURCE-SECRET', pendingCardId: 'PENDING-SECRET' }],
    events: [{ eventId: 'EVENT-SECRET' }], observations: [observation({
      sourceRegion: 'REGION-SECRET', extractionConfidence: 0.9, loincVerifiedBy: 'ACTOR-SECRET',
    })],
  }) });
  session.setProfile('CP-1'); await session.selectReport('LABR-1');
  const serialized = JSON.stringify(session.snapshot());
  for (const secret of ['SOURCE-SECRET', 'PENDING-SECRET', 'EVENT-SECRET', 'REGION-SECRET', 'ACTOR-SECRET', 'createdByActorType', 'extractionConfidence']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.match(serialized, /HbA1c/);
});

test('draft detail is rejected defensively and not presented as confirmed', async () => {
  const session = ui.createSession({ request: async () => report({ status: 'draft' }) });
  session.setProfile('CP-1'); await session.selectReport('DRAFT');
  assert.equal(session.snapshot().selectedReport, null);
  assert.equal(session.snapshot().detailError.errorCode, 'CONFIRMED_REPORT_NOT_FOUND');
});

test('observation renderer preserves source name value unit range and source-attributed flag', () => {
  const doc = fakeDocument(); const box = new FakeElement('div');
  ui.renderObservation(doc, box, observation(), { disabled: false, onTrend() {}, onExplain() {} });
  const text = flattenedText(box);
  for (const value of ['HbA1c', '6.5', '%', '4.0-6.0', 'ตามรายงานต้นฉบับ: H', 'Whole blood', 'HPLC']) assert.match(text, new RegExp(value));
});

test('missing unit and range remain visibly missing instead of invented', () => {
  const doc = fakeDocument(); const box = new FakeElement('div');
  ui.renderObservation(doc, box, observation({ sourceUnit: null, referenceRangeText: null, abnormalFlagSource: null }), { disabled: false, onTrend() {}, onExplain() {} });
  const text = flattenedText(box);
  assert.equal((text.match(/ไม่ระบุในรายงาน/g) || []).length >= 2, true);
  assert.doesNotMatch(text, /ปกติ|สูง|ต่ำ/);
});

test('frontend never infers abnormality from numeric values when source flag is absent', () => {
  const doc = fakeDocument(); const box = new FakeElement('div');
  ui.renderObservation(doc, box, observation({ sourceValueText: '999', numericValue: 999, abnormalFlagSource: null }), { disabled: false, onTrend() {}, onExplain() {} });
  const text = flattenedText(box);
  assert.match(text, /999/);
  assert.doesNotMatch(text, /ผิดปกติ|อันตราย|critical|high|low/i);
});

test('clinical HTML/script injection is rendered through textContent', () => {
  const doc = fakeDocument(); const box = new FakeElement('div');
  ui.renderObservation(doc, box, observation({ analyteNameSource: '<img src=x onerror=alert(1)>', sourceValueText: '<script>bad()</script>' }), { disabled: false, onTrend() {}, onExplain() {} });
  assert.match(flattenedText(box), /<img src=x onerror=alert\(1\)>/);
  assert.match(flattenedText(box), /<script>bad\(\)<\/script>/);
});

test('verified LOINC identity is preferred and unverified LOINC falls back to comparison key', () => {
  assert.deepEqual(ui.observationIdentity(observation()), { loincCode: '4548-4' });
  assert.deepEqual(ui.observationIdentity(observation({ loincVerificationSource: null, loincVerifiedAt: null })), { comparisonKey: 'hba1c' });
  assert.equal(ui.observationIdentity(observation({ loincCode: null, comparisonKey: null })), null);
});

test('trend request transmits exactly one trusted identity and a bounded limit', () => {
  const loinc = ui.buildTrendRequest('CP-1', { loincCode: '4548-4' });
  const key = ui.buildTrendRequest('CP-1', { comparisonKey: 'Hb A1c' });
  assert.match(loinc.path, /loincCode=4548-4&limit=20$/);
  assert.match(key.path, /comparisonKey=Hb%20A1c&limit=20$/);
  assert.doesNotMatch(`${loinc.path}${key.path}`, /sourceValue|range|method|specimen/);
});

test('comparable trend renders chronological source values and increased direction factually', () => {
  const doc = fakeDocument(); const box = new FakeElement('div');
  ui.renderTrend(doc, box, trend(), 'HbA1c');
  const text = flattenedText(box);
  assert.match(text, /เพิ่มขึ้น/); assert.ok(text.indexOf('6.1') < text.indexOf('6.5'));
  assert.doesNotMatch(text, /ดีขึ้น|แย่ลง|ปลอดภัย|อันตราย/);
});

test('decreased and unchanged direction mappings remain neutral', () => {
  assert.equal(ui.DIRECTION_LABELS.decreased, 'ลดลง');
  assert.equal(ui.DIRECTION_LABELS.unchanged, 'ใกล้เคียงเดิม / ไม่เปลี่ยนแปลง');
  assert.doesNotMatch(Object.values(ui.DIRECTION_LABELS).join(' '), /ดีขึ้น|แย่ลง/);
});

test('non-comparable trends always show canonical safe meaning plus mapped reason', () => {
  const doc = fakeDocument();
  for (const code of ['UNIT_INCOMPATIBLE', 'METHOD_MISMATCH', 'SPECIMEN_MISMATCH', 'INSUFFICIENT_CONFIRMED_HISTORY', 'ANALYTE_IDENTITY_UNVERIFIED']) {
    const box = new FakeElement('div');
    ui.renderTrend(doc, box, trend({ status: 'not_comparable', reasonCode: code, direction: null, observations: [] }), 'Lab');
    const text = flattenedText(box);
    assert.match(text, new RegExp(ui.SAFE_TREND_MESSAGE));
    assert.match(text, new RegExp(ui.TREND_REASON_LABELS[code]));
  }
});

test('range differences remain source caveats and never become clinical judgments', () => {
  const doc = fakeDocument(); const box = new FakeElement('div');
  ui.renderTrend(doc, box, trend({ rangesDiffer: true }), 'HbA1c');
  const text = flattenedText(box);
  assert.match(text, /ช่วงอ้างอิง.*แตกต่างกัน/);
  assert.doesNotMatch(text, /ดีขึ้น|แย่ลง/);
});

test('missing deterministic identity returns safe non-comparable locally without API request', async () => {
  let trendCalls = 0;
  const session = ui.createSession({ request: async (requestPath) => {
    if (requestPath.includes('/lab-trends')) trendCalls += 1;
    return report({ observations: [observation({ loincCode: null, comparisonKey: null })] });
  } });
  session.setProfile('CP-1'); await session.selectReport('LABR-1'); await session.loadTrend('LABO-1');
  assert.equal(trendCalls, 0);
  assert.equal(session.snapshot().trend.reasonCode, 'ANALYTE_IDENTITY_UNVERIFIED');
});

test('Lab explanation is never generated by opening history or report detail', async () => {
  const calls = [];
  const session = ui.createSession({ request: async (requestPath) => {
    calls.push(requestPath);
    if (requestPath.includes('/lab-reports/')) return report({ observations: [observation()] });
    return { items: [report()], nextCursor: null };
  } });
  session.setProfile('CP-1'); await session.open(); await session.selectReport('LABR-1');
  assert.equal(calls.some((requestPath) => requestPath.endsWith('/lab-explanations')), false);
});

test('explicit explanation request sends only trusted observation identity', () => {
  const request = ui.buildExplanationRequest('CP-1', { loincCode: '4548-4' });
  assert.equal(request.path, '/api/care-profile/CP-1/lab-explanations');
  assert.deepEqual(JSON.parse(request.options.body), { identity: { loincCode: '4548-4' } });
  assert.doesNotMatch(request.options.body, /sourceValue|referenceRange|phone|lineUser|raw/);
});

test('structured explanation renders approved sections and ignores raw provider fields', () => {
  const doc = fakeDocument(); const box = new FakeElement('div');
  ui.renderExplanation(doc, box, {
    status: 'answer', summary: 'สรุปผล', testExplanation: 'วัดค่านี้',
    confirmedFacts: [{ observedAt: '2026-08-01T00:00:00Z', analyteNameSource: 'HbA1c', sourceValueText: '6.5', sourceUnit: '%' }],
    trendExplanation: 'ค่าเพิ่มขึ้นตามลำดับเวลา', rangeCaveat: 'ช่วงอ้างอิงต่างกัน',
    questionsForClinician: ['ควรติดตามเมื่อไร'], safetyNotice: 'ให้บุคลากรพิจารณา',
    disclaimer: 'ไม่ใช่การวินิจฉัย', rawProviderResponse: 'SECRET MODEL OUTPUT', provider: 'secret-model',
  });
  const text = flattenedText(box);
  for (const value of ['สรุป', 'รายการตรวจนี้วัดอะไร', 'ข้อมูลที่ยืนยันแล้ว', 'แนวโน้ม', 'คำถามที่อาจถามแพทย์']) assert.match(text, new RegExp(value));
  assert.doesNotMatch(text, /SECRET MODEL OUTPUT|secret-model/);
});

test('Plus-required, rate-limited, and unavailable explanation states are safe', () => {
  assert.equal(ui.errorView({ errorCode: 'PLUS_FEATURE_NOT_INCLUDED', status: 403 }, 'explanation').kind, 'plus');
  assert.match(ui.errorView({ errorCode: 'PLUS_RATE_LIMITED', retryAfterSeconds: 45 }, 'explanation').message, /45 วินาที/);
  const unavailable = ui.errorView({ errorCode: 'AI_PROVIDER_ERROR' }, 'explanation');
  assert.doesNotMatch(unavailable.message, /AI_PROVIDER_ERROR|provider|stack|SQL/i);
});

test('explanation generation loading state and double-submit protection are deterministic', async () => {
  const wait = deferred(); let explanationCalls = 0;
  const session = ui.createSession({ request: async (requestPath) => {
    if (requestPath.endsWith('/lab-explanations')) { explanationCalls += 1; return wait.promise; }
    return report({ observations: [observation()] });
  } });
  session.setProfile('CP-1'); await session.selectReport('LABR-1');
  const first = session.generateExplanation('LABO-1');
  assert.equal(session.snapshot().explanationLoading, true);
  assert.deepEqual(await session.generateExplanation('LABO-1'), { ignored: true });
  wait.resolve({ status: 'answer', summary: 'สรุป', testExplanation: 'อธิบาย' }); await first;
  assert.equal(explanationCalls, 1);
  assert.equal(session.snapshot().explanation.status, 'answer');
});

test('explanation state never mutates Lab through any write endpoint', () => {
  const request=ui.buildExplanationRequest('CP-1',{comparisonKey:'hba1c'});
  assert.match(request.path,/lab-explanations$/);assert.doesNotMatch(JSON.stringify(request),/draft|confirm|void|corrections|PATCH|DELETE/);
});

test('switching Care Profile clears all Lab clinical and transient state immediately', async () => {
  const session = ui.createSession({ request: async (requestPath) => requestPath.includes('/lab-reports/')
    ? report({ observations: [observation()] }) : { items: [report()], nextCursor: null } });
  session.setProfile('CP-1'); await session.open(); await session.selectReport('LABR-1');
  session.setProfile('CP-2');
  const state = session.snapshot();
  assert.equal(state.profileId, 'CP-2'); assert.equal(state.opened, false);
  assert.deepEqual(state.reports, []); assert.equal(state.selectedReport, null);
  assert.equal(state.trend, null); assert.equal(state.explanation, null);
  assert.equal(state.historyError, null); assert.equal(state.detailError, null);
});

test('stale history response from profile A cannot render in profile B', async () => {
  const wait = deferred();
  const session = ui.createSession({ request: async (requestPath) => requestPath.includes('CP-1')
    ? wait.promise : { items: [report({ reportId: 'LABR-B' })], nextCursor: null } });
  session.setProfile('CP-1'); const first = session.open();
  session.setProfile('CP-2'); await session.open(); wait.resolve({ items: [report({ reportId: 'LABR-A' })] }); await first;
  assert.deepEqual(session.snapshot().reports.map((item) => item.reportId), ['LABR-B']);
});

test('stale report detail from profile A cannot render in profile B', async () => {
  const wait = deferred();
  const session = ui.createSession({ request: async () => wait.promise });
  session.setProfile('CP-1'); const first = session.selectReport('LABR-A');
  session.setProfile('CP-2'); wait.resolve(report({ reportId: 'LABR-A', observations: [observation()] })); await first;
  assert.equal(session.snapshot().selectedReport, null);
});

test('stale Lab mutation cannot change newly selected Care Profile and double submit is ignored', async () => {
  const wait=deferred();let mutationCalls=0;
  const session=ui.createSession({request:async(requestPath)=>{
    if(requestPath.includes('/corrections')){mutationCalls+=1;return wait.promise;}
    return requestPath.includes('/lab-reports/')?report({observations:[observation()] }):{items:[],nextCursor:null};
  }});
  session.setProfile('CP-1');await session.selectReport('LABR-1');
  const pending=session.createCorrection('LABR-1','แก้ไข');
  assert.deepEqual(await session.createCorrection('LABR-1','ซ้ำ'),{ignored:true});
  session.setProfile('CP-2');wait.resolve({reportId:'LABR-V2',status:'draft',privateValue:'PRIVATE-P1'});
  assert.deepEqual(await pending,{ignored:true,stale:true});
  assert.equal(mutationCalls,1);assert.equal(session.snapshot().profileId,'CP-2');
  assert.doesNotMatch(JSON.stringify(session.snapshot()),/PRIVATE-P1/);
});

test('Family correction V2 can be reviewed, saved and confirmed through the Lab workspace', async () => {
  const calls=[];
  const v2=report({reportId:'LABR-V2',status:'draft',hospitalName:'โรงพยาบาลเดิม',observations:[observation()]});
  const session=ui.createSession({request:async(requestPath,options)=>{
    calls.push({requestPath,options});
    if(requestPath.endsWith('/corrections'))return v2;
    if(requestPath.endsWith('/draft'))return {...v2,hospitalName:'โรงพยาบาลแก้ไข'};
    if(requestPath.endsWith('/confirm'))return report({reportId:'LABR-V2',status:'confirmed',versionNo:2,isCurrent:true,observations:[observation()]});
    if(requestPath.includes('?'))return{items:[],nextCursor:null};
    return report({observations:[observation()]});
  }});
  session.setProfile('CP-1');await session.selectReport('LABR-1');await session.createCorrection('LABR-1','แก้ข้อมูลต้นฉบับ');
  assert.equal(session.snapshot().correctionDraft.reportId,'LABR-V2');
  const draft={...session.snapshot().correctionDraft,hospitalName:'โรงพยาบาลแก้ไข'};
  await session.saveCorrection(draft);assert.equal(session.snapshot().correctionDraft.hospitalName,'โรงพยาบาลแก้ไข');
  await session.confirmCorrection(draft);assert.equal(session.snapshot().correctionDraft,null);
  assert.match(session.snapshot().actionNotice,/ยืนยันผลตรวจฉบับแก้ไขแล้ว/);
  assert.deepEqual(calls.filter((item)=>/\/(?:draft|confirm)$/.test(item.requestPath)).map((item)=>item.options.method),['PATCH','PATCH','POST']);
});

test('profile switch clears Family Lab correction draft and stale confirmation cannot cross profiles', async () => {
  const wait=deferred();let confirms=0;
  const v2=report({reportId:'LABR-V2',status:'draft',observations:[observation()]});
  const session=ui.createSession({request:async(requestPath)=>{
    if(requestPath.endsWith('/corrections'))return v2;
    if(requestPath.endsWith('/draft'))return v2;
    if(requestPath.endsWith('/confirm')){confirms+=1;return wait.promise;}
    if(requestPath.includes('?'))return{items:[],nextCursor:null};
    return report({observations:[observation()]});
  }});
  session.setProfile('CP-1');await session.selectReport('LABR-1');await session.createCorrection('LABR-1','แก้ไข');
  const pending=session.confirmCorrection(v2);session.setProfile('CP-2');wait.resolve(report({reportId:'LABR-V2',status:'confirmed'}));
  assert.deepEqual(await pending,{ignored:true,stale:true});assert.equal(confirms,0);
  assert.equal(session.snapshot().profileId,'CP-2');assert.equal(session.snapshot().correctionDraft,null);
});

test('latest report selection wins when an earlier detail request is still in flight', async () => {
  const firstWait = deferred();
  const session = ui.createSession({ request: async (requestPath) => requestPath.endsWith('/LABR-A')
    ? firstWait.promise : report({ reportId: 'LABR-B', observations: [observation({ observationId: 'LABO-B' })] }) });
  session.setProfile('CP-1');
  const first = session.selectReport('LABR-A');
  await session.selectReport('LABR-B');
  firstWait.resolve(report({ reportId: 'LABR-A', observations: [observation()] })); await first;
  assert.equal(session.snapshot().selectedReport.reportId, 'LABR-B');
  assert.equal(session.snapshot().selectedReport.observations[0].observationId, 'LABO-B');
});

test('stale trend response from profile A cannot render in profile B', async () => {
  const wait = deferred();
  const session = ui.createSession({ request: async (requestPath) => requestPath.includes('/lab-trends')
    ? wait.promise : report({ observations: [observation()] }) });
  session.setProfile('CP-1'); await session.selectReport('LABR-A'); const first = session.loadTrend('LABO-1');
  session.setProfile('CP-2'); wait.resolve(trend()); await first;
  assert.equal(session.snapshot().trend, null);
});

test('stale Plus explanation response from profile A cannot render in profile B', async () => {
  const wait = deferred();
  const session = ui.createSession({ request: async (requestPath) => requestPath.endsWith('/lab-explanations')
    ? wait.promise : report({ observations: [observation()] }) });
  session.setProfile('CP-1'); await session.selectReport('LABR-A'); const first = session.generateExplanation('LABO-1');
  session.setProfile('CP-2'); wait.resolve({ status: 'answer', summary: 'PRIVATE A' }); await first;
  assert.equal(session.snapshot().explanation, null);
  assert.doesNotMatch(JSON.stringify(session.snapshot()), /PRIVATE A/);
});

test('Family Lab module never persists clinical data in browser storage or URL state', () => {
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  assert.doesNotMatch(source, /location\.(?:search|hash)|history\.(?:pushState|replaceState)/);
  assert.doesNotMatch(source, /console\.(?:log|info|debug)\s*\(/);
});

test('history and observation rendering omit internal/source/contact identifiers and Base64', () => {
  const doc = fakeDocument(); const history = new FakeElement('div'); const detail = new FakeElement('div');
  ui.renderHistory(doc, history, [report({
    reportId: 'SECRET-REPORT', reportGroupId: 'SECRET-GROUP', pendingCardId: 'PENDING-SECRET',
    sourceReference: 'SOURCE-SECRET', actorId: 'ACTOR-SECRET', lineUserId: 'LINE-SECRET', phone: '0812345678',
  })], () => {});
  ui.renderObservation(doc, detail, observation({
    observationId: 'SECRET-OBS', sourceRegion: 'BASE64-SECRET', phone: '0899999999', lineUserId: 'LINE-SECRET',
  }), { disabled: false, onTrend() {}, onExplain() {} });
  const rendered = `${flattenedText(history)} ${flattenedText(detail)}`;
  for (const secret of ['SECRET-REPORT', 'SECRET-GROUP', 'PENDING-SECRET', 'SOURCE-SECRET', 'ACTOR-SECRET', 'LINE-SECRET', '0812345678', '0899999999', 'BASE64-SECRET']) {
    assert.equal(rendered.includes(secret), false, secret);
  }
});

test('access denial fails closed without exposing backend details', () => {
  const view = ui.errorView({ status: 403, errorCode: 'MEMBERSHIP_REVOKED', raw: 'LINE-U SQL' }, 'history');
  assert.equal(view.kind, 'access');
  assert.match(view.message, /ไม่สามารถเข้าถึง/);
  assert.doesNotMatch(view.message, /MEMBERSHIP|LINE|SQL/);
});

test('UI communicates confirmed and source-flag status with text rather than color alone', () => {
  const doc = fakeDocument(); const history = new FakeElement('div'); const details = new FakeElement('div');
  ui.renderHistory(doc, history, [report()], () => {});
  ui.renderObservation(doc, details, observation(), { disabled: false, onTrend() {}, onExplain() {} });
  assert.match(flattenedText(history), /ยืนยันแล้ว/);
  assert.match(flattenedText(details), /ตามรายงานต้นฉบับ/);
});

test('mobile UI avoids a chart dependency and provides touch-oriented textual trend controls', () => {
  assert.doesNotMatch(source, /Chart\.|chart\.js|d3\.|plotly/i);
  assert.match(html, /ดูผลตรวจ/);
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'lab-results-ui.css'), 'utf8');
  assert.match(css, /min-height:44px/);
  assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /@media \(max-width:380px\)/);
});

test('Lab detail connects to existing ถามหมออะไรดี flow without duplicating its request builder', () => {
  assert.match(source, /เตรียมคำถามสำหรับพบแพทย์/);
  assert.match(html, /PLUS_UI\.runQuickAction\('doctor-questions'\)/);
  assert.equal((source.match(/doctor-questions/g) || []).length, 0);
});

test('Lab UI keeps source-document creation out while exposing bounded correction review actions', () => {
  const combined = `${html.match(/<section class="card lab-results-panel"[\s\S]*?<section class="card consultation-panel"/)?.[0] || ''}\n${source}`;
  assert.doesNotMatch(combined, /เอกสารต้นฉบับ|imageBase64|pendingCardId|สร้างผลตรวจใหม่/);
  assert.doesNotMatch(source, /MedicationSnapshot|Appointment.*create/);
  assert.match(source,/สร้างฉบับแก้ไข/);assert.match(source,/ยกเลิกรายการ/);
  assert.match(source,/ตรวจฉบับแก้ไข/);assert.match(source,/ยืนยันฉบับแก้ไข/);
});
