const test=require('node:test');
const assert=require('node:assert/strict');

process.env.NODE_ENV='test';

const {
  pharmacistConsoleUrl,queuedNotificationMessages,
  createConsultationPharmacistNotificationService,
} = require('../backend/services/consultationPharmacistNotificationService');
const { createConsultationRepository } = require('../backend/services/consultationRepository');
const { createConsultationPaymentIngestionService } = require('../backend/services/consultationPaymentIngestionService');
const { createConsultationPaymentReconciliationService } = require('../backend/services/consultationPaymentReconciliationService');

const ACTIVE=(id,line)=>({pharmacist_id:id,line_user_id:line,status:'active',license_verified_at:'2026-08-26T00:00:00Z'});

test('Pharmacist Console link derives only from LIFF_ID_PHARMACIST and fails closed when absent',()=>{
  assert.equal(pharmacistConsoleUrl({LIFF_ID_PHARMACIST:'2000000000-PHARM'}),'https://liff.line.me/2000000000-PHARM');
  assert.equal(pharmacistConsoleUrl({LIFF_ID_PHARMACIST:''}),null);
  assert.equal(pharmacistConsoleUrl({LIFF_ID_PHARMACIST:'bad/id?x=1'}),null);
  assert.equal(queuedNotificationMessages(null),null);
});

test('queued case creates one minimal outbox intent for every eligible pharmacist',async()=>{
  const calls=[];const keys=new Set();
  const service=createConsultationPharmacistNotificationService({
    env:{LIFF_ID_PHARMACIST:'2000000000-PHARM'},
    repository:{async listEligiblePharmacists(){return [
      ACTIVE('PH-1','U-PH-1'),ACTIVE('PH-2','U-PH-2'),
      {...ACTIVE('PH-S','U-S'),status:'suspended'},
      {...ACTIVE('PH-U','U-U'),license_verified_at:null},
      {...ACTIVE('PH-E',''),line_user_id:''},
    ];}},
    transaction:async(_key,fn)=>fn(),
    enqueue:async(input)=>{calls.push(input);const duplicate=keys.has(input.dedupeKey);keys.add(input.dedupeKey);return {ok:true,duplicate};},
  });
  const first=await service.notifyQueuedCase({caseId:'CASE-1'});
  const replay=await service.notifyQueuedCase({caseId:'CASE-1'});
  assert.deepEqual(first,{status:'ready',queued:2,duplicate:0,skipped:3});
  assert.deepEqual(replay,{status:'ready',queued:0,duplicate:2,skipped:3});
  assert.equal(new Set(calls.map((item)=>item.dedupeKey)).size,2);
  assert.ok(calls.every((item)=>item.kind==='consultation_queued'));
  assert.ok(calls.every((item)=>item.messages[0].text.includes('https://liff.line.me/2000000000-PHARM')));
  const visibleMessages=JSON.stringify(calls.map((item)=>item.messages));
  for(const forbidden of ['U-PH-1','U-PH-2','patient','Care Profile','medication','allergy','phone','question']) {
    assert.equal(visibleMessages.toLowerCase().includes(forbidden.toLowerCase()),false,forbidden);
  }
});

test('missing pharmacist LIFF configuration creates no outbox intent',async()=>{
  let lookups=0;let enqueues=0;
  const service=createConsultationPharmacistNotificationService({
    env:{},repository:{async listEligiblePharmacists(){lookups+=1;return [ACTIVE('PH-1','U-1')];}},
    enqueue:async()=>{enqueues+=1;return {ok:true};},transaction:async(_key,fn)=>fn(),
  });
  assert.deepEqual(await service.notifyQueuedCase({caseId:'CASE-1'}),{status:'configuration_unavailable',queued:0,duplicate:0});
  assert.equal(lookups,0);assert.equal(enqueues,0);
});

test('repository selects only active license-verified pharmacists with a LINE recipient',async()=>{
  const calls=[];const repository=createConsultationRepository({queryFn:async(sql,params)=>{calls.push({sql,params});return {rows:[ACTIVE('PH-1','U-1')]};}});
  const rows=await repository.listEligiblePharmacists();assert.equal(rows.length,1);
  assert.match(calls[0].sql,/status = 'active'/);
  assert.match(calls[0].sql,/license_verified_at IS NOT NULL/);
  assert.match(calls[0].sql,/btrim\(line_user_id\) <> ''/);
  assert.doesNotMatch(calls[0].sql,/consultation_orders|careProfiles|medication|allerg/i);
});

test('notification enqueue failure never changes a successfully provisioned payment result',async()=>{
  const logs=[];
  const service=createConsultationPaymentIngestionService({
    repository:{},transaction:async(_key,fn)=>fn(),
    provisioner:{async provisionVerifiedPayment(){return {order:{status:'paid'},consultationCase:{case_id:'CASE-1'},duplicate:false};}},
    pharmacistNotifications:{async notifyQueuedCase(){throw new Error('private LINE/outbox error');}},
    operationalLogger:(event)=>logs.push(event),
  });
  const result=await service.processIngestedEvent({
    event:{provider:'omise',providerEventId:'EV-1',providerPaymentId:'CH-1',providerCheckoutId:'CH-1',orderId:'ORD-1',amountMinor:10000,currency:'THB',eventType:'payment_succeeded',verified:true,signatureVerified:true,paidAt:'2026-08-26T00:00:00Z'},
    transaction:{payment_transaction_id:'PAY-1',processing_status:'verified'},status:'verified',
  });
  assert.equal(result.status,'processed');assert.equal(result.consultationCase.case_id,'CASE-1');
  assert.deepEqual(logs,[{event:'consultation_notification_enqueue_failed',safeErrorCode:'CONSULTATION_NOTIFICATION_ENQUEUE_FAILED'}]);
  assert.doesNotMatch(JSON.stringify(logs),/private|LINE\/outbox|ORD-1|CH-1/);
});

test('duplicate processed webhook safely retries the same notification identity without reprovisioning',async()=>{
  const notified=[];let provisionCalls=0;
  const repository={
    async findOrder(){return {order_id:'ORD-1',status:'paid',provisioning_status:'provisioned'};},
    async findCaseByOrderId(){return {case_id:'CASE-1'};},
  };
  const service=createConsultationPaymentIngestionService({
    repository,transaction:async(_key,fn)=>fn(),
    provisioner:{async provisionVerifiedPayment(){provisionCalls+=1;}},
    pharmacistNotifications:{async notifyQueuedCase(input){notified.push(input);}},
  });
  const result=await service.processIngestedEvent({
    event:{orderId:'ORD-1'},transaction:{processing_status:'processed'},status:'processed',
  });
  assert.equal(result.duplicate,true);assert.equal(provisionCalls,0);
  assert.deepEqual(notified,[{caseId:'CASE-1'}]);
});

test('paid/provisioned reconciliation recovers a missing queued notification intent',async()=>{
  const notified=[];let providerCalls=0;
  const service=createConsultationPaymentReconciliationService({
    repository:{
      async findOrder(){return {order_id:'ORD-1',status:'paid',provisioning_status:'provisioned'};},
      async findCaseByOrderId(){return {case_id:'CASE-1'};},
    },
    pharmacistNotifications:{async notifyQueuedCase(input){notified.push(input);}},
    providerFactory:()=>{providerCalls+=1;return {};},
  });
  const result=await service.reconcileOrder({orderId:'ORD-1'});
  assert.equal(result.status,'processed');assert.equal(result.duplicate,true);
  assert.equal(providerCalls,0);assert.deepEqual(notified,[{caseId:'CASE-1'}]);
});
