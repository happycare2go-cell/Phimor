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
const CLINICAL_RESEARCH_RESULT={
  status:'available',mode:'controlled_live',generatedAt:'2026-09-03T10:00:00Z',contextTimestamp:'2026-09-03T09:59:00Z',
  analyzedThroughSequence:2,analyzedMessageCount:3,totalMessageCount:5,conversationTruncated:true,
  analysis:{
    caseSummary:'ผู้ใช้สอบถามเรื่องการใช้ยาร่วมกัน',
    recordedFacts:[{text:'มีข้อมูลจากบทสนทนา',sourceCategory:'consultation_message'}],
    relevantMedicationContext:[{text:'มี Drug A ในรายการยาปัจจุบัน',sourceCategory:'medication_snapshot'}],
    medicationChanges:[],missingInformation:['ยังไม่มีข้อมูลการแพ้ยาที่บันทึกไว้'],questionsToAsk:['มีอาการผิดปกติหรือไม่'],
    keyClinicalIssues:[{text:'ควรประเมินหลักฐาน',importance:'important',basis:'external_evidence',evidenceRefs:['SRC-1']}],
    safetyConsiderations:[],interactionReview:[{drugs:['Drug A','Drug B'],finding:'มีประเด็นที่ต้องทบทวน',patientRelevance:'พบชื่อยาในข้อมูลที่บันทึก',evidenceRefs:['SRC-1'],limitation:'ข้อมูลยังไม่ครบ'}],
    guidelineReview:[],pharmacistRecommendations:[{text:'เภสัชกรควรตรวจสอบก่อนตอบ',basis:'external_evidence',evidenceRefs:['SRC-1']}],escalationConsiderations:[],
    research:{performed:true,sources:[{referenceId:'SRC-1',title:'Official <script> source',url:'https://www.fda.gov/example',domain:'fda.gov',publishedAt:null,accessedAt:'2026-09-03T10:00:00Z'}],limitations:['INSUFFICIENT_INTERACTION_EVIDENCE']},
    draftResponseForPharmacistReview:'ร่างคำตอบที่ต้องตรวจสอบก่อนส่ง',disclaimer:'เภสัชกรเป็นผู้ตัดสินใจ',
  },
};

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
  if(pathValue==='/api/pharmacist/consultations/clinical-research/capability')return {status:'available',mode:'controlled_live',allowed:true,requiresAcknowledgment:true};
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

test('pharmacist medication schedule keeps legacy timing visibly distinct from structured facts',()=>{
  assert.equal(consoleUI.medicationSchedule({frequency:'1 ครั้ง',dayPeriods:['morning'],useCondition:'after_meal',timing:'หลังอาหาร เช้า'}),
    'วันละ 1 ครั้ง · เช้า · หลังอาหาร · เวลาใช้ยาเดิม หลังอาหาร เช้า');
  assert.equal(consoleUI.medicationSchedule({timing:'ก่อนนอน'}),'เวลาใช้ยาเดิม ก่อนนอน');
  assert.equal(consoleUI.medicationSchedule({frequency:'เมื่อมีอาการ'}),'ความถี่เดิม เมื่อมีอาการ');
});

test('pharmacist access denied is a safe backend-authoritative state',async()=>{
  const denied=Object.assign(new Error('private'),{errorCode:'PHARMACIST_LICENSE_NOT_VERIFIED'});
  const {session,state}=createHarness(async()=>{throw denied;});await session.initialize();
  assert.equal(state().access,'denied');assert.equal(JSON.stringify(state()).includes('private'),false);
});

test('generic middleware pharmacist denial maps to a terminal access-denied state',async()=>{
  const client=consoleUI.createHttpClient({backendUrl:'https://backend.example',idToken:'TOKEN',fetchImpl:async()=>({ok:false,status:403,headers:{get:()=>null},json:async()=>({error:'pharmacist_access_denied'})})});
  await assert.rejects(()=>client('/api/pharmacist/consultations/queue'),(error)=>error.errorCode==='PHARMACIST_ACCESS_DENIED');
  const {session,state}=createHarness(async()=>{throw Object.assign(new Error('private'),{errorCode:'PHARMACIST_ACCESS_DENIED'});});await session.initialize();
  assert.equal(state().access,'denied');assert.match(consoleUI.accessStateMessage(state().access,state().error),/ไม่มีสิทธิ์/);
});

test('safe backend correlation reference reaches the pharmacist error UI without raw provider details',async()=>{
  const client=consoleUI.createHttpClient({backendUrl:'https://backend.example',idToken:'TOKEN',fetchImpl:async()=>({
    ok:false,status:503,headers:{get:()=>null},json:async()=>({errorCode:'CONSULTATION_UNAVAILABLE',correlationId:'CREF-UI'}),
  })});
  await assert.rejects(()=>client('/api/pharmacist/consultations/CASE-1/messages'),(error)=>{
    assert.equal(error.correlationId,'CREF-UI');assert.equal(error.errorCode,'CONSULTATION_UNAVAILABLE');return true;
  });
  assert.match(consoleUI.messageSendErrorMessage('CONSULTATION_UNAVAILABLE','CREF-UI'),/CREF-UI/);
  assert.doesNotMatch(consoleUI.messageSendErrorMessage('CONSULTATION_UNAVAILABLE','CREF-UI'),/SQL|DATABASE|provider/i);
});

test('feature disabled and network failures leave loading state safely',async()=>{
  for(const code of ['CONSULTATION_DISABLED','REQUEST_FAILED']){const {session,state}=createHarness(async()=>{throw Object.assign(new Error('raw'),{errorCode:code});});await session.initialize();assert.equal(state().access,'error');assert.doesNotMatch(consoleUI.accessStateMessage(state().access,state().error),/raw/);}
  assert.match(consoleUI.accessStateMessage('error','CONSULTATION_DISABLED'),/ยังไม่เปิดใช้งาน/);
});

test('collection refresh network failure does not hide an already authorized manual workspace',async()=>{let fail=false;const {session,state}=createHarness(async(pathValue)=>{if(fail)throw Object.assign(new Error('network'),{errorCode:'REQUEST_FAILED'});return standardHandler(pathValue);});await session.initialize();fail=true;await session.loadCollection('active');assert.equal(state().access,'allowed');assert.match(state().statusMessage,/โหลดข้อมูลไม่สำเร็จ/);});

test('active verified pharmacist loads queue and assigned active collection',async()=>{
  const {session,state,calls}=createHarness(standardHandler);await session.initialize();
  assert.equal(state().access,'allowed');assert.equal(state().collections.queue[0].caseId,'CASE-Q');
  assert.equal(state().collections.active[0].caseId,'CASE-1');assert.equal(calls.length,3);
});

test('queue renderer exposes only approved minimal metadata',()=>{
  const doc=fakeDocument();const container=new FakeElement();consoleUI.renderQueue(doc,container,[{...QUEUE_ITEM,careProfileId:'CP-SECRET',lineUserId:'U-SECRET',allergies:'secret'}],{showAccept:true});
  const visible=container.children[0].children.map((item)=>item.textContent).join('|');
  assert.match(visible,/CASE-Q|medication_advice|pharmacist_consultation_eligible/);
  assert.doesNotMatch(visible,/CP-SECRET|U-SECRET|allergies|secret/);
});

test('queued cards cannot open unassigned case detail before explicit acceptance',()=>{
  const doc=fakeDocument();const container=new FakeElement();let selected=0,accepted=0;
  consoleUI.renderQueue(doc,container,[QUEUE_ITEM],{showAccept:true,onSelect:()=>{selected+=1;},onAccept:()=>{accepted+=1;}});
  const card=container.children[0];assert.equal(card.listeners.click,undefined);const button=card.children.find((item)=>item.tagName==='button');button.listeners.click({stopPropagation(){}});assert.equal(selected,0);assert.equal(accepted,1);
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

test('stale accept response cannot replace a newly selected case',async()=>{
  let release;const pending=new Promise((resolve)=>{release=resolve;});const harness=createHarness(async(pathValue)=>{if(pathValue.endsWith('/CASE-Q/accept'))return pending;if(pathValue==='/api/pharmacist/consultations/CASE-1')return OPEN_CASE;if(pathValue.includes('/CASE-1/messages'))return {items:[],nextSequence:0};return standardHandler(pathValue);});
  const accepting=harness.session.acceptCase('CASE-Q');await harness.session.selectCase('CASE-1');release({...OPEN_CASE,caseId:'CASE-Q'});const result=await accepting;assert.equal(result.stale,true);assert.equal(harness.state().selectedCase.caseId,'CASE-1');
});

test('stale send and resolve responses cannot overwrite a newly selected case',async()=>{let releaseSend,releaseResolve;const sendPending=new Promise((resolve)=>{releaseSend=resolve;}),resolvePending=new Promise((resolve)=>{releaseResolve=resolve;});const harness=createHarness(async(pathValue)=>{if(pathValue==='/api/pharmacist/consultations/CASE-1')return OPEN_CASE;if(pathValue==='/api/pharmacist/consultations/CASE-2')return {...OPEN_CASE,caseId:'CASE-2'};if(pathValue.includes('/messages?'))return {items:[],nextSequence:0};if(pathValue.endsWith('/CASE-1/messages'))return sendPending;if(pathValue.endsWith('/CASE-1/resolve'))return resolvePending;return standardHandler(pathValue);});await harness.session.selectCase('CASE-1');const sending=harness.session.sendMessage('ข้อความเก่า');await harness.session.selectCase('CASE-2');assert.equal(harness.state().sending,false);releaseSend({message:{sequence:1,senderType:'pharmacist',body:'ข้อความเก่า'}});assert.equal((await sending).stale,true);assert.equal(harness.state().selectedCase.caseId,'CASE-2');await harness.session.selectCase('CASE-1');const resolving=harness.session.resolveCase();await harness.session.selectCase('CASE-2');assert.equal(harness.state().resolving,false);releaseResolve({});assert.equal((await resolving).stale,true);assert.equal(harness.state().selectedCase.caseId,'CASE-2');});

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

test('accepted case header renders canonical initial question, topic and triage',()=>{
  const doc=fakeDocument();const container=new FakeElement();
  consoleUI.renderCaseHeader(doc,container,{
    ...OPEN_CASE,
    initialQuestion:'ยาสองตัวนี้กินด้วยกันได้ไหม',
    topicCategory:'drug_interaction',
    triageCategory:'pharmacist_consultation_eligible',
  });
  const visible=walkText(container).join('|');
  assert.match(visible,/คำถามตั้งต้น: ยาสองตัวนี้กินด้วยกันได้ไหม/);
  assert.match(visible,/drug_interaction/);
  assert.match(visible,/pharmacist_consultation_eligible/);
});

test('state and waiting-on labels are Thai and do not collapse resolved into closed',()=>{assert.equal(consoleUI.stateLabel('active'),'กำลังปรึกษา');assert.equal(consoleUI.stateLabel('resolved'),'ตอบประเด็นหลักแล้ว');assert.equal(consoleUI.stateLabel('closed'),'หมดเวลาปรึกษาแล้ว');assert.equal(consoleUI.waitingOnLabel('pharmacist','active'),'รอเภสัชกรตอบ');assert.equal(consoleUI.waitingOnLabel('customer','active'),'รอข้อมูลจากผู้ใช้');});

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

test('resolved case cannot be resolved twice but remains messageable',async()=>{let resolveCalls=0;const harness=createHarness(async(pathValue)=>{if(pathValue==='/api/pharmacist/consultations/CASE-1')return RESOLVED_CASE;if(pathValue.includes('/messages?'))return {items:[],nextSequence:0};if(pathValue.endsWith('/resolve')){resolveCalls+=1;return {};}return standardHandler(pathValue);});await harness.session.selectCase('CASE-1');assert.deepEqual(await harness.session.resolveCase(),{ignored:true});assert.equal(resolveCalls,0);assert.equal(consoleUI.canMessage(harness.state().selectedCase),true);});

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

test('assistant generation exposes an immediate visible loading state and prevents duplicates',async()=>{
  let release;const pending=new Promise((resolve)=>{release=resolve;});
  const harness=createHarness(async(pathValue)=>{
    if(pathValue==='/api/pharmacist/consultations/CASE-1')return OPEN_CASE;
    if(pathValue.includes('/messages?'))return {items:[],nextSequence:0};
    if(pathValue.endsWith('/assistant'))return pending;
    return standardHandler(pathValue);
  });
  await harness.session.selectCase('CASE-1');
  const first=harness.session.generateAssistant();
  assert.equal(harness.state().assistant.status,'loading');
  assert.equal(harness.state().assistantBusy,true);
  assert.deepEqual(await harness.session.generateAssistant(),{ignored:true});
  const doc=fakeDocument();const container=new FakeElement();
  consoleUI.renderAssistant(doc,container,harness.state().assistant);
  assert.match(walkText(container).join('|'),/กำลังจัดเตรียมสรุป/);
  release({status:'available',assistant:{caseSummary:'สรุปสำเร็จ'}});
  await first;
  assert.equal(harness.state().assistantBusy,false);
  assert.equal(harness.state().assistant.assistant.caseSummary,'สรุปสำเร็จ');
});

test('assistant structured sections and source attribution render as text',()=>{
  const doc=fakeDocument();const container=new FakeElement();
  let copies=0;
  consoleUI.renderAssistant(doc,container,{status:'available',contextTimestamp:'2026-08-25T10:00:00Z',assistant:{caseSummary:'summary',recordedFacts:[{text:'recorded',sourceCategory:'care_profile'}],responseGuidance:[{text:'guidance',sourceCategory:'general_ai_knowledge'}],draftResponseForPharmacistReview:'editable draft',disclaimer:'review'}},{onCopyDraft:()=>{copies+=1;}});
  const serialized=walkText(container).join('|');assert.match(serialized,/summary|recorded|Care Profile|guidance|General AI guidance|ร่างคำตอบสำหรับเภสัชกรตรวจสอบ|ร่างสำหรับเภสัชกรตรวจสอบ|editable draft|review/);
  const buttons=[];const collect=(node)=>{if(node.tagName==='button')buttons.push(node);node.children.forEach(collect);};collect(container);
  buttons.find((button)=>button.textContent==='คัดลอกร่างไปช่องตอบ').listeners.click();assert.equal(copies,1);
});

test('copying the ordinary assistant draft fills the composer but never sends',()=>{
  const composer={value:'',disabled:false};
  assert.equal(consoleUI.copyAssistantDraftToComposer({status:'available',assistant:{draftResponseForPharmacistReview:'ร่างที่เภสัชกรต้องตรวจ'}},composer),true);
  assert.equal(composer.value,'ร่างที่เภสัชกรต้องตรวจ');
  assert.equal(consoleUI.copyAssistantDraftToComposer({status:'available',assistant:{}},composer),false);
  assert.equal(consoleUI.copyAssistantDraftToComposer({status:'available',assistant:{draftResponseForPharmacistReview:'draft'}},{value:'',disabled:true}),false);
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

test('clinical research is explicit, duplicate protected and uses its dedicated route',async()=>{
  let release;const pending=new Promise((resolve)=>{release=resolve;});
  const harness=createHarness(async(pathValue)=>{
    if(pathValue==='/api/pharmacist/consultations/CASE-1')return OPEN_CASE;
    if(pathValue.includes('/messages?'))return {items:[],nextSequence:0};
    if(pathValue.endsWith('/clinical-research'))return pending;
    return standardHandler(pathValue);
  });
  await harness.session.selectCase('CASE-1');await harness.session.pollOnce();
  assert.equal(harness.calls.some((item)=>item.path.endsWith('/clinical-research')),false);
  const first=harness.session.generateClinicalResearch({safetyAcknowledged:true});
  assert.equal(harness.state().clinicalResearch.status,'loading');assert.equal(harness.state().activePanel,'research');
  assert.deepEqual(await harness.session.generateClinicalResearch({safetyAcknowledged:true}),{ignored:true});
  release(CLINICAL_RESEARCH_RESULT);await first;
  const call=harness.calls.find((item)=>item.path.endsWith('/clinical-research'));
  assert.deepEqual(JSON.parse(call.options.body),{refresh:true,safetyAcknowledged:true});
  assert.equal(harness.state().clinicalResearch.analysis.caseSummary,CLINICAL_RESEARCH_RESULT.analysis.caseSummary);
});

test('clinical research panel renders truncation, stale state, citations and private draft safely',()=>{
  const doc=fakeDocument();const container=new FakeElement();let refreshes=0,copies=0;
  consoleUI.renderClinicalResearch(doc,container,CLINICAL_RESEARCH_RESULT,{
    latestSequence:3,onRefresh:()=>{refreshes+=1;},onCopyDraft:()=>{copies+=1;},
  });
  const visible=walkText(container).join('|');
  assert.match(visible,/มีข้อความใหม่หลังการวิเคราะห์|ไม่ครอบคลุมข้อความทั้งหมด|3 จาก 5/);
  assert.match(visible,/สรุปประเด็นจากบทสนทนา|ยาปัจจุบันที่เกี่ยวข้อง|ข้อมูลปฏิกิริยาระหว่างยา|ร่างสำหรับเภสัชกรตรวจสอบ/);
  assert.match(visible,/Official <script> source|fda\.gov|ไม่พบวันที่เผยแพร่|เปิดแหล่งอ้างอิง|สนับสนุน/);
  const buttons=[];const collect=(node)=>{if(node.tagName==='button')buttons.push(node);node.children.forEach(collect);};collect(container);
  buttons.find((button)=>button.textContent==='วิเคราะห์ใหม่').listeners.click();
  buttons.find((button)=>button.textContent==='นำร่างไปใส่ช่องตอบ').listeners.click();
  assert.equal(refreshes,1);assert.equal(copies,1);assert.equal(container.children.some((child)=>child.tagName==='script'),false);
});

test('uncited interaction claims are not presented as evidence and deidentified context is described accurately',()=>{
  const doc=fakeDocument();const container=new FakeElement();
  const result={
    ...CLINICAL_RESEARCH_RESULT,
    mode:'deidentified_pilot',
    analysis:{
      ...CLINICAL_RESEARCH_RESULT.analysis,
      interactionReview:[{
        drugs:['Drug A','Drug B'],
        finding:'ข้อความที่ไม่มีหลักฐานอ้างอิงต้องไม่แสดง',
        evidenceRefs:[],
      }],
      research:{
        ...CLINICAL_RESEARCH_RESULT.analysis.research,
        sources:[...CLINICAL_RESEARCH_RESULT.analysis.research.sources,{
          referenceId:'SRC-UNLINKED',title:'Unlinked source',url:'https://www.who.int/example',domain:'who.int',
        }],
      },
    },
  };
  consoleUI.renderClinicalResearch(doc,container,result,{latestSequence:2});
  const visible=walkText(container).join('|');
  assert.match(visible,/ใช้สรุปแบบไม่ระบุตัวตนที่เภสัชกรตรวจแล้ว/);
  assert.match(visible,/ยังไม่พบหลักฐานเพียงพอจากแหล่งที่ค้นในครั้งนี้/);
  assert.match(visible,/ยังไม่พบประเด็นในผลลัพธ์ที่อ้างถึงแหล่งนี้โดยตรง/);
  assert.doesNotMatch(visible,/ข้อความที่ไม่มีหลักฐานอ้างอิงต้องไม่แสดง/);
  assert.doesNotMatch(visible,/วิเคราะห์ถึงข้อความลำดับ/);
});

test('copying the pharmacist-reviewed draft only fills the composer and never invokes send',()=>{
  const composer={value:'',disabled:false};
  assert.equal(consoleUI.copyResearchDraftToComposer(CLINICAL_RESEARCH_RESULT,composer),true);
  assert.equal(composer.value,'ร่างคำตอบที่ต้องตรวจสอบก่อนส่ง');
  assert.equal(consoleUI.copyResearchDraftToComposer({status:'available',analysis:{}},composer),false);
  assert.equal(consoleUI.clinicalResearchIsStale(CLINICAL_RESEARCH_RESULT,3),true);
  assert.equal(consoleUI.clinicalResearchIsStale(CLINICAL_RESEARCH_RESULT,2),false);
});

test('clinical research failure remains safe and does not disable manual chat',async()=>{
  const harness=createHarness(async(pathValue)=>{
    if(pathValue==='/api/pharmacist/consultations/CASE-1')return OPEN_CASE;
    if(pathValue.includes('/messages?'))return {items:[],nextSequence:0};
    if(pathValue.endsWith('/clinical-research'))throw Object.assign(new Error('raw provider payload'),{errorCode:'AI_TIMEOUT'});
    return standardHandler(pathValue);
  });
  await harness.session.selectCase('CASE-1');await harness.session.generateClinicalResearch();
  assert.equal(consoleUI.canMessage(harness.state().selectedCase),true);
  assert.equal(harness.state().clinicalResearch.errorCode,'AI_TIMEOUT');
  assert.doesNotMatch(consoleUI.clinicalResearchErrorMessage('AI_TIMEOUT'),/raw provider|AI_TIMEOUT/);
  assert.equal(consoleUI.clinicalResearchErrorMessage('AI_INVALID_RESPONSE'),'ผลการวิเคราะห์ไม่ผ่านการตรวจสอบของระบบ กรุณาลองใหม่');
});

test('known message-send failures map to useful safe Thai states',()=>{
  assert.match(consoleUI.messageSendErrorMessage('CONSULTATION_EXPIRED'),/หมดเวลา/);
  assert.match(consoleUI.messageSendErrorMessage('CONSULTATION_ACCESS_DENIED'),/สิทธิ์/);
  assert.match(consoleUI.messageSendErrorMessage('CONSULTATION_RATE_LIMITED'),/ถี่เกินไป/);
  assert.match(consoleUI.messageSendErrorMessage('CONSULTATION_NOT_ACTIVE'),/สถานะเคส/);
  assert.match(consoleUI.messageSendErrorMessage('UNEXPECTED_DATABASE_ERROR'),/ชั่วคราว/);
  assert.doesNotMatch(consoleUI.messageSendErrorMessage('UNEXPECTED_DATABASE_ERROR'),/DATABASE|SQL/);
  assert.match(consoleUI.assistantErrorMessage('AI_TIMEOUT'),/นานเกินไป/);
  assert.match(consoleUI.assistantErrorMessage('AI_RATE_LIMIT'),/รอสักครู่/);
});

test('there is no AI auto-send and draft transfer remains an explicit pharmacist action',()=>{
  assert.doesNotMatch(source,/sendAI|autoSend|finalAnswer|patientResponse|sendToCustomer/);
  assert.doesNotMatch(html,/Send AI answer|ส่งคำตอบจาก AI/);
  assert.match(source,/copyAssistantDraftToComposer/);
  assert.match(source,/copyResearchDraftToComposer/);
  assert.match(html,/จะไม่ถูกส่งให้ผู้ใช้โดยอัตโนมัติ/);
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

test('assigned case loads LINE contact and Care Profile context separately from chat',async()=>{
  const context={
    generatedAt:'2026-08-25T10:00:00Z',
    contact:{displayName:'ญาติผู้ติดต่อ',pictureUrl:'https://profile.line-scdn.net/avatar'},
    careProfile:{patientName:'คุณยาย',chronicConditions:['เบาหวาน'],drugAllergies:'Penicillin'},
    currentMedications:[{name:'Metformin',strength:'500 mg',indication:'เบาหวาน',dose:'1',unit:'เม็ด',
      frequency:'2 ครั้ง',useCondition:'after_meal',dayPeriods:['morning','evening'],instruction:'ตามฉลาก',
      amount:'30 เม็ด',notes:'ติดตามตามแผน',condition:'ข้อมูลเดิม'}],
    upcomingAppointments:[{hospital:'โรงพยาบาลทดสอบ',datetime:'2026-08-26T10:00:00Z'}],
  };
  const harness=createHarness(async(pathValue)=>{
    if(pathValue==='/api/pharmacist/consultations/CASE-1')return OPEN_CASE;
    if(pathValue.endsWith('/CASE-1/context'))return context;
    if(pathValue.includes('/messages?'))return {items:[],nextSequence:0};
    return standardHandler(pathValue);
  });
  await harness.session.selectCase('CASE-1');
  assert.equal(harness.state().caseContext.contact.displayName,'ญาติผู้ติดต่อ');
  assert.ok(harness.calls.some((item)=>item.path.endsWith('/CASE-1/context')));
  const doc=fakeDocument(),container=new FakeElement();consoleUI.renderCaseContext(doc,container,context);
  const visible=walkText(container).join('|');
  assert.match(visible,/ผู้ติดต่อผ่าน LINE|ญาติผู้ติดต่อ|อาจเป็นญาติหรือผู้ดูแล/);
  assert.match(visible,/Care Profile ของผู้รับการดูแล|คุณยาย|เบาหวาน|Penicillin|Metformin|โรงพยาบาลทดสอบ/);
  assert.match(visible,/ข้อบ่งใช้ เบาหวาน|ครั้งละ 1 เม็ด|เช้า \/ เย็น|หลังอาหาร|จำนวนที่ได้รับทั้งหมด 30 เม็ด|หมายเหตุเพิ่มเติม ติดตามตามแผน|ข้อมูลเดิม/);
  assert.doesNotMatch(visible,/lineUserId|family_phone|emergency_contact|Health History/);
});

test('Care Profile context failure does not block pharmacist chat',async()=>{
  const harness=createHarness(async(pathValue)=>{
    if(pathValue==='/api/pharmacist/consultations/CASE-1')return OPEN_CASE;
    if(pathValue.endsWith('/CASE-1/context'))throw Object.assign(new Error('private'),{errorCode:'CONSULTATION_ACCESS_DENIED'});
    if(pathValue.includes('/messages?'))return {items:[],nextSequence:0};
  });
  await harness.session.selectCase('CASE-1');
  assert.equal(harness.state().caseContext.status,'unavailable');
  assert.equal(consoleUI.canMessage(harness.state().selectedCase),true);
  assert.equal(JSON.stringify(harness.state()).includes('private'),false);
});

test('privacy contract avoids browser storage, URL clinical state and browser logging',()=>{
  assert.doesNotMatch(source,/localStorage|sessionStorage/);assert.doesNotMatch(source,/console\.(log|info|debug|error)\s*\(/);
  assert.doesNotMatch(source,/history\.pushState|history\.replaceState|location\.search/);
});

test('console exposes separated contact/profile projection but no LINE IDs phones Health History or writes',()=>{
  for(const forbidden of ['family_phone','emergency_contact_phone','healthHistory','Health History','lineUserId','CareProfiles.update','updateCareProfileHealth'])assert.equal(source.includes(forbidden),false,forbidden);
  assert.match(html,/id="caseContext"/);assert.doesNotMatch(html,/family phone|เบอร์ผู้ติดต่อ|Health History/);
});

test('runtime backend and pharmacist LIFF ID have no production or browser fallback',()=>{
  assert.match(html,/\.\.\/environment\.js/);assert.match(html,/\.\.\/runtime-config\.js/);
  assert.doesNotMatch(source,/https:\/\/phimor-backend\.onrender\.com/);
  assert.match(source,/const liffId=config\.pharmacistLiffId/);
  assert.doesNotMatch(source,/PHIMOR_PHARMACIST_LIFF_ID|familyLiffId|location\.(search|hash)|localStorage|sessionStorage/);
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

test('console bootstrap fails safely on backend URL mismatch before liff.init',async()=>{const access=new FakeElement();access.hidden=true;const doc={getElementById:()=>access};let initCalled=false;const root={PHIMOR_PUBLIC_BACKEND_URL:'https://staging.example',PhimorRuntimeConfig:{requireBackendUrl:(value)=>value,assertBackendConfig:()=>{throw new Error('BACKEND_URL_MISMATCH');}}};const fetchImpl=async()=>({ok:true,json:async()=>({publicBackendUrl:'https://production.example',pharmacistLiffId:'PHARM'})});await consoleUI.bootstrap({root,doc,fetchImpl,liffApi:{init:async()=>{initCalled=true;}}});assert.equal(initCalled,false);assert.match(access.textContent,/ไม่สามารถเปิด/);});

test('dedicated desktop-first console contains three professional workspace columns',()=>{
  for(const id of ['caseList','chatMessages','messageComposer','assistantContent','generateAssistantButton','refreshAssistantButton'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/AI Pharmacist Assistant/);assert.match(html,/maxlength="4000"/);
  const css=fs.readFileSync(path.join(__dirname,'..','liff-app','pharmacist','console.css'),'utf8');assert.match(css,/grid-template-columns:minmax\(250px,300px\).*minmax\(420px,1fr\).*minmax\(310px,380px\)/);
  assert.match(css,/@media\(max-width:720px\)/);
  assert.match(css,/min-height:44px/);assert.match(css,/safe-area-inset-bottom/);assert.match(css,/case-card--closed/);assert.match(css,/case-header--closed/);
  for(const id of ['showClinicalResearchButton','clinicalResearchPanel','clinicalResearchContent','refreshClinicalResearchButton','runClinicalResearchButton','clinicalResearchDeidentifiedSummary','clinicalResearchPrivacyReviewed','clinicalResearchAcknowledgment'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(css,/clinical-research-body\{[^}]*overflow-y:auto/);
  assert.match(html,/พี่หมอ Clinical Research|ผู้ช่วยค้นคว้าข้อมูลประกอบการดูแลสำหรับเภสัชกร|ไม่ใช่คำวินิจฉัยหรือคำสั่งการรักษา/);
});

function walkText(element){return [element.textContent,...element.children.flatMap(walkText)].filter(Boolean);}
