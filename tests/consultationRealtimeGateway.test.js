process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {WebSocket}=require('../backend/node_modules/ws');
const {
  createConsultationRealtimeGateway,allowedOrigin,secureWebSocketRequest,
}=require('../backend/realtime/consultationRealtimeGateway');

function waitForMessage(ws,predicate,timeoutMs=2000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('message timeout')),timeoutMs);const listener=(data)=>{let value;try{value=JSON.parse(String(data));}catch(_){return;}if(!predicate(value))return;clearTimeout(timer);ws.off('message',listener);resolve(value);};ws.on('message',listener);});}
function waitForClose(ws,timeoutMs=2000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('close timeout')),timeoutMs);ws.once('close',(code,reason)=>{clearTimeout(timer);resolve({code,reason:String(reason)});});});}
function domainError(code,status=403){const error=new Error(code);error.code=code;error.status=status;return error;}

function caseRow(overrides={}){return {case_id:'CASE-1',care_profile_id:'CP-1',customer_line_user_id:'U-CUSTOMER',state:'active',waiting_on:'customer',order_status:'paid',provisioning_status:'provisioned',assigned_pharmacist_id:'PHARM-1',accepted_at:'2026-08-27T09:00:00Z',expires_at:'2026-08-28T09:00:00Z',database_now:'2026-08-27T10:00:00Z',customer_last_read_sequence:0,pharmacist_last_read_sequence:0,last_message_sequence:1,...overrides};}

function createAccessHarness({role='customer'}={}){
  const consumed=new Set();const state={familyAllowed:true,pharmacistActive:true,assigned:true,closed:false};
  const authorization=(ticketOrPayload)=>{
    const ticket=typeof ticketOrPayload==='string'?ticketOrPayload:ticketOrPayload?.ticketId;
    if(!ticket)throw domainError('REALTIME_TICKET_INVALID',401);
    if(role==='customer'&&!state.familyAllowed)throw domainError('CARE_PROFILE_ACCESS_DENIED');
    if(role==='pharmacist'&&!state.pharmacistActive)throw domainError('PHARMACIST_INACTIVE');
    if(role==='pharmacist'&&!state.assigned)throw domainError('CONSULTATION_ACCESS_DENIED');
    if(state.closed)throw domainError('CONSULTATION_CLOSED',409);
    const row=caseRow({assigned_pharmacist_id:state.assigned?'PHARM-1':'PHARM-2'});
    return {payload:{version:1,ticketId:ticket,caseId:'CASE-1',role,actorRef:`ACTOR-${role}`},row,role};
  };
  return {state,access:{
    consumeTicket:async(ticket)=>{const result=authorization(ticket);if(consumed.has(ticket))throw domainError('REALTIME_TICKET_REPLAYED',401);consumed.add(ticket);return result;},
    authorizeTicket:async(payload)=>authorization(payload),
  }};
}

async function createServerHarness({access,env={NODE_ENV:'test',ALLOWED_ORIGINS:'https://family.test,https://pharmacist.test'},configOverrides={},logger={info:()=>{},warn:()=>{}}}={}){
  let subscriber=()=>{},statusSubscriber=()=>{};
  const bus={subscribe:(fn)=>{subscriber=fn;return()=>{};},subscribeStatus:(fn)=>{statusSubscriber=fn;return()=>{};},start:async()=>({available:true}),stop:async()=>{},health:()=>({started:true,available:true})};
  const repository={findMessageBySequence:async()=>({message_id:'M-1',case_id:'CASE-1',message_sequence:1,sender_type:'pharmacist',sender_id:'PH-1',body:'ตอบจากฐานข้อมูล',created_at:'2026-08-27T10:00:00Z'})};
  const config={configured:true,websocketPath:'/api/consultations/realtime',heartbeatSeconds:60,authenticationTimeoutMs:100,maxPayloadBytes:2048,maxConnections:20,maxConnectionsPerActor:3,...configOverrides};
  const gateway=createConsultationRealtimeGateway({repository,access,bus,config,env,logger});
  const server=http.createServer((_req,res)=>res.end('REST still works'));gateway.attach(server);await gateway.start();await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  return {gateway,server,port:server.address().port,signal:(value)=>subscriber(value),recoverBus:()=>statusSubscriber({status:'recovered'}),async close(){await gateway.stop();await new Promise((resolve)=>server.close(resolve));}};
}

async function openAuthenticated(port,{ticket='TICKET-1',origin='https://family.test',extraHeaders={}}={}){
  const ws=new WebSocket(`ws://127.0.0.1:${port}/api/consultations/realtime`,{headers:{Origin:origin,...extraHeaders}});
  await once(ws,'open');const readyPromise=waitForMessage(ws,(event)=>event.type==='connection.ready');
  ws.send(JSON.stringify({type:'authenticate',ticket}));
  return {ws,ready:await readyPromise};
}

test('gateway authenticates by first frame, keeps ticket out of URL, and projects safe database events',async()=>{
  const harness=createAccessHarness();const runtime=await createServerHarness({access:harness.access});
  const {ws,ready}=await openAuthenticated(runtime.port);
  try{
    assert.equal(ws.url.includes('?'),false);assert.equal(ready.caseId,'CASE-1');assert.equal(ready.case.state,'active');assert.doesNotMatch(JSON.stringify(ready),/customer_line_user_id|body|PH-1|TICKET-1/);
    const messagePromise=waitForMessage(ws,(event)=>event.type==='message.created');runtime.signal({eventType:'message.created',caseId:'CASE-1',sequence:1});const message=await messagePromise;
    assert.deepEqual(message.message,{messageId:'M-1',sequence:1,senderType:'pharmacist',body:'ตอบจากฐานข้อมูล',createdAt:'2026-08-27T10:00:00Z'});
    const recovery=waitForMessage(ws,(event)=>event.type==='recovery.required');runtime.recoverBus();assert.equal((await recovery).caseId,'CASE-1');
  }finally{ws.close();await runtime.close();}
});

test('Origin allowlist is exact for Family and Pharmacist, fails closed, and local origins are development-only',()=>{
  const production={NODE_ENV:'production',ALLOWED_ORIGINS:'https://family.example,https://pharmacist.example'};
  assert.equal(allowedOrigin('https://family.example',production),true);
  assert.equal(allowedOrigin('https://pharmacist.example',production),true);
  assert.equal(allowedOrigin('https://family.example.evil.test',production),false);
  assert.equal(allowedOrigin('https://family.example/path',production),false);
  assert.equal(allowedOrigin('',production),false);
  assert.equal(allowedOrigin('http://127.0.0.1:41755',{NODE_ENV:'test'}),true);
  assert.equal(allowedOrigin('http://127.0.0.1:41755',{NODE_ENV:'production'}),false);
});

test('production WebSocket requires TLS or exact trusted HTTPS proxy protocol',()=>{
  assert.equal(secureWebSocketRequest({socket:{encrypted:true},headers:{}},{NODE_ENV:'production'}),true);
  assert.equal(secureWebSocketRequest({socket:{encrypted:false},headers:{'x-forwarded-proto':'https'}},{NODE_ENV:'production'}),true);
  assert.equal(secureWebSocketRequest({socket:{encrypted:false},headers:{'x-forwarded-proto':'http'}},{NODE_ENV:'production'}),false);
  assert.equal(secureWebSocketRequest({socket:{encrypted:false},headers:{}},{NODE_ENV:'production'}),false);
  assert.equal(secureWebSocketRequest({socket:{},headers:{}},{NODE_ENV:'test'}),true);
});

test('malicious or missing Origin is rejected by the actual handshake',async()=>{
  const harness=createAccessHarness();const runtime=await createServerHarness({access:harness.access});
  try{
    for(const headers of [{Origin:'https://evil.test'},{}]){
      const status=await new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${runtime.port}/api/consultations/realtime`,{headers});ws.on('unexpected-response',(_request,response)=>resolve(response.statusCode));ws.on('error',()=>{});setTimeout(()=>reject(new Error('upgrade timeout')),1000);});
      assert.equal(status,403);
    }
  }finally{await runtime.close();}
});

test('ticket is single-use and replay cannot establish a second authenticated socket',async()=>{
  const harness=createAccessHarness();const runtime=await createServerHarness({access:harness.access});
  const first=await openAuthenticated(runtime.port,{ticket:'ONE-TIME'});
  const second=new WebSocket(`ws://127.0.0.1:${runtime.port}/api/consultations/realtime`,{headers:{Origin:'https://family.test'}});await once(second,'open');const closed=waitForClose(second);second.send(JSON.stringify({type:'authenticate',ticket:'ONE-TIME'}));
  try{assert.equal((await closed).code,1008);assert.equal(runtime.gateway.health().authenticatedConnections,1);}finally{first.ws.close();second.close();await runtime.close();}
});

test('query-string ticket is rejected and ticket material never appears in operational logs',async()=>{
  const logs=[];const harness=createAccessHarness();const runtime=await createServerHarness({access:harness.access,logger:{info:(entry)=>logs.push(entry),warn:(entry)=>logs.push(entry)}});
  try{
    const status=await new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${runtime.port}/api/consultations/realtime?ticket=PRIVATE-BEARER`,{headers:{Origin:'https://family.test'}});ws.on('unexpected-response',(_request,response)=>resolve(response.statusCode));ws.on('error',()=>{});setTimeout(()=>reject(new Error('upgrade timeout')),1000);});
    assert.equal(status,400);assert.doesNotMatch(JSON.stringify(logs),/PRIVATE-BEARER|ticket=/);
  }finally{await runtime.close();}
});

test('unauthenticated, malformed, oversized and post-auth application frames fail closed',async()=>{
  const harness=createAccessHarness();const runtime=await createServerHarness({access:harness.access,configOverrides:{authenticationTimeoutMs:30,maxPayloadBytes:256}});
  try{
    const idle=new WebSocket(`ws://127.0.0.1:${runtime.port}/api/consultations/realtime`,{headers:{Origin:'https://family.test'}});await once(idle,'open');assert.equal((await waitForClose(idle)).code,1008);
    const malformed=new WebSocket(`ws://127.0.0.1:${runtime.port}/api/consultations/realtime`,{headers:{Origin:'https://family.test'}});await once(malformed,'open');const malformedClose=waitForClose(malformed);malformed.send('{bad json');assert.equal((await malformedClose).code,1008);
    const oversized=new WebSocket(`ws://127.0.0.1:${runtime.port}/api/consultations/realtime`,{headers:{Origin:'https://family.test'}});await once(oversized,'open');const oversizedClose=waitForClose(oversized);oversized.send(Buffer.alloc(512));assert.equal((await oversizedClose).code,1009);
    const authenticated=await openAuthenticated(runtime.port,{ticket:'AUTHENTICATED'});const postAuthClose=waitForClose(authenticated.ws);authenticated.ws.send(JSON.stringify({type:'message.created',body:'must use REST'}));assert.equal((await postAuthClose).code,1008);
  }finally{await runtime.close();}
});

test('authenticated connections are bounded per actor without trusting client-provided identity',async()=>{
  const harness=createAccessHarness();const runtime=await createServerHarness({access:harness.access,configOverrides:{maxConnectionsPerActor:3}});const opened=[];
  try{
    for(let index=1;index<=3;index+=1)opened.push(await openAuthenticated(runtime.port,{ticket:`ACTOR-TICKET-${index}`}));
    const fourth=new WebSocket(`ws://127.0.0.1:${runtime.port}/api/consultations/realtime`,{headers:{Origin:'https://family.test'}});await once(fourth,'open');const closed=waitForClose(fourth);fourth.send(JSON.stringify({type:'authenticate',ticket:'ACTOR-TICKET-4'}));assert.equal((await closed).code,1008);
    assert.equal(runtime.gateway.health().authenticatedConnections,3);
  }finally{opened.forEach(({ws})=>ws.close());await runtime.close();}
});

for(const scenario of [
  {name:'revoked Family access',role:'customer',mutate:(state)=>{state.familyAllowed=false;}},
  {name:'inactive Pharmacist account',role:'pharmacist',mutate:(state)=>{state.pharmacistActive=false;},origin:'https://pharmacist.test'},
  {name:'closed or expired case',role:'customer',mutate:(state)=>{state.closed=true;}},
])test(`heartbeat closes an existing socket after ${scenario.name}`,async()=>{
  const harness=createAccessHarness({role:scenario.role});const runtime=await createServerHarness({access:harness.access});const opened=await openAuthenticated(runtime.port,{ticket:`TICKET-${scenario.role}-${scenario.name}`,origin:scenario.origin||'https://family.test'});
  try{scenario.mutate(harness.state);const closed=waitForClose(opened.ws);await runtime.gateway.reauthorizeAndHeartbeat();assert.equal((await closed).code,1008);}finally{opened.ws.close();await runtime.close();}
});
