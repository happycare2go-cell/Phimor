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
  rateLimits:Object.freeze({checkoutAttemptsPer10Minutes:3,messageSendsPerMinute:10,pharmacistAcceptsPerMinute:10}),
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

test('domain expiry errors return safe response without stack or database details', async () => {
  const expired=Object.assign(new Error('secret database error'),{code:'CONSULTATION_EXPIRED',status:409,stack:'PRIVATE_STACK'});
  await withApi({family:{readService:reads(),messageService:{async sendMessage(){throw expired;}}}},async(api)=>{
    const response=await api('/api/consultations/CASE-1/messages',{method:'POST',body:JSON.stringify({body:'x',idempotencyKey:'K-1'})});
    assert.equal(response.status,409); const serialized=JSON.stringify(await response.json());
    assert.equal(serialized.includes('PRIVATE_STACK'),false); assert.equal(serialized.includes('secret database'),false);
  });
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
