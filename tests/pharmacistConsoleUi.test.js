const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const consoleUI=require('../liff-app/pharmacist/console');
const html=fs.readFileSync(path.join(__dirname,'..','liff-app','pharmacist','index.html'),'utf8');
const source=fs.readFileSync(path.join(__dirname,'..','liff-app','pharmacist','console.js'),'utf8');

const OPEN_CASE={caseId:'CASE-1',state:'active',waitingOn:'pharmacist',acceptedAt:'2026-08-25T00:00:00Z',expiresAt:'2026-08-26T00:00:00Z',remainingSeconds:3600,effectiveClosed:false};
const RESOLVED_CASE={...OPEN_CASE,state:'resolved',waitingOn:'none'};
const CLOSED_CASE={...OPEN_CASE,state:'closed',waitingOn:'none',remainingSeconds:0,effectiveClosed:true,closeReason:'expired'};
const QUEUE_ITEM={caseId:'CASE-Q',queuedAt:'2026-08-25T00:00:00Z',topicCategory:'medication_advice',triageCategory:'pharmacist_consultation_eligible',waitingSeconds:300};

function createHarness(handler){
  const calls=[];const scheduled=[];
  const request=async(pathValue,options={})=>{calls.push({path:pathValue,options});return handler(pathValue,options,calls.length);};
  let lastState;
  const session=consoleUI.createConsoleSession({request,onChange:(state)=>{lastState=state;},schedule:(callback,ms)=>{scheduled.push({callback,ms});return scheduled.length;},cancelSchedule:()=>{},cryptoApi:{randomUUID:()=> 'IDEMPOTENCY-1'}});
  return {session,calls,scheduled,state:()=>lastState||session.snapshot()};
}

function standardHandler(pathValue){
  if(pathValue==='/api/pharmacist/consultations/queue')return {items:[QUEUE_ITEM],nextCursor:'CURSOR-1',hasMore:true};
  if(pathValue==='/api/pharmacist/consultations/active')return {items:[OPEN_CASE]};
  if(pathValue==='/api/pharmacist/consultations/resolved')return {items:[RESOLVED_CASE]};
  if(pathValue==='/api/pharmacist/consultations/closed')return {items:[CLOSED_CASE]};
  if(pathValue==='/api/pharmacist/consultations/CASE-1')return OPEN_CASE;
  if(pathValue.includes('/CASE-1/messages?'))return {items:[],nextSequence:0,hasMore:false};
  throw Object.assign(new Error(pathValue),{errorCode:'UNMOCKED'});
}

class FakeElement{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.textContent='';this.className='';this.hidden=false;this.disabled=false;this.listeners={};this.dataset={};}
  get firstChild(){return this.children[0]||null;}appendChild(child){this.children.push(child);return child;}removeChild(child){this.children.splice(this.children.indexOf(child),1);return child;}
  addEventListener(name,fn){this.listeners[name]=fn;}set innerHTML(_){throw new Error('innerHTML forbidden');}
}
const fakeDocument=()=>({createElement:(tag)=>new FakeElement(tag)});

test('pharmacist access denied is a safe backend-authoritative state',async()=>{
  const denied=Object.assign(new Error('private'),{errorCode:'PHARMACIST_LICENSE_NOT_VERIFIED'});
  const {session,state}=createHarness(async()=>{throw denied;});await session.initialize();
  assert.equal(state().access,'denied');assert.equal(JSON.stringify(state()).includes('private'),false);
});

test('active verified pharmacist loads queue and assigned active collection',async()=>{
  const {session,state,calls}=createHarness(standardHandler);await session.initialize();
  assert.equal(state().access,'allowed');assert.equal(state().collections.queue[0].caseId,'CASE-Q');
  assert.equal(state().collections.active[0].caseId,'CASE-1');assert.equal(calls.length,2);
});

test('queue renderer exposes only approved minimal metadata',()=>{
  const doc=fakeDocument();const container=new FakeElement();consoleUI.renderQueue(doc,container,[{...QUEUE_ITEM,careProfileId:'CP-SECRET',lineUserId:'U-SECRET',allergies:'secret'}],{showAccept:true});
  const visible=container.children[0].children.map((item)=>item.textContent).join('|');
  assert.match(visible,/CASE-Q|medication_advice|pharmacist_consultation_eligible/);
  assert.doesNotMatch(visible,/CP-SECRET|U-SECRET|allergies|secret/);
});

test('accept case is double-click protected and CASE_ALREADY_ACCEPTED stays safe',async()=>{
  let release;const pending=new Promise((resolve)=>{release=resolve;});
  const harness=createHarness(async(pathValue)=>{
    if(pathValue.endsWith('/accept'))return pending;
    return standardHandler(pathValue);
  });
  const first=harness.session.acceptCase('CASE-Q');const second=await harness.session.acceptCase('CASE-Q');
  assert.deepEqual(second,{ignored:true});release({...OPEN_CASE,caseId:'CASE-Q'});await first;
  assert.equal(harness.calls.filter((item)=>item.path.endsWith('/accept')).length,1);
  const conflict=createHarness(async()=>{throw Object.assign(new Error('db'),{errorCode:'CASE_ALREADY_ACCEPTED'});});
  const result=await conflict.session.acceptCase('CASE-Q');assert.equal(result.error,'CASE_ALREADY_ACCEPTED');assert.doesNotMatch(conflict.state().statusMessage,/db/);
});

test('active resolved and closed tabs use separate backend collections',async()=>{
  const {session,state}=createHarness(standardHandler);
  for(const tab of ['active','resolved','closed']){await session.switchTab(tab);assert.equal(state().tab,tab);assert.equal(state().collections[tab][0].state,tab);}
});

test('countdown and closed state rendering are deterministic and informational',()=>{
  assert.equal(consoleUI.formatDuration(63720),'เหลือเวลา 17 ชม. 42 นาที');
  assert.equal(consoleUI.formatDuration(0),'หมดเวลาแล้ว');assert.equal(consoleUI.canMessage(CLOSED_CASE),false);
  assert.equal(consoleUI.canMessage(RESOLVED_CASE),true);
  assert.match(consoleUI.closeReasonLabel('expired'),/ครบเวลา/);
});

test('message polling uses afterSequence, deterministic order and no duplicates',async()=>{
  let poll=0;const harness=createHarness(async(pathValue)=>{
    if(pathValue==='/api/pharmacist/consultations/CASE-1')return OPEN_CASE;
    if(pathValue.includes('/messages?')){poll+=1;return poll===1?{items:[{sequence:2,senderType:'pharmacist',body:'two'},{sequence:1,senderType:'customer',body:'one'}],nextSequence:2}:{items:[{sequence:2,senderType:'pharmacist',body:'two'},{sequence:3,senderType:'customer',body:'three'}],nextSequence:3};}
    return standardHandler(pathValue);
  });
  await harness.session.selectCase('CASE-1');await harness.session.pollOnce();
  assert.deepEqual(harness.state().messages.map((item)=>item.sequence),[1,2,3]);
  assert.ok(harness.calls.some((item)=>item.path.includes('afterSequence=2')));
});

test('message send uses idempotency key, 4000 limit and prevents double submit',async()=>{
  let release;const pending=new Promise((resolve)=>{release=resolve;});
  const harness=createHarness(async(pathValue,options)=>{
    if(pathValue==='/api/pharmacist/consultations/CASE-1')return OPEN_CASE;
    if(pathValue.includes('/messages?'))return {items:[],nextSequence:0};
    if(pathValue.endsWith('/messages'))return pending;
    return standardHandler(pathValue,options);
  });
  await harness.session.selectCase('CASE-1');const first=harness.session.sendMessage('ข้อความ');const second=await harness.session.sendMessage('ซ้ำ');
  assert.deepEqual(second,{ignored:true});const sendCall=harness.calls.find((item)=>item.path.endsWith('/messages'));
  assert.deepEqual(JSON.parse(sendCall.options.body),{body:'ข้อความ',idempotencyKey:'IDEMPOTENCY-1'});
  assert.deepEqual(await harness.session.sendMessage('x'.repeat(4001)),{ignored:true});release({message:{sequence:1,senderType:'pharmacist',body:'ข้อความ'}});await first;
});

test('rate-limit response remains safe and preserves Retry-After',async()=>{
  const harness=createHarness(async(pathValue)=>{
    if(pathValue==='/api/pharmacist/consultations/CASE-1')return OPEN_CASE;
    if(pathValue.includes('/messages?'))return {items:[],nextSequence:0};
    if(pathValue.endsWith('/messages'))throw Object.assign(new Error('raw'),{errorCode:'CONSULTATION_RATE_LIMITED',retryAfterSeconds:9});
  });
  await harness.session.selectCase('CASE-1');await harness.session.sendMessage('test');
  assert.equal(harness.state().retryAfterSeconds,9);assert.match(harness.state().statusMessage,/ถี่เกินไป/);assert.doesNotMatch(harness.state().statusMessage,/raw/);
  assert.deepEqual(await harness.session.sendMessage('blocked during retry window'),{ignored:true});
});

test('resolve does not close chat and explains resolved follow-up contract in markup',async()=>{
  const harness=createHarness(async(pathValue)=>{
    if(pathValue.endsWith('/resolve'))return {};
    if(pathValue==='/api/pharmacist/consultations/CASE-1')return RESOLVED_CASE;
    if(pathValue.includes('/messages?'))return {items:[],nextSequence:0};
    return standardHandler(pathValue);
  });
  await harness.session.selectCase('CASE-1');await harness.session.resolveCase();
  assert.equal(harness.state().selectedCase.state,'resolved');assert.equal(consoleUI.canMessage(harness.state().selectedCase),true);
  assert.match(html,/Resolved ไม่ปิดการสนทนาก่อนเวลา/);
});

test('customer follow-up reflected by backend poll reopens resolved case as active',async()=>{
  let detail=RESOLVED_CASE;const harness=createHarness(async(pathValue)=>{
    if(pathValue==='/api/pharmacist/consultations/CASE-1')return detail;
    if(pathValue.includes('/messages?'))return {items:[],nextSequence:0};return standardHandler(pathValue);
  });
  await harness.session.selectCase('CASE-1');detail={...OPEN_CASE,waitingOn:'pharmacist'};await harness.session.pollOnce();
  assert.equal(harness.state().selectedCase.state,'active');assert.equal(harness.state().selectedCase.waitingOn,'pharmacist');
});

test('assistant generation is explicit and never happens during case select or poll',async()=>{
  const harness=createHarness(async(pathValue)=>{
    if(pathValue==='/api/pharmacist/consultations/CASE-1')return OPEN_CASE;
    if(pathValue.includes('/messages?'))return {items:[],nextSequence:0};
    if(pathValue.endsWith('/assistant'))return {status:'available',assistant:{caseSummary:'private'}};
  });
  await harness.session.selectCase('CASE-1');await harness.session.pollOnce();assert.equal(harness.calls.some((item)=>item.path.endsWith('/assistant')),false);
  await harness.session.generateAssistant();assert.equal(harness.calls.filter((item)=>item.path.endsWith('/assistant')).length,1);
});

test('assistant structured sections and source attribution render as text',()=>{
  const doc=fakeDocument();const container=new FakeElement();
  consoleUI.renderAssistant(doc,container,{status:'available',contextTimestamp:'2026-08-25T10:00:00Z',assistant:{caseSummary:'summary',recordedFacts:[{text:'recorded',sourceCategory:'care_profile'}],responseGuidance:[{text:'guidance',sourceCategory:'general_ai_knowledge'}],disclaimer:'review'}});
  const serialized=walkText(container).join('|');assert.match(serialized,/summary|recorded|Care Profile|guidance|General AI guidance|review/);
});

test('assistant HTML/script payload is rendered via textContent without execution surface',()=>{
  const doc=fakeDocument();const container=new FakeElement();const payload='<script>window.pwned=true</script>';
  consoleUI.renderAssistant(doc,container,{status:'available',assistant:{caseSummary:payload,recordedFacts:[]}});
  assert.ok(walkText(container).includes(payload));
});

test('assistant failure leaves manual chat messageable and hides raw provider error',async()=>{
  const harness=createHarness(async(pathValue)=>{
    if(pathValue==='/api/pharmacist/consultations/CASE-1')return OPEN_CASE;
    if(pathValue.includes('/messages?'))return {items:[],nextSequence:0};
    if(pathValue.endsWith('/assistant'))throw Object.assign(new Error('gemini stack'),{errorCode:'AI_TIMEOUT'});
  });
  await harness.session.selectCase('CASE-1');await harness.session.generateAssistant();
  assert.equal(harness.state().assistant.status,'unavailable');assert.equal(consoleUI.canMessage(harness.state().selectedCase),true);
  const doc=fakeDocument();const container=new FakeElement();consoleUI.renderAssistant(doc,container,harness.state().assistant);
  assert.doesNotMatch(walkText(container).join('|'),/gemini|AI_TIMEOUT|stack/);
});

test('there is no AI auto-send or automatic copy-to-composer path',()=>{
  assert.doesNotMatch(source,/sendAI|autoSend|finalAnswer|patientResponse|sendToCustomer/);
  assert.doesNotMatch(html,/Send AI answer|ส่งคำตอบจาก AI|คัดลอก.*ช่องตอบ/);
  assert.match(html,/เภสัชกรเป็นผู้ตัดสินใจและพิมพ์คำตอบ/);
});

test('case switching clears clinical UI state and stale in-flight responses are ignored',async()=>{
  let release;const pending=new Promise((resolve)=>{release=resolve;});
  const harness=createHarness(async(pathValue)=>{
    if(pathValue==='/api/pharmacist/consultations/CASE-1')return pending;
    if(pathValue==='/api/pharmacist/consultations/CASE-2')return {...OPEN_CASE,caseId:'CASE-2'};
    if(pathValue.includes('/CASE-2/messages'))return {items:[],nextSequence:0};
    if(pathValue.includes('/CASE-1/messages'))return {items:[{sequence:1,body:'secret old'}],nextSequence:1};
  });
  const old=harness.session.selectCase('CASE-1');const fresh=await harness.session.selectCase('CASE-2');
  release(OPEN_CASE);assert.deepEqual(await old,{ignored:true,stale:true});assert.equal(fresh.detail.caseId,'CASE-2');
  assert.equal(JSON.stringify(harness.state()).includes('secret old'),false);
});

test('privacy contract avoids browser storage, URL clinical state and browser logging',()=>{
  assert.doesNotMatch(source,/localStorage|sessionStorage/);assert.doesNotMatch(source,/console\.(log|info|debug|error)\s*\(/);
  assert.doesNotMatch(source,/history\.pushState|history\.replaceState|location\.search/);
});

test('console source and markup expose no LINE IDs contacts Health History or Care Profile writes',()=>{
  for(const forbidden of ['family_phone','emergency_contact_phone','healthHistory','Health History','lineUserId','CareProfiles.update','updateCareProfileHealth'])assert.equal(source.includes(forbidden),false,forbidden);
  assert.doesNotMatch(html,/family phone|เบอร์ผู้ติดต่อ|Health History/);
});

test('runtime backend has no production fallback and pharmacist LIFF ID remains injectable',()=>{
  assert.match(html,/\.\.\/environment\.js/);assert.match(html,/\.\.\/runtime-config\.js/);
  assert.doesNotMatch(source,/https:\/\/phimor-backend\.onrender\.com/);
  assert.match(source,/config\.pharmacistLiffId \|\| root\.PHIMOR_PHARMACIST_LIFF_ID/);
  assert.doesNotMatch(source,/LIFF_ID_PHARMACIST\s*=\s*['"][^'"]+/);
});

test('console bootstrap consumes pharmacistLiffId from trusted backend runtime config',async()=>{
  const access=new FakeElement();access.hidden=true;
  const doc={getElementById:(id)=>id==='accessState'?access:new FakeElement()};
  const initialized=[];let loginCalled=false;
  const liffApi={init:async(options)=>initialized.push(options),isLoggedIn:()=>false,login:()=>{loginCalled=true;}};
  const root={
    PHIMOR_PUBLIC_BACKEND_URL:'https://phimor-backend-staging.onrender.com',
    PhimorRuntimeConfig:{
      requireBackendUrl:(value)=>value,
      assertBackendConfig:(url,config)=>assert.equal(config.publicBackendUrl,url),
    },
  };
  const fetchImpl=async()=>({ok:true,json:async()=>({
    publicBackendUrl:root.PHIMOR_PUBLIC_BACKEND_URL,
    pharmacistLiffId:'pharmacist-liff',
  })});
  const result=await consoleUI.bootstrap({root,doc,fetchImpl,liffApi});
  assert.equal(result,null);assert.deepEqual(initialized,[{liffId:'pharmacist-liff'}]);assert.equal(loginCalled,true);
  assert.equal(access.hidden,true);
});

test('console bootstrap fails safely when pharmacistLiffId is unavailable',async()=>{
  const access=new FakeElement();access.hidden=true;
  const doc={getElementById:(id)=>id==='accessState'?access:new FakeElement()};
  let initCalled=false;
  const root={
    PHIMOR_PUBLIC_BACKEND_URL:'https://phimor-backend-staging.onrender.com',
    PhimorRuntimeConfig:{requireBackendUrl:(value)=>value,assertBackendConfig:()=>{}},
  };
  const fetchImpl=async()=>({ok:true,json:async()=>({publicBackendUrl:root.PHIMOR_PUBLIC_BACKEND_URL})});
  const result=await consoleUI.bootstrap({root,doc,fetchImpl,liffApi:{init:async()=>{initCalled=true;}}});
  assert.equal(result,null);assert.equal(initCalled,false);assert.equal(access.hidden,false);
  assert.match(access.textContent,/ยังไม่ได้ตั้งค่า Pharmacist LIFF/);
});

test('dedicated desktop-first console contains three professional workspace columns',()=>{
  for(const id of ['caseList','chatMessages','messageComposer','assistantContent','generateAssistantButton','refreshAssistantButton'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/AI Pharmacist Assistant/);assert.match(html,/maxlength="4000"/);
  const css=fs.readFileSync(path.join(__dirname,'..','liff-app','pharmacist','console.css'),'utf8');assert.match(css,/grid-template-columns:minmax\(250px,300px\).*minmax\(420px,1fr\).*minmax\(310px,380px\)/);
  assert.match(css,/@media\(max-width:720px\)/);
});

function walkText(element){return [element.textContent,...element.children.flatMap(walkText)].filter(Boolean);}
