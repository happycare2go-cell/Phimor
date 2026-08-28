const test=require('node:test');
const assert=require('node:assert/strict');

process.env.NODE_ENV='test';

const {createConsultationOrderService}=require('../backend/services/consultationOrderService');
const {createConsultationCheckoutService,safePaymentResumeData}=require('../backend/services/consultationCheckoutService');
const {createConsultationPaymentStatusService}=require('../backend/services/consultationPaymentStatusService');
const {createConsultationPaymentReconciliationService}=require('../backend/services/consultationPaymentReconciliationService');
const {createConsultationRepository}=require('../backend/services/consultationRepository');

const NOW='2026-08-28T03:00:00.000Z';
const CONFIG={enabled:true,internalOnly:false,internalLineUserIds:[],priceMinor:10000,currency:'THB',durationMinutes:1440,termsVersion:'consult-v1'};
const clone=(value)=>value==null?value:structuredClone(value);

function createCheckoutHarness() {
  const state={orders:new Map(),providerCalls:0,auth:[],sequence:0};
  const locks=new Map();
  const transaction=async(key,task)=>{const previous=locks.get(key)||Promise.resolve();let release;const gate=new Promise((resolve)=>{release=resolve;});locks.set(key,previous.then(()=>gate));await previous;try{return await task();}finally{release();}};
  const repository={
    async findActiveCheckoutForUpdate(customer,profile){return clone([...state.orders.values()].find((row)=>row.customer_line_user_id===customer&&row.care_profile_id===profile&&(['draft','payment_pending'].includes(row.status)||(row.status==='paid'&&row.provisioning_status!=='provisioned')))||null);},
    async createOrder(record){if([...state.orders.values()].some((row)=>row.customer_line_user_id===record.customer_line_user_id&&row.care_profile_id===record.care_profile_id&&(['draft','payment_pending'].includes(row.status)||(row.status==='paid'&&row.provisioning_status!=='provisioned'))))return null;const row={...clone(record),status:'draft',provisioning_status:'pending',created_at:NOW};state.orders.set(row.order_id,row);return clone(row);},
    async findOrderForUpdate(id){return clone(state.orders.get(id)||null);},
    async findOrder(id){return clone(state.orders.get(id)||null);},
    async markOrderPaymentPending(id,{provider,providerCheckoutId,paymentDueAt,paymentResumeData}){const row=state.orders.get(id);Object.assign(row,{status:'payment_pending',provider,provider_checkout_id:providerCheckoutId,payment_due_at:paymentDueAt,payment_resume_data:clone(paymentResumeData)});return clone(row);},
    async markOrderPaymentFailed(id){const row=state.orders.get(id);row.status='failed';row.payment_resume_data=null;return clone(row);},
    async markOrderExpired(id){const row=state.orders.get(id);row.status='expired';return clone(row);},
  };
  const authorize=async(input)=>{state.auth.push(input);return {principalType:'family_owner'};};
  const orderService=createConsultationOrderService({repository,transaction,authorize,now:()=>NOW,orderId:()=>`ORDER-${++state.sequence}`});
  const provider={async createCheckout({orderId}){state.providerCalls+=1;await Promise.resolve();return {provider:'fake',checkoutId:`CHECKOUT-${orderId}`,paymentDueAt:'2026-08-28T03:20:00.000Z',paymentInstructions:{method:'promptpay',qrImageUrl:'https://cdn.omise.co/recovery.png',expiresAt:'2026-08-28T03:20:00.000Z',providerSecret:'never'}};}};
  const checkout=createConsultationCheckoutService({repository,transaction,orderService,configLoader:()=>CONFIG});
  return {state,repository,transaction,authorize,orderService,provider,checkout};
}

const checkoutInput=(extra={})=>({lineUserId:'U-FAMILY',careProfileId:'CP-1',initialQuestion:'ขอคำปรึกษาเรื่องยา',termsAccepted:true,termsVersion:'consult-v1',config:CONFIG,...extra});

test('two concurrent checkout requests share one active order and one provider checkout',async()=>{
  const h=createCheckoutHarness();
  const [first,second]=await Promise.all([
    h.checkout.prepareCheckout({...checkoutInput(),provider:h.provider}),
    h.checkout.prepareCheckout({...checkoutInput(),provider:h.provider}),
  ]);
  assert.equal(h.state.orders.size,1);assert.equal(h.state.providerCalls,1);
  assert.equal(first.orderId,second.orderId);
  assert.equal([first.resumed,second.resumed].filter(Boolean).length,1);
  assert.equal(h.state.auth.length,2);
});

test('second device reuses pending checkout and receives only safe persisted payment instructions',async()=>{
  const h=createCheckoutHarness();
  const first=await h.checkout.prepareCheckout({...checkoutInput(),provider:h.provider});
  const resumed=await h.checkout.prepareCheckout({...checkoutInput(),provider:h.provider});
  assert.equal(resumed.resumed,true);assert.equal(resumed.orderId,first.orderId);assert.equal(resumed.status,'payment_pending');
  assert.deepEqual(resumed.paymentInstructions,{method:'promptpay',qrImageUrl:'https://cdn.omise.co/recovery.png',expiresAt:'2026-08-28T03:20:00.000Z'});
  assert.equal(JSON.stringify(resumed).includes('never'),false);assert.equal(h.state.providerCalls,1);
});

test('safe payment resume projection rejects credentialed or non-HTTPS QR URLs',()=>{
  assert.deepEqual(safePaymentResumeData({method:'promptpay',qrImageUrl:'https://cdn.omise.co/qr'}),{method:'promptpay',qrImageUrl:'https://cdn.omise.co/qr'});
  assert.deepEqual(safePaymentResumeData({method:'promptpay',qrImageUrl:'http://cdn.omise.co/qr'}),{method:'promptpay'});
  assert.deepEqual(safePaymentResumeData({method:'promptpay',qrImageUrl:'https://user:secret@cdn.omise.co/qr'}),{method:'promptpay'});
  assert.equal(safePaymentResumeData({method:'card',token:'secret'}),null);
});

test('pending checkout discovery authorizes the selected Care Profile before returning actor-owned state',async()=>{
  const calls=[];const repository={
    async findCurrentCheckout(actor,profile){calls.push({actor,profile});return {order_id:'ORDER-1',customer_line_user_id:actor,care_profile_id:profile,status:'payment_pending',provisioning_status:'pending',amount_minor:10000,currency:'THB',payment_due_at:'2026-08-28T04:00:00.000Z',payment_resume_data:{method:'promptpay',qrImageUrl:'https://cdn.omise.co/qr.png'},database_now:NOW};},
  };
  const auth=[];const service=createConsultationPaymentStatusService({repository,authorize:async(input)=>auth.push(input)});
  const result=await service.getCurrent({lineUserId:'U-FAMILY',careProfileId:'CP-1'});
  assert.equal(result.status,'payment_pending');assert.equal(result.orderId,'ORDER-1');assert.match(result.payment.qrImageUrl,/cdn\.omise\.co/);
  assert.deepEqual(calls,[{actor:'U-FAMILY',profile:'CP-1'}]);assert.equal(auth[0].lineUserId,'U-FAMILY');assert.equal(auth[0].careProfileId,'CP-1');
  assert.doesNotMatch(JSON.stringify(result),/customer_line_user_id|care_profile_id|provider_checkout/i);
});

test('repository active-checkout SQL uses the database uniqueness boundary and locks authoritative row',async()=>{
  const calls=[];const repository=createConsultationRepository({queryFn:async(sql,params)=>{calls.push({sql:String(sql),params});return {rows:[]};}});
  await repository.findActiveCheckoutForUpdate('U-1','CP-1');await repository.createOrder({order_id:'O-1',customer_line_user_id:'U-1',care_profile_id:'CP-1',initial_question:'ยา',amount_minor:10000,currency:'THB',duration_minutes:1440,terms_version:'v1',terms_accepted_at:NOW});
  assert.match(calls[0].sql,/FOR UPDATE/);assert.match(calls[0].sql,/customer_line_user_id = \$1 AND care_profile_id = \$2/);
  assert.match(calls[1].sql,/ON CONFLICT DO NOTHING/);
});

test('payment reconciliation sweep is idempotent and schedules a bounded retry without clinical logging',async()=>{
  const state={order:{order_id:'ORDER-1',status:'payment_pending',provider:'fake',provider_payment_id:null,payment_due_at:'2026-08-28T04:00:00.000Z',reconciliation_attempts:0},finish:[],logs:[]};
  const repository={
    async expireStaleDraftOrders(){return [];},async listOrdersDueForReconciliation(){return ['ORDER-1'];},
    async markOrderReconciliationAttempt(_id,{nextAttemptAt}){state.order.reconciliation_attempts+=1;state.order.reconciliation_next_attempt_at=nextAttemptAt;return clone(state.order);},
    async findOrder(){return clone(state.order);},async findCaseByOrderId(){return null;},async findLatestPaymentTransactionForOrder(){return null;},
    async finishOrderReconciliation(_id,patch){state.finish.push(patch);Object.assign(state.order,{reconciliation_next_attempt_at:patch.nextAttemptAt,reconciliation_last_error:patch.errorCode});return clone(state.order);},
  };
  const provider={async retrievePayment(){const error=new Error('private provider payload');error.code='OMISE_TEMPORARY';throw error;}};
  const service=createConsultationPaymentReconciliationService({repository,transaction:async(_key,task)=>task(),providerFactory:()=>provider,ingestionService:{},operationalLogger:(entry)=>state.logs.push(entry),now:()=>new Date(NOW)});
  const result=await service.sweepPendingOrders();
  assert.deepEqual({...result},{scanned:1,processed:0,pending:0,failed:1,expired:0,staleDrafts:0});
  assert.match(state.finish[0].nextAttemptAt,/Z$/);assert.equal(state.finish[0].errorCode,'OMISE_TEMPORARY');
  assert.deepEqual(state.logs,[{event:'consultation_payment_reconciliation_failed',safeErrorCode:'OMISE_TEMPORARY'}]);
  assert.doesNotMatch(JSON.stringify(state.logs),/private provider payload|question|medication/i);
});
