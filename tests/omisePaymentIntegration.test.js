const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const http=require('node:http');
const express=require('express');

process.env.NODE_ENV='test';
process.env.ALLOW_INSECURE_LINE_HEADER='true';

const {OmisePaymentProvider}=require('../backend/providers/OmisePaymentProvider');
const {createConsultationsRouter}=require('../backend/routes/consultations');
const {createConsultationOmiseWebhookService}=require('../backend/services/consultationOmiseWebhookService');
const {createConsultationPaymentStatusService}=require('../backend/services/consultationPaymentStatusService');

const SECRET=Buffer.from('omise-test-webhook-secret-32bytes!').toString('base64');
const CONFIG={testMode:true,publicKey:'pkey_test_phimor123',secretKey:'skey_test_phimor123',webhookSecret:SECRET,timeoutMs:15000,apiBaseUrl:'https://api.omise.co'};
const CHARGE={object:'charge',id:'chrg_test_phimor123',livemode:false,status:'pending',amount:10000,currency:'thb',metadata:{order_id:'ORDER-1'},expires_at:'2026-08-26T00:00:00Z',source:{type:'promptpay',scannable_code:{image:{download_uri:'https://cdn.omise.co/qr/test.png'}}}};
function response(data,status=200){return {ok:status>=200&&status<300,status,async json(){return structuredClone(data);}};}
function provider(fetchImpl=async()=>response(CHARGE)){return new OmisePaymentProvider({config:CONFIG,fetchImpl,now:()=>new Date('2026-08-25T00:00:00Z')});}

test('Omise test adapter creates exact 100 THB PromptPay checkout without network in tests',async()=>{
  let request;
  const result=await provider(async(url,options)=>{request={url,options};return response(CHARGE);}).createCheckout({orderId:'ORDER-1',amountMinor:10000,currency:'THB',durationMinutes:1440});
  assert.equal(request.url,'https://api.omise.co/charges');
  const form=new URLSearchParams(request.options.body);
  assert.equal(form.get('amount'),'10000');
  assert.equal(form.get('currency'),'thb');
  assert.equal(form.get('source[type]'),'promptpay');
  assert.equal(form.get('metadata[order_id]'),'ORDER-1');
  assert.deepEqual(result.paymentInstructions,{method:'promptpay',qrImageUrl:'https://cdn.omise.co/qr/test.png',expiresAt:'2026-08-26T00:00:00Z'});
});

test('Omise adapter fails closed for incomplete or live credentials',()=>{
  assert.throws(()=>new OmisePaymentProvider({config:{...CONFIG,secretKey:'skey_live_nope'},fetchImpl:async()=>{}}),/ระบบชำระเงิน/);
  assert.throws(()=>new OmisePaymentProvider({config:{...CONFIG,testMode:false},fetchImpl:async()=>{}}),/ระบบชำระเงิน/);
  assert.throws(()=>new OmisePaymentProvider({config:{...CONFIG,webhookSecret:''},fetchImpl:async()=>{}}),/ระบบชำระเงิน/);
});

test('Omise checkout rejects mismatched provider amount currency and order linkage',async()=>{
  for(const changed of [{amount:9999},{currency:'usd'},{metadata:{order_id:'OTHER'}}]){
    await assert.rejects(provider(async()=>response({...CHARGE,...changed})).createCheckout({orderId:'ORDER-1',amountMinor:10000,currency:'THB',durationMinutes:1440}),{code:'OMISE_CHECKOUT_MISMATCH'});
  }
});

test('Omise webhook validates HMAC raw body and independently retrieves charge',async()=>{
  const body=Buffer.from(JSON.stringify({id:'evnt_test_1',key:'charge.complete',livemode:false,data:{id:CHARGE.id,livemode:false}}));
  const timestamp='1787616000';
  const signature=crypto.createHmac('sha256',Buffer.from(SECRET,'base64')).update(`${timestamp}.${body}`).digest('hex');
  const p=new OmisePaymentProvider({config:CONFIG,fetchImpl:async()=>response({...CHARGE,status:'successful',paid_at:'2026-08-25T00:00:00Z'}),now:()=>new Date(Number(timestamp)*1000)});
  const verified=await p.verifyWebhook({rawBody:body,headers:{'omise-signature':`deadbeef,${signature}`,'omise-signature-timestamp':timestamp}});
  assert.equal(verified.providerPaymentId,CHARGE.id);
  const retrieved=await p.retrievePayment({providerPaymentId:CHARGE.id});
  assert.equal(retrieved.eventType,'payment_succeeded');
  assert.equal(retrieved.orderId,'ORDER-1');
});

test('invalid Omise signature is rejected before retrieval',async()=>{
  const body=Buffer.from('{}');
  await assert.rejects(provider().verifyWebhook({rawBody:body,headers:{'omise-signature':'00','omise-signature-timestamp':'1787616000'}}),{code:'OMISE_WEBHOOK_SIGNATURE_INVALID'});
});

test('webhook signature covers the exact raw body and rejects reserialized or mutated bytes',async()=>{
  const timestamp='1787616000';
  const rawBody=Buffer.from('{"id":"evnt_test_raw","key":"charge.complete","data":{"id":"chrg_test_phimor123"}}');
  const signature=crypto.createHmac('sha256',Buffer.from(SECRET,'base64')).update(`${timestamp}.${rawBody}`).digest('hex');
  const p=new OmisePaymentProvider({config:CONFIG,fetchImpl:async()=>response(CHARGE),now:()=>new Date(Number(timestamp)*1000)});
  await p.verifyWebhook({rawBody,headers:{'omise-signature':signature,'omise-signature-timestamp':timestamp}});
  const reserialized=Buffer.from(JSON.stringify(JSON.parse(rawBody.toString('utf8')),null,2));
  await assert.rejects(p.verifyWebhook({rawBody:reserialized,headers:{'omise-signature':signature,'omise-signature-timestamp':timestamp}}),{code:'OMISE_WEBHOOK_SIGNATURE_INVALID'});
});

test('webhook HMAC decodes the Base64 secret rather than using encoded text as the key',async()=>{
  const timestamp='1787616000',body=Buffer.from('{"id":"evnt_test_secret"}');
  const correct=crypto.createHmac('sha256',Buffer.from(SECRET,'base64')).update(`${timestamp}.${body}`).digest('hex');
  const encodedTextKey=crypto.createHmac('sha256',SECRET).update(`${timestamp}.${body}`).digest('hex');
  const p=new OmisePaymentProvider({config:CONFIG,fetchImpl:async()=>response(CHARGE),now:()=>new Date(Number(timestamp)*1000)});
  await p.verifyWebhook({rawBody:body,headers:{'omise-signature':correct,'omise-signature-timestamp':timestamp}});
  await assert.rejects(p.verifyWebhook({rawBody:body,headers:{'omise-signature':encodedTextKey,'omise-signature-timestamp':timestamp}}),{code:'OMISE_WEBHOOK_SIGNATURE_INVALID'});
});

test('webhook accepts a valid signature during rotation and rejects timestamps outside replay window',async()=>{
  const timestamp=1787616000,body=Buffer.from('{"id":"evnt_test_rotation"}');
  const signature=crypto.createHmac('sha256',Buffer.from(SECRET,'base64')).update(`${timestamp}.${body}`).digest('hex');
  const headers={'omise-signature':`${'0'.repeat(64)},${signature}`,'omise-signature-timestamp':String(timestamp)};
  await new OmisePaymentProvider({config:CONFIG,fetchImpl:async()=>response(CHARGE),now:()=>new Date(timestamp*1000+5*60*1000)}).verifyWebhook({rawBody:body,headers});
  for(const offset of [5*60*1000+1,-(5*60*1000+1)]){
    const p=new OmisePaymentProvider({config:CONFIG,fetchImpl:async()=>response(CHARGE),now:()=>new Date(timestamp*1000+offset)});
    await assert.rejects(p.verifyWebhook({rawBody:body,headers}),{code:'OMISE_WEBHOOK_TIMESTAMP_INVALID'});
  }
});

test('test webhook secret is environment-specific and cannot validate another environment signature',async()=>{
  const timestamp='1787616000',body=Buffer.from('{"id":"evnt_test_environment"}');
  const otherSecret=Buffer.from('different-environment-secret-32bytes').toString('base64');
  const otherSignature=crypto.createHmac('sha256',Buffer.from(otherSecret,'base64')).update(`${timestamp}.${body}`).digest('hex');
  const p=new OmisePaymentProvider({config:CONFIG,fetchImpl:async()=>response(CHARGE),now:()=>new Date(Number(timestamp)*1000)});
  await assert.rejects(p.verifyWebhook({rawBody:body,headers:{'omise-signature':otherSignature,'omise-signature-timestamp':timestamp}}),{code:'OMISE_WEBHOOK_SIGNATURE_INVALID'});
});

test('retrieved live charge is rejected even when webhook signature was valid',async()=>{
  await assert.rejects(provider(async()=>response({...CHARGE,status:'successful',livemode:true})).retrievePayment({providerPaymentId:CHARGE.id}),{code:'OMISE_LIVE_CHARGE_REJECTED'});
});

test('webhook success provisions only from independently retrieved successful charge',async()=>{
  const calls=[];
  const service=createConsultationOmiseWebhookService({provider:{async verifyWebhook(){return {providerEventId:'EV-1',eventKey:'charge.complete',providerPaymentId:'CH-1',payloadHash:'a'.repeat(64)};},async retrievePayment(){calls.push('retrieve');return {provider:'omise',providerPaymentId:'CH-1',providerCheckoutId:'CH-1',orderId:'ORDER-1',amountMinor:10000,currency:'THB',eventType:'payment_succeeded',paidAt:'2026-08-25T00:00:00Z'};}},ingestionService:{async ingestVerifiedEvent(event){calls.push(event);return {event,transaction:{}};},async processIngestedEvent(){return {status:'processed',consultationCase:{case_id:'CASE-1'}};}}});
  const result=await service.handle({rawBody:Buffer.from('{}'),headers:{}});
  assert.equal(result.caseId,'CASE-1');assert.equal(calls[0],'retrieve');assert.equal(calls[1].providerEventId,'EV-1');
});

test('retrieved pending or failed charge never provisions a queued case',async()=>{
  for(const eventType of ['payment_pending','payment_failed']){
    let processed;
    const service=createConsultationOmiseWebhookService({provider:{async verifyWebhook(){return {providerEventId:`EV-${eventType}`,eventKey:'charge.complete',providerPaymentId:'CH-1'};},async retrievePayment(){return {provider:'omise',providerPaymentId:'CH-1',providerCheckoutId:'CH-1',orderId:'ORDER-1',amountMinor:10000,currency:'THB',eventType};}},ingestionService:{async ingestVerifiedEvent(){processed='ingested';},async processIngestedEvent(){processed='processed';}}});
    const result=await service.handle({rawBody:Buffer.from('{}'),headers:{}});assert.equal(processed,undefined);assert.equal(result.caseId,undefined);assert.equal(result.status,'ignored');
  }
});

test('Family payment status exposes queued case only after paid provisioning',async()=>{
  const base={order_id:'ORDER-1',customer_line_user_id:'U-1',care_profile_id:'CP-1',amount_minor:10000,currency:'THB',payment_due_at:null};
  for(const scenario of [{order:{...base,status:'payment_pending',provisioning_status:'pending'},caseRow:null,expected:'payment_pending'},{order:{...base,status:'paid',provisioning_status:'pending'},caseRow:null,expected:'payment_confirming'},{order:{...base,status:'paid',provisioning_status:'provisioned'},caseRow:{case_id:'CASE-1'},expected:'queued'}]){
    const service=createConsultationPaymentStatusService({repository:{async findOrder(){return scenario.order;},async findCaseByOrderId(){return scenario.caseRow;}},authorize:async()=>({allowed:true})});
    const result=await service.getStatus({orderId:'ORDER-1',lineUserId:'U-1'});assert.equal(result.status,scenario.expected);assert.equal(result.caseId,scenario.expected==='queued'?'CASE-1':null);
  }
});

test('checkout route rejects client price/provider override and passes server-owned input',async()=>{
  const enabled={enabled:true,internalOnly:false,internalLineUserIds:[],termsVersion:'terms-1',priceMinor:10000,currency:'THB',durationMinutes:1440,rateLimits:{checkoutAttemptsPer10Minutes:3,messageSendsPerMinute:10,pharmacistAcceptsPerMinute:10,assistantRequestsPer10Minutes:5}};
  let seen;
  const app=express();app.use(express.json());app.use('/api/consultations',createConsultationsRouter({config:enabled,eligibilityService:{async checkEligibility(){return {availability:'eligible'};}},readService:{},messageService:{},rateLimitService:{requireCheckout(){}},paymentProvider:{createCheckout(){}},checkoutService:{async prepareCheckout(input){seen=input;return {orderId:'ORDER-1',status:'payment_pending',amountMinor:10000,currency:'THB',durationMinutes:1440,termsVersion:'terms-1',paymentInstructions:{method:'promptpay',qrImageUrl:'https://cdn.omise.co/qr.png'}};}},paymentStatusService:{}}));
  const server=http.createServer(app);await new Promise((resolve)=>server.listen(0,resolve));const url=`http://127.0.0.1:${server.address().port}`;
  try{
    const rejected=await fetch(`${url}/api/consultations/checkout`,{method:'POST',headers:{'Content-Type':'application/json','X-Line-User-Id':'U-1'},body:JSON.stringify({careProfileId:'CP-1',question:'กินยานี้ใช้ยังไง',termsAccepted:true,termsVersion:'terms-1',amount:1})});assert.equal(rejected.status,400);
    const accepted=await fetch(`${url}/api/consultations/checkout`,{method:'POST',headers:{'Content-Type':'application/json','X-Line-User-Id':'U-1'},body:JSON.stringify({careProfileId:'CP-1',question:'กินยาสองตัวนี้ด้วยกันได้ไหม',termsAccepted:true,termsVersion:'terms-1'})});assert.equal(accepted.status,201);const json=await accepted.json();assert.equal(json.amountMinor,10000);assert.equal(json.provider,undefined);assert.equal(seen.initialQuestion,'กินยาสองตัวนี้ด้วยกันได้ไหม');
  }finally{await new Promise((resolve)=>server.close(resolve));}
});

test('emergency checkout is blocked before provider or order creation',async()=>{
  let calls=0;const enabled={enabled:true,internalOnly:false,internalLineUserIds:[],termsVersion:'terms-1',rateLimits:{checkoutAttemptsPer10Minutes:3}};
  const app=express();app.use(express.json());app.use('/api/consultations',createConsultationsRouter({config:enabled,eligibilityService:{},readService:{},messageService:{},rateLimitService:{requireCheckout(){calls++;}},checkoutService:{async prepareCheckout(){calls++;}},paymentStatusService:{}}));
  const server=http.createServer(app);await new Promise((resolve)=>server.listen(0,resolve));
  try{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/consultations/checkout`,{method:'POST',headers:{'Content-Type':'application/json','X-Line-User-Id':'U-1'},body:JSON.stringify({careProfileId:'CP-1',question:'หายใจไม่ออก เจ็บหน้าอกมาก',termsAccepted:true,termsVersion:'terms-1'})});assert.equal(response.status,403);assert.equal(calls,0);}finally{await new Promise((resolve)=>server.close(resolve));}
});
