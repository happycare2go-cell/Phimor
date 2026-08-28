const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../liff-app/family/plus-payment-ui');

const source = fs.readFileSync(path.join(__dirname, '..', 'liff-app', 'family', 'plus-payment-ui.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'liff-app', 'family', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'liff-app', 'family', 'plus-payment-ui.css'), 'utf8');
const preview = fs.readFileSync(path.join(__dirname, 'fixtures', 'plus-payment-v1-preview.html'), 'utf8');

function harness(responses, onReturn = () => {}) {
  const calls = [];
  const session = ui.createSession({
    async request(pathname, options) {
      calls.push({ pathname, options });
      const value = responses[pathname]; return typeof value === 'function' ? value(options) : value;
    }, onReturn,
  });
  session.setProfile('CP-1'); return { session, calls };
}

const offer = { status: 'available', amountMinor: 5900, durationDays: 30, automaticRenewal: false };
const free = { status: 'basic', plus: false, upgradeAvailable: true };

test('Free actor sees contextual paywall and only symbolic return target is retained', async () => {
  const h = harness({ '/api/plus/offer': offer, '/api/plus/entitlement': free, '/api/plus/orders/current': { status: 'none', order: null } });
  await h.session.load(); const decision = await h.session.requestCapability('lab_explanation');
  assert.equal(decision.allowed, false); assert.equal(h.session.snapshot().view, 'context');
  assert.equal(h.session.snapshot().returnTarget, 'lab_explanation');
  assert.equal(JSON.stringify(h.session.snapshot()).includes('CP-1'), true);
  assert.equal(Boolean(h.session.snapshot().order?.careProfileId), false);
});

test('active payment entitlement returns directly to Lab without checkout', async () => {
  const returned = [];
  const active = { status: 'active', plus: true, source: 'payment', expiresAt: '2026-09-27T00:00:00Z' };
  const h = harness({ '/api/plus/offer': offer, '/api/plus/entitlement': active, '/api/plus/orders/current': { status: 'none', order: null } }, (target) => returned.push(target));
  await h.session.load(); const result = await h.session.requestCapability('lab_explanation');
  assert.equal(result.allowed, true); assert.deepEqual(returned, ['lab_explanation']);
  assert.equal(h.calls.some((call) => call.pathname === '/api/plus/orders'), false);
});

test('reload and second device discover the existing payment instead of asking to pay again', async () => {
  const pending = { orderId: 'PLUSORD-1', status: 'payment_pending', returnTarget: 'doctor_question_prep', payment: { method: 'promptpay', qrImageUrl: 'https://example.test/qr.png' } };
  const h = harness({ '/api/plus/offer': offer, '/api/plus/entitlement': free, '/api/plus/orders/current': { status: 'found', order: pending } });
  await h.session.load();
  assert.equal(h.session.snapshot().view, 'payment'); assert.equal(h.session.snapshot().order.orderId, 'PLUSORD-1');
  assert.equal(h.calls.filter((call) => call.pathname === '/api/plus/orders').length, 0);
});

test('payment confirming never creates another checkout', async () => {
  const confirming = { orderId: 'PLUSORD-1', status: 'payment_confirming', returnTarget: 'plus_home' };
  const h = harness({ '/api/plus/offer': offer, '/api/plus/entitlement': free, '/api/plus/orders/current': { status: 'found', order: confirming }, '/api/plus/orders/PLUSORD-1/status': confirming });
  await h.session.load(); await h.session.refreshOrder();
  assert.equal(h.calls.some((call) => call.pathname === '/api/plus/orders'), false);
});

test('verified success refreshes entitlement and returns to requested feature', async () => {
  const returned = []; let entitlementCalls = 0;
  const h = harness({
    '/api/plus/offer': offer,
    '/api/plus/entitlement': () => { entitlementCalls += 1; return entitlementCalls === 1 ? free : { status: 'active', plus: true, source: 'payment', expiresAt: '2026-09-27T00:00:00Z' }; },
    '/api/plus/orders/current': { status: 'found', order: { orderId: 'PLUSORD-1', status: 'payment_pending', returnTarget: 'lab_explanation' } },
    '/api/plus/orders/PLUSORD-1/status': { orderId: 'PLUSORD-1', status: 'active', returnTarget: 'lab_explanation' },
  }, (target) => returned.push(target));
  await h.session.load(); await h.session.requestCapability('lab_explanation'); await h.session.refreshOrder();
  assert.equal(h.session.snapshot().entitlement.plus, true); assert.deepEqual(returned, ['lab_explanation']);
});

test('profile switch clears contextual target, order and history immediately', async () => {
  const h = harness({ '/api/plus/offer': offer, '/api/plus/entitlement': free, '/api/plus/orders/current': { status: 'none', order: null } });
  await h.session.load(); await h.session.requestCapability('doctor_visit_organization');
  h.session.setProfile('CP-2'); const state = h.session.snapshot();
  assert.equal(state.returnTarget, 'plus_home'); assert.equal(state.order, null); assert.deepEqual(state.history, []);
});

test('Plus UI advertises only live benefits and manual renewal wording', () => {
  assert.equal(ui.LIVE_BENEFITS.some((item) => /monthly|รายเดือน|smart reminder/i.test(item)), false);
  assert.match(html, /plusCommercePanel/); assert.match(source, /ไม่มีการตัดเงินอัตโนมัติ/);
  assert.match(source, /59 บาท \/ 30 วัน/); assert.match(source, /ครบกำหนดแล้วสามารถต่ออายุได้โดยชำระอีกครั้ง/);
  assert.match(source, /วันใช้งานที่เหลือจะไม่หาย 30 วันใหม่เริ่มต่อจาก/);
  assert.match(source, /ต่ออายุ 59 บาท \/ 30 วัน/);
});

test('Plus UI has no browser persistence, arbitrary URL return or raw provider projection', () => {
  assert.doesNotMatch(source, /localStorage|sessionStorage|location\.(?:search|hash)|console\.(?:log|info|debug)/);
  assert.doesNotMatch(source, /providerPaymentId|providerCheckoutId|\bOmise\b/i);
  assert.equal(ui.safeQr('https://example.test/qr.png'), 'https://example.test/qr.png');
  assert.equal(ui.safeQr('http://example.test/qr.png'), null);
});

test('mobile CSS has full-width actions, bounded QR and no horizontal layout dependency', () => {
  assert.match(css, /min-height:44px/); assert.match(css, /width:min\(230px,100%\)/);
  assert.doesNotMatch(css, /min-width:\s*[4-9][0-9]{2}px/);
});

test('P1-P11 mobile preview uses fictional data and actual Family Plus styles without provider calls', () => {
  for (let index = 1; index <= 11; index += 1) assert.match(preview, new RegExp(`data-screen="p${index}"`));
  assert.match(preview, /plus-payment-ui\.css/);
  assert.match(preview, /59 บาท \/ 30 วัน/);
  assert.match(preview, /ไม่มีการตัดเงินอัตโนมัติ/);
  assert.match(preview, /ตัวอย่างข้อมูลสำหรับตรวจ UX เท่านั้น/);
  assert.doesNotMatch(preview, /fetch\(|XMLHttpRequest|https?:\/\//);
  assert.doesNotMatch(preview, /LINE User ID|providerCheckoutId|providerPaymentId/);
});

test('Lab, Ask Doctor and Doctor Visit use the shared symbolic upgrade flow', () => {
  assert.match(html, /requestPlusCapability\('lab_explanation'\)/);
  assert.match(html, /requestPlusCapability\('doctor_question_prep'\)/);
  assert.match(html, /requestPlusCapability\('doctor_visit_organization'\)/);
  assert.match(html, /LAB_RESULTS_UI\.session\.open\(\)/);
  assert.doesNotMatch(html, /returnTarget=.*https?:/);
});
