const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { FakePaymentProvider } = require('../backend/providers/FakePaymentProvider');
const { createConsultationOrderService } = require('../backend/services/consultationOrderService');
const { createConsultationCheckoutService } = require('../backend/services/consultationCheckoutService');
const { createConsultationPaymentIngestionService } = require('../backend/services/consultationPaymentIngestionService');
const { createConsultationPaymentReconciliationService } = require('../backend/services/consultationPaymentReconciliationService');
const { createConsultationRateLimitService } = require('../backend/services/consultationRateLimitService');
const { loadConsultationConfig } = require('../backend/config/consultationConfig');

const NOW = '2026-08-25T03:00:00.000Z';
const CONFIG = Object.freeze({
  enabled:true, internalOnly:false, internalLineUserIds:[],
  priceMinor:10000, currency:'THB', durationMinutes:1440,
  pollSeconds:5, maxMessageChars:4000, termsVersion:'consult-2026-08',
  rateLimits:Object.freeze({
    checkoutAttemptsPer10Minutes:3,
    messageSendsPerMinute:10,
    pharmacistAcceptsPerMinute:10,
  }),
});

function copy(value) { return value == null ? value : structuredClone(value); }

function createHarness() {
  const state = {
    orders:new Map(), payments:new Map(), cases:new Map(), events:[],
    createCaseFailures:0, authorizationCalls:0, profileWrites:0, healthHistoryWrites:0,
  };
  const locks = new Map();
  let sequence = 0;

  const transaction = async (key, operation) => {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release=resolve; });
    locks.set(key, previous.then(() => current));
    await previous;
    const snapshot = copy({
      orders:[...state.orders], payments:[...state.payments], cases:[...state.cases],
      events:state.events,
    });
    try { return await operation(); }
    catch (error) {
      state.orders=new Map(snapshot.orders);
      state.payments=new Map(snapshot.payments);
      state.cases=new Map(snapshot.cases);
      state.events=snapshot.events;
      throw error;
    } finally { release(); }
  };

  function paymentKey(provider,eventId) { return `${provider}:${eventId}`; }
  const repository = {
    async createOrder(record) {
      const row={...copy(record),status:'draft',provisioning_status:'pending',provider:null,
        provider_checkout_id:null,payment_due_at:null,paid_at:null,created_at:NOW,updated_at:NOW};
      state.orders.set(row.order_id,row); return copy(row);
    },
    async findOrder(id) { return copy(state.orders.get(id)||null); },
    async findOrderForUpdate(id) { return copy(state.orders.get(id)||null); },
    async markOrderPaymentPending(id,{provider,providerCheckoutId,paymentDueAt=null}) {
      const row=state.orders.get(id); if (!row || row.status==='paid') return null;
      Object.assign(row,{status:'payment_pending',provider,provider_checkout_id:providerCheckoutId,
        payment_due_at:paymentDueAt,updated_at:NOW}); return copy(row);
    },
    async markOrderPaymentFailed(id) {
      const row=state.orders.get(id); if (!row || row.status==='paid') return null;
      row.status='failed'; row.updated_at=NOW; return copy(row);
    },
    async ingestPaymentTransaction(record) {
      const key=paymentKey(record.provider,record.provider_event_id);
      if (state.payments.has(key)) return {transaction:copy(state.payments.get(key)),duplicate:true};
      const row={...copy(record),received_at:NOW,processed_at:null,failure_code:null,attempts:0};
      state.payments.set(key,row); return {transaction:copy(row),duplicate:false};
    },
    async insertPaymentTransaction(record) {
      const key=paymentKey(record.provider,record.provider_event_id);
      if (state.payments.has(key)) return {transaction:copy(state.payments.get(key)),duplicate:true};
      const row={...copy(record),processing_status:'verified',signature_verified:true,
        received_at:NOW,processed_at:null,failure_code:null,attempts:1};
      state.payments.set(key,row); return {transaction:copy(row),duplicate:false};
    },
    async findPaymentTransaction(provider,eventId) {
      return copy(state.payments.get(paymentKey(provider,eventId))||null);
    },
    async findLatestPaymentTransactionForOrder(orderId) {
      return copy([...state.payments.values()].filter((item)=>item.order_id===orderId).at(-1)||null);
    },
    async markPaymentTransactionVerified(id) {
      const found=[...state.payments].find(([,row])=>row.payment_transaction_id===id);
      if (!found) return null;
      const row={...found[1],signature_verified:true,processing_status:'verified',processed_at:null,
        failure_code:null,attempts:found[1].attempts+1};
      state.payments.set(found[0],row); return copy(row);
    },
    async updatePaymentTransaction(id,patch) {
      const found=[...state.payments].find(([,row])=>row.payment_transaction_id===id);
      if (!found) return null;
      const row={...found[1],...copy(patch),attempts:found[1].attempts+1};
      state.payments.set(found[0],row); return copy(row);
    },
    async markOrderPaid(id,paidAt) {
      const row=state.orders.get(id); if (!row) return null;
      Object.assign(row,{status:'paid',paid_at:paidAt,provisioning_status:'pending',updated_at:NOW});
      return copy(row);
    },
    async markOrderProvisioned(id) {
      const row=state.orders.get(id); if (!row) return null;
      row.provisioning_status='provisioned'; row.updated_at=NOW; return copy(row);
    },
    async findCaseByOrderId(orderId) {
      return copy([...state.cases.values()].find((item)=>item.order_id===orderId)||null);
    },
    async createQueuedCase(record) {
      if (state.createCaseFailures>0) {
        state.createCaseFailures-=1;
        throw new Error('simulated case insert failure');
      }
      const existing=[...state.cases.values()].find((item)=>item.order_id===record.order_id);
      if (existing) return {consultationCase:copy(existing),created:false};
      const row={...copy(record),state:'queued',waiting_on:'none',queued_at:NOW};
      state.cases.set(row.case_id,row); return {consultationCase:copy(row),created:true};
    },
    async insertEvent(record) {
      if (record.idempotency_key && state.events.some((event)=>event.case_id===record.case_id
          && event.idempotency_key===record.idempotency_key)) return null;
      state.events.push(copy(record)); return copy(record);
    },
  };

  const authorize = async ({lineUserId}) => {
    state.authorizationCalls+=1;
    if (lineUserId==='U-DENIED') { const error=new Error('denied'); error.code='ACCESS_DENIED'; throw error; }
    return {principalType:'family_owner',permissions:['view']};
  };
  const orderService=createConsultationOrderService({repository,transaction,authorize,now:()=>NOW,
    orderId:()=>`ORD-${++sequence}`});
  const ingestion=createConsultationPaymentIngestionService({repository,transaction,
    paymentTransactionId:()=>`PAYTX-${++sequence}`});
  return {state,repository,transaction,authorize,orderService,ingestion};
}

function successfulEnvelope(order,overrides={}) {
  return {
    scenario:'success',signatureValid:true,eventId:`EVENT-${order.order_id}`,
    paymentId:`PAYMENT-${order.order_id}`,checkoutId:order.provider_checkout_id,
    orderId:order.order_id,amountMinor:10000,currency:'THB',paidAt:NOW,...overrides,
  };
}

async function createPendingCheckout(h,{lineUserId='U-OWNER',question='กินยาสองตัวนี้ด้วยกันได้ไหม',config=CONFIG}={}) {
  const provider=new FakePaymentProvider({now:()=>new Date(NOW)});
  const checkout=createConsultationCheckoutService({repository:h.repository,transaction:h.transaction,
    orderService:h.orderService,configLoader:()=>config});
  const result=await checkout.prepareCheckout({lineUserId,careProfileId:'CP-1',initialQuestion:question,
    termsAccepted:true,termsVersion:config.termsVersion,provider,config});
  return {provider,result,order:await h.repository.findOrder(result.orderId)};
}

test('checkout fails closed when terms version is missing and never reaches provider', async () => {
  const h=createHarness(); const provider=new FakePaymentProvider();
  const service=createConsultationCheckoutService({repository:h.repository,transaction:h.transaction,
    orderService:h.orderService,configLoader:()=>({...CONFIG,termsVersion:null})});
  await assert.rejects(()=>service.prepareCheckout({lineUserId:'U-OWNER',careProfileId:'CP-1',
    initialQuestion:'กินยาสองตัวนี้ด้วยกันได้ไหม',termsAccepted:true,termsVersion:'guessed-v1',provider}),
  (error)=>error.code==='CONSULTATION_TERMS_NOT_CONFIGURED');
  assert.equal(provider.calls.createCheckout,0); assert.equal(h.state.orders.size,0);
});

test('checkout snapshots immutable terms, 100 THB, THB and 1440 minutes without queue entry', async () => {
  const h=createHarness(); const {provider,result,order}=await createPendingCheckout(h);
  assert.deepEqual({terms:order.terms_version,accepted:order.terms_accepted_at,amount:order.amount_minor,
    currency:order.currency,duration:order.duration_minutes},
  {terms:CONFIG.termsVersion,accepted:NOW,amount:10000,currency:'THB',duration:1440});
  assert.equal(result.status,'payment_pending'); assert.equal(provider.calls.createCheckout,1);
  assert.equal(h.state.cases.size,0); assert.equal(h.state.events.length,0);
});

test('Care Profile authorization and emergency gate happen before checkout provider call', async () => {
  for (const request of [
    {lineUserId:'U-DENIED',question:'กินยาสองตัวนี้ด้วยกันได้ไหม',code:'ACCESS_DENIED',authCalls:1},
    {lineUserId:'U-OWNER',question:'คุณแม่หมดสติ ปลุกไม่ตื่น',code:'EMERGENCY_BLOCKED',authCalls:0},
  ]) {
    const h=createHarness(); const provider=new FakePaymentProvider();
    const service=createConsultationCheckoutService({repository:h.repository,transaction:h.transaction,
      orderService:h.orderService,configLoader:()=>CONFIG});
    await assert.rejects(()=>service.prepareCheckout({lineUserId:request.lineUserId,careProfileId:'CP-1',
      initialQuestion:request.question,termsAccepted:true,termsVersion:CONFIG.termsVersion,provider}),
    (error)=>error.code===request.code);
    assert.equal(h.state.authorizationCalls,request.authCalls);
    assert.equal(provider.calls.createCheckout,0); assert.equal(h.state.orders.size,0);
  }
});

test('FakePaymentProvider supports success, failure, delay, lookup and no network behavior', async () => {
  const provider=new FakePaymentProvider({now:()=>new Date(NOW)});
  const success=await provider.verifyWebhook({scenario:'success',signatureValid:true,eventId:'E-1',
    paymentId:'P-1',orderId:'O-1',amountMinor:10000,currency:'THB'});
  const failed=await provider.verifyWebhook({scenario:'failed',eventId:'E-2',paymentId:'P-2',
    orderId:'O-2',amountMinor:10000,currency:'THB'});
  const delayed=await provider.verifyWebhook({scenario:'success',eventId:'E-3',paymentId:'P-3',
    orderId:'O-3',amountMinor:10000,currency:'THB',availableAt:'2026-08-26T00:00:00Z'});
  assert.equal(success.eventType,'payment_succeeded'); assert.equal(failed.eventType,'payment_failed');
  assert.equal(delayed.eventType,'payment_pending');
  assert.equal((await provider.retrievePayment({providerPaymentId:'P-1'})).orderId,'O-1');
  await assert.rejects(()=>provider.retrievePayment({providerPaymentId:'missing'}),(error)=>error.code==='FAKE_PAYMENT_NOT_FOUND');
  assert.equal(/fetch\(|https?:\/\//.test(FakePaymentProvider.toString()),false);
});

test('invalid signature is durably rejected and creates no consultation case', async () => {
  const h=createHarness(); const {provider,order}=await createPendingCheckout(h);
  const result=await h.ingestion.ingestAndProcess({provider,eventEnvelope:successfulEnvelope(order,{signatureValid:false})});
  assert.equal(result.status,'rejected'); assert.equal(result.errorCode,'INVALID_PAYMENT_SIGNATURE');
  assert.equal(h.state.payments.size,1); assert.equal(h.state.cases.size,0);
});

test('signature replay cannot downgrade paid event and a later valid replay may recover rejected ingestion', async () => {
  const h=createHarness(); const {provider,order}=await createPendingCheckout(h); const envelope=successfulEnvelope(order);
  await h.ingestion.ingestAndProcess({provider,eventEnvelope:{...envelope,signatureValid:false}});
  const recovered=await h.ingestion.ingestAndProcess({provider,eventEnvelope:envelope});
  assert.equal(recovered.status,'processed'); assert.equal(h.state.cases.size,1);
  const rejectedReplay=await h.ingestion.ingestAndProcess({provider,eventEnvelope:{...envelope,signatureValid:false}});
  assert.equal(rejectedReplay.status,'rejected');
  assert.equal([...h.state.payments.values()][0].processing_status,'processed');
  assert.equal(h.state.orders.get(order.order_id).status,'paid');
});

test('wrong payment amount and currency are rejected without queue provisioning', async () => {
  for (const override of [{amountMinor:9999},{currency:'USD'}]) {
    const h=createHarness(); const {provider,order}=await createPendingCheckout(h);
    const result=await h.ingestion.ingestAndProcess({provider,eventEnvelope:successfulEnvelope(order,override)});
    assert.equal(result.status,'rejected'); assert.match(result.errorCode,/PAYMENT_(AMOUNT|CURRENCY)_MISMATCH/);
    assert.equal(h.state.cases.size,0); assert.notEqual(h.state.orders.get(order.order_id).status,'paid');
  }
});

test('successful payment must match checkout and include a provider payment reference', async () => {
  for (const override of [{checkoutId:null},{checkoutId:'OTHER-CHECKOUT'},{paymentId:null}]) {
    const h=createHarness(); const {provider,order}=await createPendingCheckout(h);
    const operation=()=>h.ingestion.ingestAndProcess({provider,eventEnvelope:successfulEnvelope(order,override)});
    const result=await operation();
    assert.equal(result.status,'rejected');
    assert.equal(result.errorCode,override.paymentId===null
      ? 'PAYMENT_REFERENCE_REQUIRED' : 'PAYMENT_CHECKOUT_MISMATCH');
    assert.equal(h.state.cases.size,0);
  }
});

test('duplicate verified provider event is idempotent and provisions exactly one case/event', async () => {
  const h=createHarness(); const {provider,order}=await createPendingCheckout(h); const envelope=successfulEnvelope(order);
  const first=await h.ingestion.ingestAndProcess({provider,eventEnvelope:envelope});
  const duplicate=await h.ingestion.ingestAndProcess({provider,eventEnvelope:envelope});
  assert.equal(first.status,'processed'); assert.equal(duplicate.status,'processed'); assert.equal(duplicate.duplicate,true);
  assert.equal(h.state.payments.size,1); assert.equal(h.state.cases.size,1); assert.equal(h.state.events.length,1);
});

test('same provider event replayed against another order is rejected as a conflict', async () => {
  const h=createHarness(); const first=await createPendingCheckout(h); const second=await createPendingCheckout(h);
  await h.ingestion.ingestAndProcess({provider:first.provider,eventEnvelope:successfulEnvelope(first.order,{eventId:'SHARED'})});
  await assert.rejects(()=>h.ingestion.ingestAndProcess({provider:second.provider,
    eventEnvelope:successfulEnvelope(second.order,{eventId:'SHARED',paymentId:'P-OTHER'})}),
  (error)=>error.code==='PAYMENT_EVENT_CONFLICT');
  assert.equal(h.state.cases.size,1);
});

test('provisioning crash leaves durable retry event and stored-event retry creates one case', async () => {
  const h=createHarness(); const {provider,order}=await createPendingCheckout(h); h.state.createCaseFailures=1;
  const first=await h.ingestion.ingestAndProcess({provider,eventEnvelope:successfulEnvelope(order)});
  assert.equal(first.status,'retry_required'); assert.equal(h.state.payments.size,1);
  assert.equal(h.state.orders.get(order.order_id).status,'payment_pending'); assert.equal(h.state.cases.size,0);
  const retried=await h.ingestion.processStoredEvent({provider:'fake_payment',providerEventId:`EVENT-${order.order_id}`});
  assert.equal(retried.status,'processed'); assert.equal(h.state.cases.size,1); assert.equal(h.state.events.length,1);
});

test('paid-but-unprovisioned reconciliation is idempotent and provider-reference protected', async () => {
  const h=createHarness(); const {provider,order}=await createPendingCheckout(h); h.state.createCaseFailures=1;
  const envelope=successfulEnvelope(order); await h.ingestion.ingestAndProcess({provider,eventEnvelope:envelope});
  const reconcile=createConsultationPaymentReconciliationService({repository:h.repository,transaction:h.transaction,
    ingestionService:h.ingestion});
  const result=await reconcile.reconcileOrder({orderId:order.order_id,provider});
  const duplicate=await reconcile.reconcileOrder({orderId:order.order_id,provider});
  assert.equal(result.status,'processed'); assert.equal(duplicate.duplicate,true); assert.equal(h.state.cases.size,1);

  const h2=createHarness(); const pending=await createPendingCheckout(h2);
  pending.provider.setPayment({providerPaymentId:'MISMATCH',providerEventId:'E-MISMATCH',
    providerCheckoutId:pending.order.provider_checkout_id,orderId:pending.order.order_id,
    amountMinor:10000,currency:'THB',eventType:'payment_succeeded',paidAt:NOW});
  h2.state.payments.set('fake_payment:E-OLD',{payment_transaction_id:'PT-OLD',order_id:pending.order.order_id,
    provider:'fake_payment',provider_event_id:'E-OLD',provider_payment_id:'OTHER',event_type:'payment_succeeded',
    processing_status:'retry_required',amount_minor:10000,currency:'THB',signature_verified:true,received_at:NOW});
  const mismatch=createConsultationPaymentReconciliationService({repository:h2.repository,transaction:h2.transaction,
    ingestionService:h2.ingestion});
  await assert.rejects(()=>mismatch.reconcileOrder({orderId:pending.order.order_id,provider:pending.provider}),
    (error)=>error.code==='PAYMENT_REFERENCE_MISMATCH');
});

test('out-of-order failed then success and late success after local expiry are accepted safely', async () => {
  for (const locallyExpired of [false,true]) {
    const h=createHarness(); const {provider,order}=await createPendingCheckout(h);
    if (locallyExpired) h.state.orders.get(order.order_id).status='expired';
    else await h.ingestion.ingestAndProcess({provider,eventEnvelope:successfulEnvelope(order,{scenario:'failed',eventId:'FAIL'})});
    const success=await h.ingestion.ingestAndProcess({provider,eventEnvelope:successfulEnvelope(order,{eventId:'SUCCESS'})});
    assert.equal(success.status,'processed'); assert.equal(h.state.orders.get(order.order_id).status,'paid');
    assert.equal(h.state.cases.size,1);
  }
});

test('later failed, pending or unknown events never downgrade a paid order', async () => {
  for (const scenario of ['failed','pending','unknown']) {
    const h=createHarness(); const {provider,order}=await createPendingCheckout(h);
    await h.ingestion.ingestAndProcess({provider,eventEnvelope:successfulEnvelope(order,{eventId:'SUCCESS'})});
    const result=await h.ingestion.ingestAndProcess({provider,eventEnvelope:successfulEnvelope(order,
      {scenario,eventId:`LATER-${scenario}`,paymentId:`P-${scenario}`})});
    assert.equal(result.status,'ignored'); assert.equal(result.reasonCode,'PAID_ORDER_NOT_DOWNGRADED');
    assert.equal(h.state.orders.get(order.order_id).status,'paid'); assert.equal(h.state.cases.size,1);
  }
});

test('malformed consultation rate-limit environment values use conservative defaults', () => {
  const config=loadConsultationConfig({
    CONSULTATION_CHECKOUT_ATTEMPTS_PER_10_MINUTES:'unlimited',
    CONSULTATION_MESSAGE_SENDS_PER_MINUTE:'-1',
    CONSULTATION_PHARMACIST_ACCEPTS_PER_MINUTE:'999999',
    CONSULTATION_ASSISTANT_REQUESTS_PER_10_MINUTES:'unlimited',
  });
  assert.deepEqual(config.rateLimits,{
    checkoutAttemptsPer10Minutes:3,messageSendsPerMinute:10,pharmacistAcceptsPerMinute:10,
    assistantRequestsPer10Minutes:5,
  });
  const calls=[];
  const limiter={checkAndRecord(...args){calls.push(args); return {allowed:true,remaining:0,retryAfterMs:0};}};
  const service=createConsultationRateLimitService({limiter,configLoader:()=>config});
  service.checkCheckout('U-1'); service.checkMessage({caseId:'C-1',actorType:'customer',actorId:'U-1'});
  service.checkPharmacistAccept('PH-1');
  service.checkAssistant({caseId:'C-1',pharmacistId:'PH-1'});
  assert.deepEqual(calls.map((item)=>item.slice(1)),[[3,600000],[10,60000],[10,60000],[5,600000]]);
});

test('durable payment ingestion allowlists metadata and excludes raw payload, secrets and health context', async () => {
  const h=createHarness(); const {provider,order}=await createPendingCheckout(h);
  await h.ingestion.ingestAndProcess({provider,eventEnvelope:{...successfulEnvelope(order),
    rawPayload:'SECRET-WEBHOOK',providerSecret:'SECRET-KEY',healthContext:{medications:['secret']},
    lineAccessToken:'LINE-SECRET'}});
  const stored=JSON.stringify([...h.state.payments.values()]);
  for (const secret of ['SECRET-WEBHOOK','SECRET-KEY','secret','LINE-SECRET']) assert.equal(stored.includes(secret),false);
  assert.equal(h.state.profileWrites,0); assert.equal(h.state.healthHistoryWrites,0);
});
