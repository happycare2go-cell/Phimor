const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPlusPaymentReversalService,
} = require('../backend/services/plusPaymentReversalService');

function createRepository() {
  const orders = new Map([
    ['ORDER-A', {
      order_id:'ORDER-A', subject_line_user_id:'U-A', provider:'omise',
      provider_checkout_id:'CHARGE-A', entitlement_id:'ENT-A',
    }],
    ['ORDER-B', {
      order_id:'ORDER-B', subject_line_user_id:'U-B', provider:'omise',
      provider_checkout_id:'CHARGE-B', entitlement_id:'ENT-B',
    }],
  ]);
  const transactions = [
    {
      payment_transaction_id:'SUCCESS-A', order_id:'ORDER-A', provider:'omise',
      provider_event_id:'EVENT-SUCCESS-A', provider_payment_id:'CHARGE-A',
      provider_checkout_id:'CHARGE-A', event_type:'payment_succeeded',
      processing_status:'processed', amount_minor:5900, currency:'THB', failure_code:null,
    },
    {
      payment_transaction_id:'SUCCESS-B', order_id:'ORDER-B', provider:'omise',
      provider_event_id:'EVENT-SUCCESS-B', provider_payment_id:'CHARGE-B',
      provider_checkout_id:'CHARGE-B', event_type:'payment_succeeded',
      processing_status:'processed', amount_minor:5900, currency:'THB', failure_code:null,
    },
  ];
  return {
    orders, transactions,
    async findOrderForUpdate(orderId) { return orders.get(orderId) || null; },
    async findSuccessfulPaymentTransaction(orderId) {
      return transactions.find((row) => row.order_id === orderId
        && row.event_type === 'payment_succeeded' && row.processing_status === 'processed') || null;
    },
    async ingestPaymentTransaction(record) {
      const existing = transactions.find((row) => row.provider === record.provider
        && row.provider_event_id === record.provider_event_id);
      if (existing) return { transaction: existing, duplicate:true };
      const row = { ...record, processing_status:'verified', signature_verified:true };
      transactions.push(row);
      return { transaction:row, duplicate:false };
    },
  };
}

function reversal(overrides = {}) {
  return {
    provider:'omise', providerEventId:'EVENT-REFUND-A', providerPaymentId:'CHARGE-A',
    providerCheckoutId:'CHARGE-A', orderId:'ORDER-A', reversalType:'partial_refund',
    amountMinor:1000, currency:'THB', verified:true, signatureVerified:true,
    payloadHash:'a'.repeat(64), ...overrides,
  };
}

test('verified reversal-like events are additive, idempotent, and never mutate entitlement state', async () => {
  const repository = createRepository();
  const beforeOrder = structuredClone(repository.orders.get('ORDER-A'));
  const beforeSuccess = structuredClone(repository.transactions[0]);
  const logs = [];
  const service = createPlusPaymentReversalService({
    repository, transaction:async (_key, action) => action(), reversalMode:() => 'manual_review',
    paymentTransactionId:() => 'REVERSAL-A', operationalLogger:(value) => logs.push(value),
  });
  const first = await service.recordVerifiedReversalForManualReview(reversal());
  const second = await service.recordVerifiedReversalForManualReview(reversal());

  assert.equal(first.status, 'manual_review_required');
  assert.equal(first.entitlementChanged, false);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(repository.transactions.length, 3);
  assert.deepEqual(repository.transactions[0], beforeSuccess);
  assert.deepEqual(repository.orders.get('ORDER-A'), beforeOrder);
  assert.equal(repository.transactions[2].event_type, 'payment_partial_refund_reported');
  assert.equal(repository.transactions[2].failure_code, 'MANUAL_REVIEW_REQUIRED');
  assert.deepEqual(logs, [{
    event:'plus_payment_reversal_manual_review_required',
    eventType:'payment_partial_refund_reported', policyMode:'manual_review',
  }]);
  assert.doesNotMatch(JSON.stringify(logs), /ORDER-A|CHARGE-A|U-A|5900|1000/);
});

test('reversal association is bound to the original order and cannot cross users', async () => {
  const repository = createRepository();
  const service = createPlusPaymentReversalService({
    repository, transaction:async (_key, action) => action(), reversalMode:() => 'manual_review',
    operationalLogger:() => {},
  });
  await assert.rejects(service.recordVerifiedReversalForManualReview(reversal({
    providerPaymentId:'CHARGE-B',
  })), { code:'PAYMENT_REVERSAL_ORIGINAL_MISMATCH' });
  assert.equal(repository.transactions.length, 2);
  assert.equal(repository.orders.get('ORDER-A').entitlement_id, 'ENT-A');
  assert.equal(repository.orders.get('ORDER-B').entitlement_id, 'ENT-B');
});

test('manual-review foundation fails closed for unknown, unverified, or unconfigured reversal events', async () => {
  const repository = createRepository();
  const configured = createPlusPaymentReversalService({
    repository, transaction:async (_key, action) => action(), reversalMode:() => 'manual_review',
    operationalLogger:() => {},
  });
  await assert.rejects(
    configured.recordVerifiedReversalForManualReview(reversal({ reversalType:'provider_magic_event' })),
    { code:'UNSUPPORTED_PAYMENT_REVERSAL_EVENT' },
  );
  await assert.rejects(
    configured.recordVerifiedReversalForManualReview(reversal({ signatureVerified:false })),
    { code:'PAYMENT_NOT_VERIFIED' },
  );
  const unconfigured = createPlusPaymentReversalService({
    repository, transaction:async (_key, action) => action(), reversalMode:() => '',
  });
  await assert.rejects(
    unconfigured.recordVerifiedReversalForManualReview(reversal()),
    { code:'PAYMENT_REVERSAL_MODE_NOT_CONFIGURED' },
  );
  assert.equal(repository.transactions.length, 2);
});
