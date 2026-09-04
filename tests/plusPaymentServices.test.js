const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';

const { createPlusPaymentOrderService } = require('../backend/services/plusPaymentOrderService');
const {
  PAID_PLUS_FEATURES, PAID_PLUS_EXCLUDED_FEATURES,
  plusSubjectEntitlementLockKey, createPlusPaymentEntitlementService,
} = require('../backend/services/plusPaymentEntitlementService');
const { PLUS_FEATURES } = require('../backend/services/plusEntitlementService');
const { createPlusPaymentIngestionService } = require('../backend/services/plusPaymentIngestionService');
const { PLUS_PRICE_MINOR, PLUS_CURRENCY } = require('../backend/domain/plusPayment');

const FLAGS = { plus: { enabled: true, paymentEnabled: true, internalEntitlementOnly: false } };

test('paid Plus package mapping uses known features and keeps intentional omissions explicit', () => {
  assert.equal(PAID_PLUS_FEATURES.every((feature) => PLUS_FEATURES.includes(feature)), true);
  assert.deepEqual(
    [...new Set([...PAID_PLUS_FEATURES, ...PAID_PLUS_EXCLUDED_FEATURES])].sort(),
    [...PLUS_FEATURES].sort(),
  );
  assert.equal(PAID_PLUS_FEATURES.includes('pharmacist_escalation'), false);
  assert.deepEqual(PAID_PLUS_EXCLUDED_FEATURES, ['pharmacist_escalation']);
});

test('Plus entitlement lock derives from the subject that owns paid-time continuity', () => {
  assert.equal(plusSubjectEntitlementLockKey('U-1'), 'plus-entitlement:U-1');
  assert.notEqual(plusSubjectEntitlementLockKey('U-1'), plusSubjectEntitlementLockKey('U-2'));
});

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
    async findOrder() { return order; },
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

function keyedTransaction() {
  const tails=new Map();
  return async (key,fn)=>{
    const previous=tails.get(key)||Promise.resolve();
    let release;
    const current=new Promise((resolve)=>{release=resolve;});
    tails.set(key,current);
    await previous;
    try{return await fn();}finally{release();if(tails.get(key)===current)tails.delete(key);}
  };
}

test('late payment for an expired order and a newer paid order stack entitlement time for one subject',async()=>{
  const paidAt='2026-09-10T00:00:00.000Z';
  const orders=new Map([
    ['PLUSORD-OLD',{order_id:'PLUSORD-OLD',subject_line_user_id:'U-1',plan_id:'plus_30d_v1',amount_minor:5900,currency:'THB',provider:'omise',provider_checkout_id:'checkout-old',status:'expired',fulfillment_status:'pending'}],
    ['PLUSORD-NEW',{order_id:'PLUSORD-NEW',subject_line_user_id:'U-1',plan_id:'plus_30d_v1',amount_minor:5900,currency:'THB',provider:'omise',provider_checkout_id:'checkout-new',status:'payment_pending',fulfillment_status:'pending'}],
  ]);
  const entitlements=[];
  const repository={
    async findOrder(id){return orders.get(id);},async findOrderForUpdate(id){return orders.get(id);},
    async markPaid(id,value){const row={...orders.get(id),status:'paid',paid_at:value};orders.set(id,row);return row;},
    async findLatestEntitlementForUpdate(){
      const snapshot=[...entitlements];
      await new Promise((resolve)=>setImmediate(resolve));
      return snapshot.sort((a,b)=>new Date(b.expires_at)-new Date(a.expires_at))[0]||null;
    },
    async createPaymentEntitlement(record){
      const row={...record};entitlements.push(row);return {entitlement:row,created:true};
    },
    async markFulfilled(id,entitlement){const row={...orders.get(id),fulfillment_status:'granted',entitlement_id:entitlement.entitlement_id,entitlement_start_at:entitlement.starts_at,entitlement_end_at:entitlement.expires_at};orders.set(id,row);return row;},
    async findEntitlementBySourceOrder(id){return entitlements.find((item)=>item.source_order_id===id)||null;},
  };
  const service=createPlusPaymentEntitlementService({
    repository,transaction:keyedTransaction(),entitlementId:(id)=>`ENT-${id}`,
  });
  const event=(id,checkout)=>({...paidEvent(paidAt),orderId:id,providerCheckoutId:checkout});
  await Promise.all([
    service.grantVerifiedPayment(event('PLUSORD-OLD','checkout-old')),
    service.grantVerifiedPayment(event('PLUSORD-NEW','checkout-new')),
  ]);
  const periods=entitlements.map((item)=>[item.starts_at,item.expires_at]).sort();
  assert.deepEqual(periods,[
    ['2026-09-10T00:00:00.000Z','2026-10-10T00:00:00.000Z'],
    ['2026-10-10T00:00:00.000Z','2026-11-09T00:00:00.000Z'],
  ]);
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

test('concurrent provider events for the same Plus order grant exactly one entitlement',async()=>{
  const repository=entitlementRepository();
  let creates=0;
  const create=repository.createPaymentEntitlement.bind(repository);
  repository.createPaymentEntitlement=async(record)=>{creates+=1;return create(record);};
  const lockKeys=[];
  const transaction=keyedTransaction();
  const service=createPlusPaymentEntitlementService({
    repository,transaction:(key,fn)=>{lockKeys.push(key);return transaction(key,fn);},
    entitlementId:()=>`PLUSENT-${creates+1}`,
  });
  const [first,second]=await Promise.all([
    service.grantVerifiedPayment(paidEvent('2026-08-28T00:00:00Z')),
    service.grantVerifiedPayment(paidEvent('2026-08-28T00:00:00Z')),
  ]);
  assert.equal(creates,1);
  assert.equal([first,second].filter((item)=>item.duplicate).length,1);
  assert.deepEqual(lockKeys,['plus-entitlement:U-1','plus-entitlement:U-1']);
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
