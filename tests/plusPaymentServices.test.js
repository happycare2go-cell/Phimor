const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';

const { createPlusPaymentOrderService } = require('../backend/services/plusPaymentOrderService');
const { createPlusPaymentEntitlementService } = require('../backend/services/plusPaymentEntitlementService');
const { createPlusPaymentIngestionService } = require('../backend/services/plusPaymentIngestionService');
const { PLUS_PRICE_MINOR, PLUS_CURRENCY } = require('../backend/domain/plusPayment');

const FLAGS = { plus: { enabled: true, paymentEnabled: true, internalEntitlementOnly: false } };

function checkoutRepository() {
  let order = null;
  return {
    get order() { return order; },
    async findActiveOrderForUpdate(subject) { return order && order.subject_line_user_id === subject && ['draft', 'payment_pending'].includes(order.status) ? order : null; },
    async createOrder(record) { if (order) return null; order = { ...record, status: 'draft', fulfillment_status: 'pending', created_at: '2026-08-28T00:00:00Z' }; return order; },
    async markPaymentPending(id, patch) { order = { ...order, status: 'payment_pending', provider: patch.provider, provider_checkout_id: patch.providerCheckoutId, payment_due_at: patch.paymentDueAt, payment_resume_data: patch.paymentResumeData }; return order; },
    async markPaymentFailed() { order = { ...order, status: 'failed' }; return order; },
    async findOrderForUpdate() { return order; }, async findOrder() { return order; },
    async findCurrentOrder(subject) { return order?.subject_line_user_id === subject ? order : null; },
    async listHistory() { return order ? [order] : []; },
  };
}

test('concurrent Plus checkout requests resolve to one order and one provider checkout', async () => {
  const repository = checkoutRepository(); let providerCalls = 0;
  const service = createPlusPaymentOrderService({
    repository, flagsLoader: () => FLAGS,
    entitlementGetter: async () => ({ allowed: false }),
    providerFactory: () => ({ async createCheckout({ purpose }) {
      providerCalls += 1; assert.equal(purpose, 'phimor_plus');
      return { provider: 'omise', checkoutId: 'chrg_test_plus1', paymentDueAt: '2026-08-28T01:00:00Z', paymentInstructions: { method: 'promptpay', qrImageUrl: 'https://example.test/plus-qr.png' } };
    } }), orderId: () => 'PLUSORD-1',
  });
  const [a, b] = await Promise.all([
    service.createCheckout({ lineUserId: 'U-1', returnTarget: 'lab_explanation', idempotencyKey: 'key-a' }),
    service.createCheckout({ lineUserId: 'U-1', returnTarget: 'lab_explanation', idempotencyKey: 'key-b' }),
  ]);
  assert.equal(providerCalls, 1);
  assert.equal(a.orderId, b.orderId);
  assert.equal([a.resumed, b.resumed].filter(Boolean).length, 1);
});

test('active Plus does not create normal checkout but explicit early renewal can', async () => {
  const repository = checkoutRepository(); let providerCalls = 0;
  const service = createPlusPaymentOrderService({
    repository, flagsLoader: () => FLAGS,
    entitlementGetter: async () => ({ allowed: true, expiresAt: '2026-09-20T00:00:00Z' }),
    providerFactory: () => ({ async createCheckout() { providerCalls += 1; return { provider: 'omise', checkoutId: 'chrg_test_renew1', paymentInstructions: { method: 'promptpay', qrImageUrl: 'https://example.test/renew.png' } }; } }),
    orderId: () => 'PLUSORD-RENEW',
  });
  await assert.rejects(service.createCheckout({ lineUserId: 'U-1', returnTarget: 'plus_home', idempotencyKey: 'normal' }), (error) => error.code === 'PLUS_ALREADY_ACTIVE');
  const renewed = await service.createCheckout({ lineUserId: 'U-1', returnTarget: 'plus_home', idempotencyKey: 'renew', renew: true });
  assert.equal(renewed.status, 'payment_pending'); assert.equal(providerCalls, 1);
});

function entitlementRepository({ currentExpiresAt = null, alreadyGranted = false } = {}) {
  let order = { order_id: 'PLUSORD-1', subject_line_user_id: 'U-1', plan_id: 'plus_30d_v1', amount_minor: 5900, currency: 'THB', provider: 'omise', provider_checkout_id: 'chrg_test_plus1', status: alreadyGranted ? 'paid' : 'payment_pending', fulfillment_status: alreadyGranted ? 'granted' : 'pending', entitlement_id: alreadyGranted ? 'PLUSENT-1' : null };
  let entitlement = alreadyGranted ? { entitlement_id: 'PLUSENT-1', starts_at: '2026-08-28T00:00:00Z', expires_at: '2026-09-27T00:00:00Z' } : null;
  return {
    get order() { return order; }, get entitlement() { return entitlement; },
    async findOrderForUpdate() { return order; },
    async markPaid(id, paidAt) { order = { ...order, status: 'paid', paid_at: paidAt, fulfillment_status: 'pending' }; return order; },
    async findLatestEntitlementForUpdate() { return currentExpiresAt ? { expires_at: currentExpiresAt } : null; },
    async createPaymentEntitlement(record) { entitlement = { entitlement_id: record.entitlement_id, starts_at: record.starts_at, expires_at: record.expires_at }; return { entitlement, created: true }; },
    async markFulfilled(id, value) { order = { ...order, fulfillment_status: 'granted', entitlement_id: value.entitlement_id, entitlement_start_at: value.starts_at, entitlement_end_at: value.expires_at }; return order; },
    async findEntitlementBySourceOrder() { return entitlement; },
  };
}

function paidEvent(paidAt = '2026-09-10T00:00:00Z') { return { verified: true, signatureVerified: true, provider: 'omise', providerCheckoutId: 'chrg_test_plus1', orderId: 'PLUSORD-1', amountMinor: PLUS_PRICE_MINOR, currency: PLUS_CURRENCY, paidAt }; }

test('early renewal starts at current expiry and adds exactly 30 days', async () => {
  const repository = entitlementRepository({ currentExpiresAt: '2026-09-20T00:00:00Z' });
  const service = createPlusPaymentEntitlementService({ repository, transaction: (key, fn) => fn(), entitlementId: () => 'PLUSENT-NEW' });
  const result = await service.grantVerifiedPayment(paidEvent());
  assert.equal(result.entitlement.starts_at, '2026-09-20T00:00:00.000Z');
  assert.equal(result.entitlement.expires_at, '2026-10-20T00:00:00.000Z');
});

test('expired renewal starts at verified payment time and adds exactly 30 days', async () => {
  const repository = entitlementRepository({ currentExpiresAt: '2026-09-01T00:00:00Z' });
  const service = createPlusPaymentEntitlementService({ repository, transaction: (key, fn) => fn(), entitlementId: () => 'PLUSENT-NEW' });
  const result = await service.grantVerifiedPayment(paidEvent());
  assert.equal(result.entitlement.starts_at, '2026-09-10T00:00:00.000Z');
  assert.equal(result.entitlement.expires_at, '2026-10-10T00:00:00.000Z');
});

test('verified payment replay cannot extend entitlement twice', async () => {
  const repository = entitlementRepository({ alreadyGranted: true });
  const service = createPlusPaymentEntitlementService({ repository, transaction: (key, fn) => fn() });
  const result = await service.grantVerifiedPayment(paidEvent('2026-08-28T00:00:00Z'));
  assert.equal(result.duplicate, true);
  assert.equal(result.entitlement.expires_at, '2026-09-27T00:00:00Z');
});

test('redirect/unverified event cannot grant Plus', async () => {
  const repository = entitlementRepository();
  const service = createPlusPaymentEntitlementService({ repository, transaction: (key, fn) => fn() });
  await assert.rejects(service.grantVerifiedPayment({ ...paidEvent(), verified: false }), (error) => error.code === 'PAYMENT_NOT_VERIFIED');
  assert.equal(repository.order.fulfillment_status, 'pending');
});

test('webhook and reconciliation processing converge on one entitlement', async () => {
  let grantAttempts = 0; let createdGrants = 0; const transactions = new Map();
  const repository = {
    async ingestPaymentTransaction(record) { const existing = transactions.get(record.provider_event_id); if (existing) return { transaction: existing, duplicate: true }; const row = { ...record, processing_status: 'verified' }; transactions.set(record.provider_event_id, row); return { transaction: row, duplicate: false }; },
    async updatePaymentTransaction(id, patch) { const row = [...transactions.values()].find((item) => item.payment_transaction_id === id); row.processing_status = patch.status; return row; },
    async findOrder() { return { order_id: 'PLUSORD-1' }; },
  };
  const ingestion = createPlusPaymentIngestionService({ repository, transaction: (key, fn) => fn(), entitlementService: { async grantVerifiedPayment() { grantAttempts += 1; if (grantAttempts === 1) createdGrants += 1; return { order: { order_id: 'PLUSORD-1' }, entitlement: { entitlement_id: 'PLUSENT-1' }, duplicate: grantAttempts > 1 }; } }, paymentTransactionId: () => `TX-${transactions.size + 1}` });
  const base = { ...paidEvent('2026-08-28T00:00:00Z'), eventType: 'payment_succeeded', providerPaymentId: 'chrg_test_plus1', payloadHash: 'a'.repeat(64) };
  await ingestion.ingestAndProcess({ ...base, providerEventId: 'evt-webhook' });
  await ingestion.ingestAndProcess({ ...base, providerEventId: 'reconcile:chrg_test_plus1:successful' });
  assert.equal(grantAttempts, 2); assert.equal(createdGrants, 1);
  assert.equal([...transactions.values()].every((item) => item.processing_status === 'processed'), true);
});
