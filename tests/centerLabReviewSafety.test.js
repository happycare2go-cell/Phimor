const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { confirmCardFlex } = require('../backend/flexMessages');
const runtime = require('../liff-app/center-admin/lab-review-runtime');

const centerHtml = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'center-admin', 'index.html'), 'utf8');

function footerActions(data) {
  return confirmCardFlex({ cardId: 'CARD-1', residentName: 'ผู้พักทดสอบ', room: '1', data })
    .contents.footer.contents.map((item) => item.action);
}

function fakeElement() {
  return {
    style: {}, dataset: {}, textContent: '',
    removeAttribute(name) { delete this[name]; },
  };
}

function sourceElements() {
  return { image: fakeElement(), status: fakeElement(), noImage: fakeElement() };
}

test('Lab Flex routes to the reviewer and exposes no generic direct confirmation action', () => {
  const flex = confirmCardFlex({
    cardId: 'CARD-LAB', residentName: 'ผู้พักทดสอบ', room: '1',
    data: { documentSubtype: 'lab_report', appointment: null, medications: [], doctorNote: null },
  });
  const serialized = JSON.stringify(flex);
  assert.match(serialized, /ผลตรวจ Lab · รอตรวจสอบ/);
  assert.match(serialized, /ตรวจสอบผล Lab/);
  assert.match(serialized, /action=edit_card&cardId=CARD-LAB/);
  assert.doesNotMatch(serialized, /action=confirm_card|ส่งเลย/);
  assert.equal(flex.contents.footer.contents.length, 1);
});

test('legacy medication, appointment, and doctor-note Flex confirmation behavior remains unchanged', () => {
  const fixtures = [
    { documentSubtype: 'medication', medications: [{ name: 'ยา A', dose: '1 เม็ด' }] },
    { documentSubtype: 'appointment', appointment: { hospital: 'โรงพยาบาล', datetime: '2099-01-01T09:00:00Z' } },
    { documentSubtype: 'doctor_note', doctorNote: 'ติดตามอาการ' },
  ];
  for (const data of fixtures) {
    const actions = footerActions(data);
    assert.deepEqual(actions.map((action) => action.label), ['แก้ไขก่อนส่ง', 'ส่งเลย']);
    assert.match(actions[1].data, /^action=confirm_card&cardId=/);
  }
});

test('switching from an imaged card clears the previous source before a no-image card renders', () => {
  const elements = sourceElements();
  const first = runtime.renderSourceImageElements(elements, {
    imageBase64: 'PRIVATE_CARD_A',
    imageMimeType: 'image/png',
    sourceImage: { status: 'available', mimeType: 'image/png' },
  });
  assert.equal(first.status, 'available');
  assert.equal(elements.image.src, 'data:image/png;base64,PRIVATE_CARD_A');
  assert.equal(elements.image.style.display, 'block');

  runtime.resetSourceImageElements(elements);
  assert.equal(elements.image.src, undefined);
  assert.equal(elements.image.style.display, 'none');
  assert.equal(elements.status.dataset.state, 'loading');

  const second = runtime.renderSourceImageElements(elements, {
    imageBase64: null,
    sourceImage: { status: 'unavailable', mimeType: null },
  });
  assert.equal(second.status, 'unavailable');
  assert.equal(elements.image.src, undefined);
  assert.equal(elements.image.style.display, 'none');
  assert.doesNotMatch(JSON.stringify(elements), /PRIVATE_CARD_A/);
});

test('latest-request revision guard prevents stale card responses from rendering', () => {
  const guard = runtime.createRequestRevisionGuard();
  const cardA = guard.begin();
  const cardB = guard.begin();
  assert.equal(guard.isCurrent(cardA), false);
  assert.equal(guard.isCurrent(cardB), true);
  guard.invalidate();
  assert.equal(guard.isCurrent(cardB), false);
});

test('source renderer uses the actual safe MIME and never guesses missing or unsupported MIME', () => {
  for (const mimeType of ['image/jpeg', 'image/png', 'image/webp']) {
    const view = runtime.sourceImageView({ imageBase64: 'SAFE', imageMimeType: mimeType, sourceImage: { status: 'available', mimeType } });
    assert.equal(view.mimeType, mimeType);
    assert.equal(view.dataUrl, `data:${mimeType};base64,SAFE`);
  }
  for (const mimeType of [null, 'image/svg+xml', 'text/html']) {
    const view = runtime.sourceImageView({ imageBase64: 'UNSAFE', imageMimeType: mimeType, sourceImage: { status: 'available', mimeType } });
    assert.equal(view.status, 'unsupported');
    assert.equal(view.dataUrl, null);
  }
});

test('purged and unavailable source states use explicit Thai safety wording', () => {
  const purged = runtime.sourceImageView({ sourceImage: { status: 'purged', purgedAt: '2026-08-26T00:00:00Z' } });
  const unavailable = runtime.sourceImageView({ sourceImage: { status: 'unavailable' } });
  assert.match(purged.message, /ถูกลบตามระยะเวลาการเก็บรักษาแล้ว/);
  assert.match(purged.message, /ข้อมูลผล Lab ที่ยืนยันแล้วไม่ได้ถูกลบ/);
  assert.match(unavailable.message, /ไม่พบเอกสารต้นฉบับ/);
});

test('uncertain fields remain bounded reviewer labels and are never interpreted as values', () => {
  const fields = runtime.safeUncertainFields([' observations[0].sourceUnit ', '', null, '<img src=x onerror=alert(1)>']);
  assert.deepEqual(fields, ['observations[0].sourceUnit', '<img src=x onerror=alert(1)>']);
  assert.doesNotMatch(JSON.stringify(runtime), /innerHTML/);
  assert.match(centerHtml, /item\.textContent = field/);
  assert.match(centerHtml, /ข้อมูลที่ควรตรวจสอบเป็นพิเศษ/);
});

test('Center reviewer resets before fetching and guards every asynchronous card response', () => {
  const start = centerHtml.indexOf('async function loadEditCard(cardId)');
  const end = centerHtml.indexOf('function toDateTimeLocal', start);
  const implementation = centerHtml.slice(start, end);
  assert.ok(implementation.indexOf('resetEditCardReviewState()') < implementation.indexOf('await api(`/api/cards/${cardId}`'));
  assert.ok((implementation.match(/editCardRequestGuard\.isCurrent\(requestRevision\)/g) || []).length >= 3);
  assert.doesNotMatch(implementation, /data:image\/jpeg;base64/);
});

test('Center Lab confirmation requires an explicit saved review and no longer auto-saves on confirm', () => {
  const start = centerHtml.indexOf('async function confirmLabReview()');
  const end = centerHtml.indexOf('function addMedRow', start);
  const implementation = centerHtml.slice(start, end);
  assert.match(implementation, /extractionStatus !== 'reviewed'/);
  assert.match(implementation, /บันทึกฉบับร่างก่อนยืนยัน/);
  assert.doesNotMatch(implementation, /await saveLabReview\(\)/);
});
