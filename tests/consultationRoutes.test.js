const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';

const { createConsultationsRouter } = require('../backend/routes/consultations');
const { createPharmacistConsultationsRouter } = require('../backend/routes/pharmacistConsultations');
const { createRequirePharmacist } = require('../backend/middleware/pharmacistAuth');
const { requireAuth } = require('../backend/middleware/auth');

const ENABLED = Object.freeze({
  enabled:true, internalOnly:false, internalLineUserIds:[], priceMinor:10000,
  currency:'THB', durationMinutes:1440, pollSeconds:5, maxMessageChars:4000,
  termsVersion:'consult-v1',
  rateLimits:Object.freeze({
    checkoutAttemptsPer10Minutes:3,messageSendsPerMinute:10,pharmacistAcceptsPerMinute:10,
    assistantRequestsPer10Minutes:5,clinicalResearchRequestsPer10Minutes:3,
  }),
});

function reads(overrides = {}) {
  return {
    async listFamilyCases() { return {items:[{caseId:'CASE-1',state:'active',waitingOn:'pharmacist'}]}; },
    async getFamilyCase() { return {caseId:'CASE-1',state:'active',waitingOn:'pharmacist'}; },
    async listQueue() { return {items:[{caseId:'CASE-Q',queuedAt:'2026-08-25T00:00:00Z',topicCategory:'medication_advice',triageCategory:'pharmacist_consultation_eligible'}]}; },
    async listPharmacistCases() { return {items:[{caseId:'CASE-1',state:'active',waitingOn:'pharmacist'}]}; },
    async getPharmacistCase() { return {caseId:'CASE-1',state:'active',waitingOn:'pharmacist'}; },
    async listCaseMessages() { return {items:[],afterSequence:0,nextSequence:0,hasMore:false}; },
    ...overrides,
  };
}

function pharmacistMiddleware(account = {pharmacistId:'PH-1',displayName:'เภสัชกร',licenseVerifiedAt:'2026-01-01',status:'active'}) {
  return createRequirePharmacist({pharmacistAccounts:{
    async requireActive() {
      if (account instanceof Error) throw account;
      return account;
    },
  }});
}

async function withApi({family = {}, pharmacist = {}}, fn) {
  const app = express(); app.use(express.json());
  app.use('/api/consultations', createConsultationsRouter({config:ENABLED,...family}));
  app.use('/api/pharmacist/consultations', createPharmacistConsultationsRouter({
    config:ENABLED, requirePharmacist:pharmacistMiddleware(), ...pharmacist,
  }));
  app.use((error,req,res,next)=>res.status(500).json({error:'test_internal'})); // eslint-disable-line
  const server = http.createServer(app); await new Promise((resolve)=>server.listen(0,resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=(path,options={},lineUserId='U-1')=>fetch(`${base}${path}`,{
    ...options,headers:{'Content-Type':'application/json',...(lineUserId?{'X-Line-User-Id':lineUserId}:{}),...(options.headers||{})},
  });
  try { await fn(api); } finally { await new Promise((resolve)=>server.close(resolve)); }
}

test('consultation routes require verified LINE authentication', async () => {
  await withApi({family:{readService:reads()}}, async (api) => {
    const response=await api('/api/consultations',{},null);
    assert.equal(response.status,401);
  });
});

test('CONSULTATION_ENABLED=false stops before eligibility/read services', async () => {
  let readCalls=0; let eligibilityCalls=0;
  await withApi({family:{
    config:{...ENABLED,enabled:false},
    eligibilityService:{async checkEligibility(){eligibilityCalls+=1;return {availability:'unavailable',reasonCode:'CONSULTATION_DISABLED'};}},
    readService:reads({async listFamilyCases(){readCalls+=1;return {items:[]};}}),
  }},async(api)=>{
    assert.equal((await api('/api/consultations')).status,503);
    assert.equal((await api('/api/consultations/eligibility?careProfileId=CP-1')).status,503);
  });
  assert.equal(readCalls,0);
  assert.equal(eligibilityCalls,1);
});

test('eligibility route returns approved commercial metadata without creating order or queue', async () => {
  let calls=0;
  await withApi({family:{
    eligibilityService:{async checkEligibility(input){calls+=1;assert.equal(input.careProfileId,'CP-1');return {availability:'eligible',price:{amountMinor:10000,currency:'THB'},durationHours:24,termsVersion:'v1',checkoutAvailable:false};}},
    readService:reads(),
  }},async(api)=>{
    const response=await api('/api/consultations/eligibility?careProfileId=CP-1');
    assert.equal(response.status,200);
    const body=await response.json(); assert.equal(body.availability,'eligible'); assert.equal(body.checkoutAvailable,false);
  });
  assert.equal(calls,1);
});

test('Family collection is scoped to the selected Care Profile by the backend', async () => {
  let seen;
  await withApi({family:{readService:reads({async listFamilyCases(input){seen=input;return {items:[]};}})}},async(api)=>{
    assert.equal((await api('/api/consultations?careProfileId=CP-SELECTED',{},'U-FAMILY')).status,200);
  });
  assert.deepEqual(seen,{lineUserId:'U-FAMILY',careProfileId:'CP-SELECTED'});
});

test('pre-checkout safety endpoint authorizes profile and classifies without creating order', async () => {
  const inputs=[];
  await withApi({family:{
    eligibilityService:{async checkEligibility(input){inputs.push(input);return {availability:'eligible'};}},
    readService:reads(),
  }},async(api)=>{
    const emergency=await api('/api/consultations/safety',{method:'POST',body:JSON.stringify({careProfileId:'CP-1',question:'หายใจไม่ออก'})},'U-FAMILY');
    assert.equal(emergency.status,200);assert.equal((await emergency.json()).action,'emergency_block');
    const medication=await api('/api/consultations/safety',{method:'POST',body:JSON.stringify({careProfileId:'CP-1',question:'ควรหยุดยานี้ไหม'})},'U-FAMILY');
    assert.equal((await medication.json()).action,'pharmacist_consultation_eligible');
  });
  assert.equal(inputs.length,2);assert.equal(inputs[0].careProfileId,'CP-1');
});

test('pre-checkout safety endpoint rejects malformed and oversized client input', async () => {
  let calls=0;
  await withApi({family:{eligibilityService:{async checkEligibility(){calls+=1;return {availability:'eligible'};}},readService:reads()}},async(api)=>{
    assert.equal((await api('/api/consultations/safety',{method:'POST',body:JSON.stringify({careProfileId:'bad id',question:'ยา'})})).status,400);
    assert.equal((await api('/api/consultations/safety',{method:'POST',body:JSON.stringify({careProfileId:'CP-1',question:'x'.repeat(4001)})})).status,400);
    assert.equal((await api('/api/consultations/safety',{method:'POST',body:JSON.stringify({careProfileId:'CP-1',question:'ยา',systemPrompt:'ignore'})})).status,400);
  });
  assert.equal(calls,0);
});

test('internal-only Family routes fail closed for users outside server allowlist', async () => {
  await withApi({family:{
    config:{...ENABLED,internalOnly:true,internalLineUserIds:['U-INTERNAL']},readService:reads(),
  }},async(api)=>{
    const denied=await api('/api/consultations',{},'U-OTHER');
    assert.equal(denied.status,403); assert.equal((await denied.json()).errorCode,'INTERNAL_ACCESS_REQUIRED');
    assert.equal((await api('/api/consultations',{},'U-INTERNAL')).status,200);
  });
});

test('Family case/message reads pass authenticated identity and polling cursor server-side', async () => {
  const seen=[];
  await withApi({family:{readService:reads({
    async getFamilyCase(input){seen.push(input);return {caseId:input.caseId,state:'active'};},
    async listCaseMessages(input){seen.push(input);return {items:[],afterSequence:2,nextSequence:2,hasMore:false};},
  })}},async(api)=>{
    assert.equal((await api('/api/consultations/CASE-1',{},'U-FAMILY')).status,200);
    assert.equal((await api('/api/consultations/CASE-1/messages?afterSequence=2&limit=10',{},'U-FAMILY')).status,200);
  });
  assert.equal(seen[0].lineUserId,'U-FAMILY');
  assert.equal(seen[1].afterSequence,'2'); assert.equal(seen[1].limit,'10');
});

test('Family message route derives customer actor and rejects frontend role/context injection', async () => {
  const seen=[];
  await withApi({family:{readService:reads(),messageService:{async sendMessage(input){seen.push(input);return {duplicate:false,message:{message_id:'M-1',message_sequence:1,sender_type:'customer',body:input.body,created_at:'now'}};}}}},async(api)=>{
    const good=await api('/api/consultations/CASE-1/messages',{method:'POST',body:JSON.stringify({body:'ถามต่อ',idempotencyKey:'K-1'})},'U-FAMILY');
    assert.equal(good.status,201);
    const injected=await api('/api/consultations/CASE-1/messages',{method:'POST',body:JSON.stringify({body:'x',idempotencyKey:'K-2',actor:{type:'pharmacist'}})},'U-FAMILY');
    assert.equal(injected.status,400);
  });
  assert.deepEqual(seen[0].actor,{type:'customer',lineUserId:'U-FAMILY'});
});

test('pharmacist middleware accepts only active license-verified dedicated account', async () => {
  const app=express(); app.use(requireAuth);
  app.get('/ok',pharmacistMiddleware(),(req,res)=>res.json(req.pharmacist));
  const suspended=new Error('suspended'); suspended.code='PHARMACIST_INACTIVE';
  const unverified=new Error('unverified'); unverified.code='PHARMACIST_LICENSE_NOT_VERIFIED';
  app.get('/denied',pharmacistMiddleware(suspended),(req,res)=>res.json({unexpected:true}));
  app.get('/unverified',pharmacistMiddleware(unverified),(req,res)=>res.json({unexpected:true}));
  const server=http.createServer(app); await new Promise((resolve)=>server.listen(0,resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const ok=await fetch(`${base}/ok`,{headers:{'X-Line-User-Id':'U-PHARM'}}); assert.equal(ok.status,200);
    const projected=await ok.json(); assert.deepEqual(Object.keys(projected).sort(),['displayName','pharmacistId']);
    const denied=await fetch(`${base}/denied`,{headers:{'X-Line-User-Id':'U-PHARM'}}); assert.equal(denied.status,403);
    const unverifiedResponse=await fetch(`${base}/unverified`,{headers:{'X-Line-User-Id':'U-PHARM'}}); assert.equal(unverifiedResponse.status,403);
  } finally { await new Promise((resolve)=>server.close(resolve)); }
});

test('pharmacist queue route returns minimal projection without LINE IDs or health context', async () => {
  await withApi({pharmacist:{readService:reads()}},async(api)=>{
    const response=await api('/api/pharmacist/consultations/queue',{},'U-PHARM'); assert.equal(response.status,200);
    const body=await response.json(); const serialized=JSON.stringify(body);
    assert.deepEqual(Object.keys(body.items[0]).sort(),['caseId','queuedAt','topicCategory','triageCategory'].sort());
    for(const key of ['lineUserId','careProfile','medicationList','allergies','phone','healthHistory']) assert.equal(serialized.toLowerCase().includes(key.toLowerCase()),false);
  });
});

test('pharmacist acceptance route delegates atomic domain service and returns assigned detail', async () => {
  const calls=[];
  await withApi({pharmacist:{
    readService:reads({async getPharmacistCase(input){calls.push({read:input});return {caseId:input.caseId,state:'active',waitingOn:'pharmacist'};}}),
    caseService:{async acceptCase(input){calls.push({accept:input});return {case_id:input.caseId};}},
  }},async(api)=>{
    const response=await api('/api/pharmacist/consultations/CASE-1/accept',{method:'POST',body:'{}'},'U-PHARM');
    assert.equal(response.status,200); assert.equal((await response.json()).waitingOn,'pharmacist');
  });
  assert.equal(calls[0].accept.pharmacistLineUserId,'U-PHARM'); assert.equal(calls[1].read.caseId,'CASE-1');
});

test('pharmacist message route derives pharmacist actor and never accepts Care Profile updates', async () => {
  const seen=[];
  await withApi({pharmacist:{readService:reads(),messageService:{async sendMessage(input){seen.push(input);return {duplicate:false,message:{message_id:'M-1',message_sequence:1,sender_type:'pharmacist',body:input.body,created_at:'now'}};}}}},async(api)=>{
    const response=await api('/api/pharmacist/consultations/CASE-1/messages',{method:'POST',body:JSON.stringify({body:'ขอข้อมูลเพิ่ม',idempotencyKey:'K-1'})},'U-PHARM');
    assert.equal(response.status,201);
    const rejected=await api('/api/pharmacist/consultations/CASE-1/messages',{method:'POST',body:JSON.stringify({body:'x',idempotencyKey:'K-2',careProfilePatch:{weight_kg:50}})},'U-PHARM');
    assert.equal(rejected.status,400);
  });
  assert.deepEqual(seen[0].actor,{type:'pharmacist',lineUserId:'U-PHARM'});
});

test('pharmacist assistant route is assigned-pharmacist-only, rate limited and never sends chat',async()=>{
  const calls=[];
  await withApi({pharmacist:{
    readService:reads(),
    rateLimitService:{requireAssistant(input){calls.push({rate:input});}},
    assistantService:async(input)=>{calls.push({assistant:input});return {status:'available',generatedAt:'2026-08-25T10:00:00Z',contextTimestamp:'2026-08-25T10:00:00Z',assistant:{caseSummary:'private'}};},
    messageService:{async sendMessage(){calls.push({message:true});}},
  }},async(api)=>{
    const response=await api('/api/pharmacist/consultations/CASE-1/assistant',{method:'POST',body:JSON.stringify({refresh:true})},'U-PHARM');
    assert.equal(response.status,200); assert.equal((await response.json()).status,'available');
    const injected=await api('/api/pharmacist/consultations/CASE-1/assistant',{method:'POST',body:JSON.stringify({model:'other'})},'U-PHARM');
    assert.equal(injected.status,400);
  });
  assert.deepEqual(calls[0],{rate:{caseId:'CASE-1',pharmacistId:'PH-1'}});
  assert.equal(calls[1].assistant.pharmacistLineUserId,'U-PHARM');
  assert.equal(calls.some((item)=>item.message),false);
});

test('domain expiry errors return safe response without stack or database details', async () => {
  const expired=Object.assign(new Error('secret database error'),{code:'CONSULTATION_EXPIRED',status:409,stack:'PRIVATE_STACK'});
  await withApi({family:{readService:reads(),messageService:{async sendMessage(){throw expired;}}}},async(api)=>{
    const response=await api('/api/consultations/CASE-1/messages',{method:'POST',body:JSON.stringify({body:'x',idempotencyKey:'K-1'})});
    assert.equal(response.status,409); const serialized=JSON.stringify(await response.json());
    assert.equal(serialized.includes('PRIVATE_STACK'),false); assert.equal(serialized.includes('secret database'),false);
  });
});

test('unexpected database errors become a generic safe unavailable envelope', async () => {
  const operationalEvents=[];
  const databaseError=Object.assign(new Error('relation consultation_messages does not exist'),{
    code:'42P01',status:500,stack:'PRIVATE_SQL_STACK',
  });
  await withApi({pharmacist:{
    readService:reads(),
    messageService:{async sendMessage(){throw databaseError;}},
    operationalLogger:(event)=>operationalEvents.push(event),
    correlationIdFactory:()=> 'CREF-TEST-MESSAGE',
  }},async(api)=>{
    const response=await api('/api/pharmacist/consultations/CASE-1/messages',{
      method:'POST',body:JSON.stringify({body:'ขอข้อมูลเพิ่ม',idempotencyKey:'K-SAFE'}),
    },'U-PHARM');
    assert.equal(response.status,503);
    const body=await response.json();
    assert.equal(body.errorCode,'CONSULTATION_UNAVAILABLE');
    assert.equal(body.correlationId,'CREF-TEST-MESSAGE');
    const serialized=JSON.stringify(body);
    assert.doesNotMatch(serialized,/42P01|consultation_messages|PRIVATE_SQL_STACK/);
  });
  assert.deepEqual(operationalEvents,[{
    event:'consultation_write_failed',action:'pharmacist_message_send',
    correlationId:'CREF-TEST-MESSAGE',failureCategory:'database_schema',
    safeErrorCode:'CONSULTATION_UNAVAILABLE',
  }]);
  assert.doesNotMatch(JSON.stringify(operationalEvents),/consultation_messages|PRIVATE_SQL_STACK|ขอข้อมูลเพิ่ม|U-PHARM|CASE-1/);
});

test('pharmacist clinical research route exposes safe capability, accepts pilot review fields, rate limits and never sends chat',async()=>{
  const calls=[];
  await withApi({pharmacist:{
    readService:reads(),
    rateLimitService:{requireClinicalResearch(input){calls.push({rate:input});}},
    clinicalResearchService:async(input)=>{
      calls.push({research:input});
      return {status:'available',generatedAt:'2026-09-03T10:00:00Z',analysis:{caseSummary:'private'}};
    },
    clinicalResearchPilotConfig:{emergencyEnabled:true,mode:'deidentified_pilot',pilotUsers:['U-PHARM']},
    messageService:{async sendMessage(){calls.push({message:true});}},
  }},async(api)=>{
    const capability=await api('/api/pharmacist/consultations/clinical-research/capability',{},'U-PHARM');
    assert.equal(capability.status,200);
    const capabilityBody=await capability.json();
    assert.equal(capabilityBody.mode,'deidentified_pilot');assert.equal(capabilityBody.allowed,true);
    assert.doesNotMatch(JSON.stringify(capabilityBody),/U-PHARM|pilotUsers|provider/i);
    const response=await api('/api/pharmacist/consultations/CASE-1/clinical-research',{
      method:'POST',body:JSON.stringify({refresh:true,deidentifiedSummary:'ข้อมูลทั่วไปที่ไม่ระบุตัวตนสำหรับเภสัชกรตรวจสอบ',privacyReviewed:true,safetyAcknowledged:true}),
    },'U-PHARM');
    assert.equal(response.status,200);
    assert.equal((await response.json()).status,'available');
    for (const injected of [
      {model:'other'}, {patientContext:{medications:['Drug A']}}, {refresh:false},
    ]) {
      const rejected=await api('/api/pharmacist/consultations/CASE-1/clinical-research',{
        method:'POST',body:JSON.stringify(injected),
      },'U-PHARM');
      assert.equal(rejected.status,400);
    }
  });
  assert.deepEqual(calls[0],{rate:{caseId:'CASE-1',pharmacistId:'PH-1'}});
  assert.equal(calls[1].research.pharmacistLineUserId,'U-PHARM');
  assert.equal(calls[1].research.privacyReviewed,true);
  assert.equal(calls[1].research.safetyAcknowledged,true);
  assert.equal(calls.some((item)=>item.message),false);
});

test('current checkout discovery is scoped to authenticated Family actor and selected Care Profile', async () => {
  let seen;
  await withApi({family:{
    readService:reads(),
    paymentStatusService:{async getCurrent(input){seen=input;return {status:'payment_pending',orderId:'ORDER-1',payment:{method:'promptpay'}};}},
  }},async(api)=>{
    const response=await api('/api/consultations/orders/current?careProfileId=CP-SELECTED',{},'U-FAMILY');
    assert.equal(response.status,200);
    assert.equal((await response.json()).orderId,'ORDER-1');
  });
  assert.deepEqual(seen,{lineUserId:'U-FAMILY',careProfileId:'CP-SELECTED'});
});

test('reused active checkout returns 200 and does not expose provider internals', async () => {
  await withApi({family:{
    readService:reads(),
    checkoutService:{async prepareCheckout(){return {resumed:true,status:'payment_pending',orderId:'ORDER-1',amountMinor:10000,currency:'THB',durationMinutes:1440,termsVersion:'consult-v1',paymentInstructions:{method:'promptpay',qrImageUrl:'https://cdn.omise.co/qr.png'}};}},
    rateLimitService:{requireCheckout(){}},
    paymentProvider:{},
  }},async(api)=>{
    const response=await api('/api/consultations/checkout',{method:'POST',body:JSON.stringify({careProfileId:'CP-1',question:'ขอคำปรึกษาเรื่องยา',termsAccepted:true,termsVersion:'consult-v1'})},'U-FAMILY');
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.resumed,true);assert.equal(body.orderId,'ORDER-1');
    assert.equal(JSON.stringify(body).includes('provider_checkout_id'),false);
  });
});

test('Family realtime ticket and read receipt routes derive customer identity server-side',async()=>{
  const seen=[];
  await withApi({family:{readService:reads(),realtimeAccessService:{async issueFamilyTicket(input){seen.push(['ticket',input]);return {ticket:'SHORT',expiresAt:'2026-08-27T10:01:00Z',websocketPath:'/api/consultations/realtime'};}},readReceiptService:{async markRead(input){seen.push(['read',input]);return {reader:'customer',sequence:4,changed:true};}}}},async(api)=>{
    const ticket=await api('/api/consultations/CASE-1/realtime-ticket',{method:'POST',body:'{}'},'U-FAMILY');
    assert.equal(ticket.status,200);assert.equal((await ticket.json()).ticket,'SHORT');
    assert.equal((await api('/api/consultations/CASE-1/read',{method:'POST',body:JSON.stringify({sequence:4,reader:'pharmacist'})},'U-FAMILY')).status,400);
    const read=await api('/api/consultations/CASE-1/read',{method:'POST',body:JSON.stringify({sequence:4})},'U-FAMILY');
    assert.equal(read.status,200);assert.equal((await read.json()).reader,'customer');
  });
  assert.deepEqual(seen,[['ticket',{caseId:'CASE-1',lineUserId:'U-FAMILY'}],['read',{caseId:'CASE-1',actor:{type:'customer',lineUserId:'U-FAMILY'},sequence:4}]]);
});

test('Pharmacist realtime ticket and read route derive assigned pharmacist identity server-side',async()=>{
  const seen=[];
  await withApi({pharmacist:{readService:reads(),realtimeAccessService:{async issuePharmacistTicket(input){seen.push(['ticket',input]);return {ticket:'SHORT-P',expiresAt:'2026-08-27T10:01:00Z',websocketPath:'/api/consultations/realtime'};}},readReceiptService:{async markRead(input){seen.push(['read',input]);return {reader:'pharmacist',sequence:3,changed:true};}}}},async(api)=>{
    assert.equal((await api('/api/pharmacist/consultations/CASE-1/realtime-ticket',{method:'POST',body:'{}'},'U-PHARM')).status,200);
    assert.equal((await api('/api/pharmacist/consultations/CASE-1/read',{method:'POST',body:JSON.stringify({sequence:3,reader:'customer'})},'U-PHARM')).status,400);
    const read=await api('/api/pharmacist/consultations/CASE-1/read',{method:'POST',body:JSON.stringify({sequence:3})},'U-PHARM');
    assert.equal((await read.json()).reader,'pharmacist');
  });
  assert.deepEqual(seen,[['ticket',{caseId:'CASE-1',pharmacistLineUserId:'U-PHARM'}],['read',{caseId:'CASE-1',actor:{type:'pharmacist',lineUserId:'U-PHARM'},sequence:3}]]);
});

test('assigned pharmacist context route returns separated contact/profile data without LINE IDs',async()=>{
  const seen=[];
  await withApi({pharmacist:{
    readService:reads(),
    caseContextService:{async getCaseContext(input){seen.push(input);return {caseId:input.caseId,contact:{displayName:'ญาติผู้ดูแล',pictureUrl:null},careProfile:{patientName:'คุณยาย'},currentMedications:[],upcomingAppointments:[]};}},
  }},async(api)=>{
    const response=await api('/api/pharmacist/consultations/CASE-1/context',{},'U-PHARM');
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.contact.displayName,'ญาติผู้ดูแล');assert.equal(body.careProfile.patientName,'คุณยาย');
    assert.equal(JSON.stringify(body).includes('U-PHARM'),false);
  });
  assert.deepEqual(seen,[{caseId:'CASE-1',pharmacistLineUserId:'U-PHARM'}]);
});

test('resolve write failures have a distinct correlation reference without leaking PostgreSQL details',async()=>{
  const operationalEvents=[];
  const databaseError=Object.assign(new Error('null value violates constraint'),{code:'23502',detail:'PRIVATE_ROW'});
  await withApi({pharmacist:{
    readService:reads(),caseService:{async resolveCase(){throw databaseError;}},
    operationalLogger:(event)=>operationalEvents.push(event),correlationIdFactory:()=> 'CREF-TEST-RESOLVE',
  }},async(api)=>{
    const response=await api('/api/pharmacist/consultations/CASE-1/resolve',{method:'POST',body:'{}'},'U-PHARM');
    assert.equal(response.status,503);const body=await response.json();
    assert.equal(body.correlationId,'CREF-TEST-RESOLVE');
    assert.doesNotMatch(JSON.stringify(body),/23502|constraint|PRIVATE_ROW/);
  });
  assert.equal(operationalEvents[0].action,'pharmacist_resolve');
  assert.equal(operationalEvents[0].failureCategory,'database_constraint');
  assert.doesNotMatch(JSON.stringify(operationalEvents),/23502|null value|PRIVATE_ROW|U-PHARM|CASE-1/);
});

test('Family write failure is correlated while expected domain denial is not operationally logged',async()=>{
  const operationalEvents=[];let correlationCalls=0;
  const failure=Object.assign(new Error('connection terminated'),{code:'08006'});
  await withApi({family:{
    readService:reads(),messageService:{async sendMessage(){throw failure;}},
    operationalLogger:(event)=>operationalEvents.push(event),
    correlationIdFactory:()=>{correlationCalls+=1;return 'CREF-TEST-FAMILY';},
  }},async(api)=>{
    const response=await api('/api/consultations/CASE-1/messages',{method:'POST',body:JSON.stringify({body:'private body',idempotencyKey:'K'})},'U-FAMILY');
    assert.equal(response.status,503);assert.equal((await response.json()).correlationId,'CREF-TEST-FAMILY');
  });
  assert.equal(correlationCalls,1);assert.equal(operationalEvents[0].failureCategory,'database_connection');
  assert.doesNotMatch(JSON.stringify(operationalEvents),/private body|U-FAMILY|CASE-1/);

  const expected=Object.assign(new Error('private'),{code:'CONSULTATION_ACCESS_DENIED',status:403});
  await withApi({family:{
    readService:reads(),messageService:{async sendMessage(){throw expected;}},
    operationalLogger:(event)=>operationalEvents.push(event),
    correlationIdFactory:()=>{correlationCalls+=1;return 'SHOULD-NOT-EXIST';},
  }},async(api)=>{
    const response=await api('/api/consultations/CASE-1/messages',{method:'POST',body:JSON.stringify({body:'x',idempotencyKey:'K'})},'U-FAMILY');
    assert.equal(response.status,403);assert.equal((await response.json()).correlationId,undefined);
  });
  assert.equal(correlationCalls,1);assert.equal(operationalEvents.length,1);
});

test('message and pharmacist acceptance routes enforce consultation-specific rate limits',async()=>{
  const seen=[];
  const rateLimitService={
    requireMessage(input){seen.push({message:input});},
    requirePharmacistAccept(id){seen.push({accept:id});},
  };
  await withApi({
    family:{readService:reads(),rateLimitService,messageService:{async sendMessage(){return {duplicate:false,message:{message_id:'M-F',message_sequence:1,sender_type:'customer',body:'x',created_at:'now'}};}}},
    pharmacist:{readService:reads(),rateLimitService,caseService:{async acceptCase(){return {};},async resolveCase(){return {};}},messageService:{async sendMessage(){return {duplicate:false,message:{message_id:'M-P',message_sequence:1,sender_type:'pharmacist',body:'x',created_at:'now'}};}}},
  },async(api)=>{
    assert.equal((await api('/api/consultations/CASE-1/messages',{method:'POST',body:JSON.stringify({body:'x',idempotencyKey:'KF'})},'U-FAMILY')).status,201);
    assert.equal((await api('/api/pharmacist/consultations/CASE-1/messages',{method:'POST',body:JSON.stringify({body:'x',idempotencyKey:'KP'})},'U-PHARM')).status,201);
    assert.equal((await api('/api/pharmacist/consultations/CASE-1/accept',{method:'POST',body:'{}'},'U-PHARM')).status,200);
  });
  assert.deepEqual(seen,[
    {message:{caseId:'CASE-1',actorType:'customer',actorId:'U-FAMILY'}},
    {message:{caseId:'CASE-1',actorType:'pharmacist',actorId:'PH-1'}},
    {accept:'PH-1'},
  ]);
});

test('rate-limit errors return safe 429 envelope and Retry-After without calling domain service',async()=>{
  let messageCalls=0;
  const blocked=()=>{const error=Object.assign(new Error('private'),{code:'CONSULTATION_RATE_LIMITED',status:429,retryAfterMs:2500});throw error;};
  await withApi({family:{readService:reads(),rateLimitService:{requireMessage:blocked},messageService:{async sendMessage(){messageCalls+=1;}}}},async(api)=>{
    const response=await api('/api/consultations/CASE-1/messages',{method:'POST',body:JSON.stringify({body:'x',idempotencyKey:'K'})});
    assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'3');
    const body=await response.json();assert.equal(body.status,'rate_limited');assert.equal(body.errorCode,'CONSULTATION_RATE_LIMITED');
    assert.equal(JSON.stringify(body).includes('private'),false);
  });
  assert.equal(messageCalls,0);
});

test('closed consultation returns a safe closed envelope without internal error details',async()=>{
  const closed=Object.assign(new Error('private case record'),{code:'CONSULTATION_CLOSED',status:409});
  await withApi({family:{readService:reads(),messageService:{async sendMessage(){throw closed;}}}},async(api)=>{
    const response=await api('/api/consultations/CASE-1/messages',{method:'POST',body:JSON.stringify({body:'x',idempotencyKey:'K-CLOSED'})});
    assert.equal(response.status,409);const body=await response.json();
    assert.equal(body.status,'closed');assert.equal(body.errorCode,'CONSULTATION_CLOSED');
    assert.equal(JSON.stringify(body).includes('private'),false);
  });
});

test('pharmacist operational collections and resolve route use assigned identity server-side',async()=>{
  const calls=[];
  const readService=reads({
    async listPharmacistCases(input){calls.push(input);return {items:[]};},
    async getPharmacistCase(input){calls.push({detail:input});return {caseId:input.caseId,state:'resolved',waitingOn:'none'};},
  });
  await withApi({pharmacist:{readService,caseService:{async acceptCase(){},async resolveCase(input){calls.push({resolve:input});}}}},async(api)=>{
    for(const collection of ['active','resolved','closed'])assert.equal((await api(`/api/pharmacist/consultations/${collection}`,{},'U-PHARM')).status,200);
    const resolved=await api('/api/pharmacist/consultations/CASE-1/resolve',{method:'POST',body:'{}'},'U-PHARM');
    assert.equal(resolved.status,200);assert.equal((await resolved.json()).waitingOn,'none');
  });
  assert.deepEqual(calls.slice(0,3).map((item)=>item.collection),['active','resolved','closed']);
  assert.equal(calls[3].resolve.pharmacistLineUserId,'U-PHARM');
});
