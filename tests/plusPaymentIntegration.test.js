const test = require('node:test');
const assert = require('node:assert/strict');
const { createOmiseWebhookDispatchService } = require('../backend/services/omiseWebhookDispatchService');
const { createPlusPaymentSchedulerService } = require('../backend/services/plusPaymentSchedulerService');
const { JOB_LOCK_KEYS } = require('../backend/services/schedulerCoordinatorService');
const { createPlusPaymentSupportService } = require('../backend/services/plusPaymentSupportService');
const { createPlusPaymentRepository, PLUS_RECONCILIATION_MAX_ATTEMPTS } = require('../backend/services/plusPaymentRepository');

test('Omise webhook dispatches verified Plus purpose only to Plus ingestion', async () => {
  const calls = [];
  const service = createOmiseWebhookDispatchService({
    provider: {
      async verifyWebhook() { return { providerEventId: 'evt-plus', eventKey: 'charge.complete', providerPaymentId: 'chrg_test_plus1', payloadHash: 'a'.repeat(64) }; },
      async retrievePayment() { return { purpose: 'phimor_plus', provider: 'omise', providerPaymentId: 'chrg_test_plus1', providerCheckoutId: 'chrg_test_plus1', orderId: 'PLUSORD-1', amountMinor: 5900, currency: 'THB', eventType: 'payment_succeeded', paidAt: '2026-08-28T00:00:00Z' }; },
    },
    plusIngestion: { async ingestAndProcess(event) { calls.push(event); return { status: 'processed', order: { order_id: 'PLUSORD-1' } }; } },
    consultationService: { async handleVerifiedCharge() { throw new Error('wrong dispatcher'); } },
  });
  const result = await service.handle({ rawBody: Buffer.from('{}'), headers: {} });
  assert.equal(result.acknowledged, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].signatureVerified, true); assert.equal(calls[0].providerEventId, 'evt-plus');
});

test('Omise consultation purpose remains on existing consultation ingestion path', async () => {
  let consultationCalls = 0;
  const service = createOmiseWebhookDispatchService({
    provider: {
      async verifyWebhook() { return { providerEventId: 'evt-consult', eventKey: 'charge.complete', providerPaymentId: 'chrg_test_consult1' }; },
      async retrievePayment() { return { purpose: 'phimor_consultation' }; },
    },
    plusIngestion: { async ingestAndProcess() { throw new Error('wrong dispatcher'); } },
    consultationService: { async handleVerifiedCharge() { consultationCalls += 1; return { status: 'processed', acknowledged: true }; } },
  });
  await service.handle({ rawBody: Buffer.from('{}'), headers: {} }); assert.equal(consultationCalls, 1);
});

test('Plus reconciliation scheduler delegates one job-scoped ownership boundary to the shared coordinator', async () => {
  const calls = [];
  const scheduler = createPlusPaymentSchedulerService({
    flagsLoader: () => ({ plus: { enabled: true, paymentEnabled: true, internalEntitlementOnly: false } }),
    reconciliation: { async sweepPendingOrders() { calls.push('sweep'); return { processed: 1 }; } },
  });
  const result = await scheduler.runDueWork();
  assert.equal(JOB_LOCK_KEYS.plusPaymentReconciliation, 'phimor:scheduler:plus-payment-reconciliation:v1');
  assert.deepEqual(calls, ['sweep']); assert.equal(result.processed, 1);
});

test('Plus reconciliation scheduler does not touch lock or database while payment is disabled', async () => {
  let calls = 0;
  const scheduler = createPlusPaymentSchedulerService({
    flagsLoader: () => ({ plus: { enabled: true, paymentEnabled: false, internalEntitlementOnly: false } }),
    reconciliation: { async sweepPendingOrders() { calls += 1; } },
  });
  const result = await scheduler.runDueWork();
  assert.equal(result.skipped, true); assert.equal(result.reasonCode, 'PLUS_PAYMENT_DISABLED'); assert.equal(calls, 0);
});

test('Plus storage readiness is safe, conditional, and contains no provider detail', async () => {
  const missing = createPlusPaymentRepository({ queryFn: async () => ({ rows: [{ orders_table: null, transactions_table: null }] }) });
  assert.deepEqual(await missing.getHealth(), { available: false, configured: true });
  const ready = createPlusPaymentRepository({ queryFn: async () => ({ rows: [{ orders_table: 'plus_orders', transactions_table: 'plus_payment_transactions' }] }) });
  assert.deepEqual(await ready.getHealth(), { available: true, configured: true });
  const unavailable = createPlusPaymentRepository({ queryFn: async () => { throw new Error('secret provider detail'); } });
  assert.deepEqual(await unavailable.getHealth(), { available: false, configured: true });
});

test('Plus reconciliation repository enforces the documented bounded attempt horizon', async () => {
  const calls = [];
  const repository = createPlusPaymentRepository({ queryFn: async (sql, params) => {
    calls.push({ sql, params }); return { rows: [] };
  } });
  await repository.listOrdersDueForReconciliation(25);
  await repository.markReconciliationAttempt('PLUSORD-1', { nextAttemptAt: '2026-08-28T00:02:00Z' });
  assert.equal(PLUS_RECONCILIATION_MAX_ATTEMPTS, 12);
  assert.match(calls[0].sql, /reconciliation_attempts < \$2/); assert.deepEqual(calls[0].params, [25, 12]);
  assert.match(calls[1].sql, /reconciliation_attempts < \$3/); assert.equal(calls[1].params[2], 12);
});

test('Plus repository records a manual-review reason additively and finds the immutable success event', async () => {
  const calls = [];
  const row = {
    payment_transaction_id:'REV-1', order_id:'ORDER-1', provider:'omise',
    provider_event_id:'EVENT-REV-1', event_type:'payment_refund_reported',
  };
  const repository = createPlusPaymentRepository({ queryFn:async (sql, params) => {
    calls.push({ sql, params });
    if (/INSERT INTO plus_payment_transactions/.test(sql)) return { rows:[row] };
    if (/event_type = 'payment_succeeded'/.test(sql)) {
      return { rows:[{ payment_transaction_id:'SUCCESS-1', event_type:'payment_succeeded' }] };
    }
    return { rows:[] };
  } });
  await repository.ingestPaymentTransaction({
    ...row, provider_payment_id:'CHARGE-1', provider_checkout_id:'CHARGE-1',
    amount_minor:1000, currency:'THB', payload_hash:null, provider_paid_at:null,
    failure_code:'MANUAL_REVIEW_REQUIRED',
  });
  const success = await repository.findSuccessfulPaymentTransaction('ORDER-1');
  assert.match(calls[0].sql, /received_at, failure_code, attempts/);
  assert.equal(calls[0].params[11], 'MANUAL_REVIEW_REQUIRED');
  assert.match(calls[1].sql, /processing_status = 'processed'/);
  assert.equal(success.payment_transaction_id, 'SUCCESS-1');
});

test('System Admin Plus support projection masks actor and excludes provider identifiers', async () => {
  const support = createPlusPaymentSupportService({ repository: { async findSupportRecord() { return {
    order_id: 'PLUSORD-1', subject_line_user_id: 'U1234567890SECRET', plan_id: 'plus_30d_v1',
    amount_minor: 5900, currency: 'THB', status: 'paid', fulfillment_status: 'granted',
    paid_at: '2026-08-28T00:00:00Z', entitlement_start_at: '2026-08-28T00:00:00Z', entitlement_end_at: '2026-09-27T00:00:00Z',
    processing_status: 'processed', failure_code: null, created_at: '2026-08-28T00:00:00Z', updated_at: '2026-08-28T00:00:00Z',
    provider_payment_id: 'chrg-secret',
  }; } } });
  const result = await support.lookup({ reference: 'PLUSORD-1' });
  assert.equal(result.subjectReference, 'U123…CRET');
  assert.equal('providerPaymentId' in result, false); assert.equal(JSON.stringify(result).includes('chrg-secret'), false);
});
