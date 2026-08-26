const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const plusUI = require('../liff-app/family/plus-ui');
const familyHtml = fs.readFileSync(path.join(__dirname, '..', 'liff-app', 'family', 'index.html'), 'utf8');
const plusSource = fs.readFileSync(path.join(__dirname, '..', 'liff-app', 'family', 'plus-ui.js'), 'utf8');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.listeners = {};
  }

  get firstChild() { return this.children[0] || null; }
  appendChild(child) { this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); return child; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  set innerHTML(_) { throw new Error('Unsafe innerHTML was used'); }
}

const fakeDocument = () => ({ createElement: (tagName) => new FakeElement(tagName) });

test('Plus UI ซ่อนเมื่อ Plus disabled หรือไม่มี entitlement', () => {
  assert.equal(plusUI.isInternalEntitlement({ status: 'unavailable', errorCode: 'PLUS_DISABLED' }), false);
  assert.equal(plusUI.isInternalEntitlement({ status: 'basic', plus: false }), false);
});

test('Plus UI แสดงเฉพาะ active internal entitlement จาก backend', () => {
  assert.equal(plusUI.isInternalEntitlement({ status: 'active', plus: true, source: 'internal' }), true);
  assert.equal(plusUI.isInternalEntitlement({ status: 'active', plus: true, source: 'payment' }), false);
  assert.equal(plusUI.isInternalEntitlement({ status: 'expired', plus: true, source: 'internal' }), false);
});

test('Family LIFF มี panel ทดสอบที่ซ่อนเป็นค่าเริ่มต้นและไม่มีราคา/สมัคร', () => {
  const panel = familyHtml.match(/<section class="card plus-panel"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(panel, /id="plusPanel"[^>]*hidden/);
  assert.match(panel, /พี่หมอ Plus — ทดสอบภายใน/);
  assert.match(panel, /INTERNAL TEST/);
  assert.doesNotMatch(panel, /59\s*บาท|สมัคร/);
});

test('Family LIFF มี quick action รวมปุ่มถามหมออะไรดี', () => {
  for (const action of plusUI.QUICK_ACTIONS) {
    assert.match(familyHtml, new RegExp(`data-plus-action="${action.id}"`));
  }
  assert.equal(plusUI.QUICK_ACTIONS.length, 7);
  assert.equal(plusUI.QUICK_ACTIONS.find((item) => item.id === 'doctor-questions').doctorQuestions, true);
});

test('switch Care Profile ล้างบทสนทนาและคำขอล่าสุด', async () => {
  const session = plusUI.createSession({ send: async () => ({ status: 'answer', data: {} }) });
  session.setProfile('cp-1');
  await session.submit({ path: '/ask', body: {} }, 'ข้อมูลคนแรก');
  assert.equal(session.snapshot().messages.length, 2);
  session.setProfile('cp-2');
  assert.deepEqual(session.snapshot().messages, []);
  assert.equal(session.snapshot().lastRequest, null);
});

test('response ของ Care Profile เดิมไม่กลับมาแสดงหลังสลับโปรไฟล์ระหว่างโหลด', async () => {
  let resolveRequest;
  const pending = new Promise((resolve) => { resolveRequest = resolve; });
  const session = plusUI.createSession({ send: async () => pending });
  session.setProfile('cp-1');
  const first = session.submit({ path: '/ask', body: {} }, 'ข้อมูลคนแรก');
  session.setProfile('cp-2');
  resolveRequest({ status: 'answer', data: { summary: 'ข้อมูลลับของคนแรก' } });
  assert.deepEqual(await first, { ignored: true, stale: true });
  assert.deepEqual(session.snapshot().messages, []);
  assert.equal(session.snapshot().profileId, 'cp-2');
});

test('answer render รองรับ summary, key points, missing information และ disclaimer', () => {
  const view = plusUI.responseToViewModel({
    status: 'answer', data: { summary: 'สรุป', keyPoints: ['หนึ่ง'], missingInformation: ['เวลา'], disclaimer: 'อ้างอิงข้อมูลที่บันทึกไว้' },
  });
  assert.equal(view.kind, 'answer');
  assert.deepEqual(view.keyPoints, ['หนึ่ง']);
  assert.deepEqual(view.missingInformation, ['เวลา']);
  assert.equal(view.disclaimer, 'อ้างอิงข้อมูลที่บันทึกไว้');
});

test('pharmacist escalation render เป็น safety card', () => {
  const view = plusUI.responseToViewModel({ status: 'escalation', type: 'pharmacist', message: 'ตรวจสอบกับผู้เชี่ยวชาญ' });
  assert.equal(view.kind, 'pharmacist');
  assert.equal(view.title, 'เรื่องยา พี่หมอไม่เดา');
});

test('medical escalation render โดยไม่เพิ่มคำแนะนำการรักษา', () => {
  const view = plusUI.responseToViewModel({ status: 'escalation', type: 'medical', message: 'ควรพบแพทย์' });
  assert.equal(view.kind, 'medical');
  assert.equal(view.summary, 'ควรพบแพทย์');
});

test('unavailable และ needs_review แสดงข้อความปลอดภัย', () => {
  const unavailable = plusUI.responseToViewModel({ status: 'unavailable', errorCode: 'AI_TIMEOUT', rawError: 'secret' });
  const review = plusUI.responseToViewModel({ status: 'needs_review' });
  assert.equal(unavailable.kind, 'unavailable');
  assert.doesNotMatch(`${unavailable.title}${unavailable.summary}`, /AI_TIMEOUT|secret/);
  assert.equal(review.kind, 'needs_review');
  assert.equal(review.retryable, true);
});

test('Plus-required response แสดงสถานะสิทธิ์โดยไม่เปิดเผยข้อมูล backend', () => {
  const view = plusUI.responseToViewModel({
    status: 'unavailable', errorCode: 'PLUS_FEATURE_NOT_INCLUDED', raw: 'database secret',
  });
  assert.equal(view.title, 'ฟีเจอร์นี้ใช้สิทธิ์พี่หมอ Plus');
  assert.equal(view.retryable, false);
  assert.doesNotMatch(`${view.title}${view.summary}`, /database|secret/);
});

test('AI HTML ถูก render เป็น text และไม่ใช้ innerHTML', () => {
  const doc = fakeDocument();
  const container = new FakeElement('div');
  plusUI.renderResponse(doc, container, { status: 'answer', data: { summary: '<img src=x onerror=alert(1)>', keyPoints: ['<script>bad()</script>'] } });
  const card = container.children[0];
  assert.equal(card.children[1].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(card.children[2].children[0].textContent, '<script>bad()</script>');
});

test('double-submit ถูกป้องกันระหว่าง request กำลังทำงาน', async () => {
  let resolveRequest;
  let calls = 0;
  const pending = new Promise((resolve) => { resolveRequest = resolve; });
  const session = plusUI.createSession({ send: async () => { calls += 1; return pending; } });
  session.setProfile('cp-1');
  const first = session.submit({ path: '/ask', body: {} }, 'คำถามแรก');
  const second = await session.submit({ path: '/ask', body: {} }, 'คำถามซ้ำ');
  assert.deepEqual(second, { ignored: true });
  assert.equal(calls, 1);
  resolveRequest({ status: 'answer', data: {} });
  await first;
});

test('doctor-question generation uses existing visible loading state', async () => {
  let resolveRequest;
  const snapshots = [];
  const pending = new Promise((resolve) => { resolveRequest = resolve; });
  const session = plusUI.createSession({ send: async () => pending, onChange: (state) => snapshots.push(state) });
  session.setProfile('CP-1');
  const request = session.submit(plusUI.buildDoctorQuestionRequest('CP-1'), 'ถามหมออะไรดี');
  assert.equal(session.snapshot().busy, true);
  resolveRequest({ status: 'questions', questions: [] });
  await request;
  assert.equal(session.snapshot().busy, false);
  assert.equal(snapshots.some((state) => state.busy), true);
});

test('ask request ส่งเฉพาะ question และ purposeHint ที่ UI กำหนด', () => {
  const request = plusUI.buildAskRequest('cp_1', 'มียาอะไร', 'medication_summary');
  assert.equal(request.path, '/api/plus/care-profiles/cp_1/ask');
  assert.deepEqual(request.body, { question: 'มียาอะไร', purposeHint: 'medication_summary' });
  assert.equal('context' in request.body || 'model' in request.body || 'provider' in request.body || 'systemInstruction' in request.body, false);
});

test('appointment preparation ใช้ Care Profile และ appointment ที่ผู้ใช้เลือก', () => {
  const request = plusUI.buildPreparationRequest('cp_1', 'appt_9');
  assert.equal(request.path, '/api/plus/care-profiles/cp_1/appointments/appt_9/prepare');
  assert.deepEqual(request.body, {});
  assert.equal(plusUI.QUICK_ACTIONS.find((item) => item.id === 'prepare').requiresAppointment, true);
});

test('ถามหมออะไรดี request ส่งเฉพาะ Care Profile appointment และ focus ที่อนุญาต', () => {
  const request = plusUI.buildDoctorQuestionRequest('cp_1', 'appt_9', 'อยากถามเรื่องยา');
  assert.equal(request.path, '/api/care-profile/cp_1/doctor-questions');
  assert.deepEqual(request.body, { appointmentId: 'appt_9', focus: 'อยากถามเรื่องยา' });
  assert.equal('context' in request.body || 'provider' in request.body || 'lineUserId' in request.body, false);
});

test('structured doctor questions render as text with loading-compatible response model', () => {
  const response = {
    status: 'questions', title: 'คำถามที่อยากถามคุณหมอ', summary: 'เตรียมไว้ก่อนพบแพทย์',
    questions: [{ id: 'Q1', category: 'medication', question: '<img src=x onerror=alert(1)>', rationale: 'วิธีใช้ยังไม่ครบ' }],
    missingInformation: [{ code: 'MISSING', label: 'ยังไม่มีวิธีใช้ยา' }],
    safetyNotice: 'แพทย์เป็นผู้ตัดสินใจ', disclaimer: 'ไม่ใช่การวินิจฉัย',
  };
  const view = plusUI.responseToViewModel(response);
  assert.equal(view.kind, 'doctor-questions');
  assert.equal(view.questions[0].question, '<img src=x onerror=alert(1)>');
  assert.deepEqual(view.missingInformation, ['ยังไม่มีวิธีใช้ยา']);
  const doc = fakeDocument();
  const container = new FakeElement('div');
  plusUI.renderResponse(doc, container, response, { copyText() {} });
  assert.equal(container.children[0].children[2].children[0].children[0].textContent, '<img src=x onerror=alert(1)>');
});

test('copy-all format เหมาะกับ LINE และไม่ใส่ Care Profile/LINE/internal IDs', () => {
  const text = plusUI.formatDoctorQuestionsForCopy({ questions: [
    { id: 'INTERNAL-1', category: 'lab', question: 'ควรถามเรื่องผลตรวจอย่างไร?' },
    { id: 'INTERNAL-2', category: 'medication', question: 'ควรยืนยันวิธีใช้ยาอย่างไร?' },
  ] });
  assert.match(text, /^คำถามที่อยากถามคุณหมอ/);
  assert.match(text, /1\. ควรถามเรื่องผลตรวจอย่างไร/);
  assert.match(text, /ไม่ใช่การวินิจฉัยหรือคำแนะนำให้ปรับยา/);
  assert.doesNotMatch(text, /INTERNAL|Care Profile|LINE ID/);
});

test('copy-all button invokes injected clipboard helper and never browser storage', () => {
  let copied = '';
  const doc = fakeDocument();
  const container = new FakeElement('div');
  plusUI.renderResponse(doc, container, {
    status: 'questions', title: 'คำถาม', summary: 'สรุป',
    questions: [{ id: 'Q1', category: 'condition', question: 'ควรถามอะไร?', rationale: 'ข้อมูลประกอบ' }],
    missingInformation: [], safetyNotice: 'ปลอดภัย', disclaimer: 'ไม่ใช่คำวินิจฉัย',
  }, { copyText(value) { copied = value; } });
  const button = container.children[0].children.find((child) => child.tagName === 'button');
  button.listeners.click();
  assert.match(copied, /ควรถามอะไร/);
  assert.doesNotMatch(plusSource, /localStorage|sessionStorage/);
});

test('Plus UI ไม่เก็บคำถามหรือคำตอบใน browser storage และไม่ log response', () => {
  assert.doesNotMatch(plusSource, /localStorage|sessionStorage/);
  assert.doesNotMatch(plusSource, /console\.(log|info|debug)\s*\(/);
});

test('ปุ่มเภสัชกร disabled ชัดเจนเมื่อยังไม่มี LINE OA URL', () => {
  const doc = fakeDocument();
  const container = new FakeElement('div');
  plusUI.renderResponse(doc, container, { status: 'escalation', type: 'pharmacist' });
  const card = container.children[0];
  const button = card.children.find((child) => child.tagName === 'button');
  assert.equal(button.disabled, true);
  assert.match(button.title, /ยังไม่เปิด/);
});
