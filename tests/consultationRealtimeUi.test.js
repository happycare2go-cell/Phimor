const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const family=require('../liff-app/family/consultation-ui');
const pharmacist=require('../liff-app/pharmacist/console');

const ROOT=path.join(__dirname,'..');
const ACTIVE_CASE={caseId:'CASE-RT-1',state:'active',waitingOn:'pharmacist',expiresAt:'2026-08-28T10:00:00Z',remainingSeconds:3600,readState:{selfLastReadSequence:0,otherLastReadSequence:0},unreadCount:0,initialQuestion:'รับประทานยานี้พร้อมอาหารได้ไหม'};

test('Family room consumes realtime message/read/case events and REST remains the write/read authority',async()=>{
  const calls=[];let handlers=null;
  const request=async(url,options={})=>{
    calls.push([url,options]);
    if(url.startsWith('/api/consultations/eligibility'))return {availability:'eligible',termsVersion:'v1'};
    if(url.startsWith('/api/consultations?'))return {items:[ACTIVE_CASE]};
    if(url==='/api/consultations/CASE-RT-1')return ACTIVE_CASE;
    if(url.includes('/messages?beforeSequence='))return {items:[],nextSequence:0,hasMoreOlder:false};
    if(url.endsWith('/read'))return {reader:'customer',sequence:1,changed:true};
    if(url.endsWith('/messages')&&options.method==='POST')return {message:{messageId:'M-2',sequence:2,senderType:'customer',body:'ขอบคุณค่ะ',createdAt:'2026-08-27T10:01:00Z'}};
    throw new Error(`unexpected ${url}`);
  };
  const session=family.createFamilyConsultationSession({request,realtimeFactory:(value)=>{handlers=value;return {connect:(caseId)=>calls.push(['socket-connect',caseId]),stop:()=>{},setVisible:()=>{}};},now:()=>new Date('2026-08-27T10:00:00Z')});
  await session.setProfile({profile:{care_profile_id:'CP-1',patient_name:'คุณแม่'}});await session.selectCase('CASE-RT-1');
  assert.equal((await session.markRead(1)).ignored,true);assert.equal(calls.some(([url])=>url==='/api/consultations/CASE-RT-1/read'),false);
  session.openChat();
  await handlers.onEvent({type:'message.created',caseId:'CASE-RT-1',sequence:1,message:{messageId:'M-1',sequence:1,senderType:'pharmacist',body:'รับประทานหลังอาหารได้ครับ',createdAt:'2026-08-27T10:00:30Z'}});
  assert.equal(session.snapshot().messages.length,1);assert.equal(session.snapshot().messages[0].body,'รับประทานหลังอาหารได้ครับ');
  await session.markRead(1);assert.equal(session.snapshot().selectedCase.readState.selfLastReadSequence,1);
  await session.sendMessage('ขอบคุณค่ะ');assert.equal(session.snapshot().messages.at(-1).sequence,2);
  await handlers.onEvent({type:'read.updated',caseId:'CASE-RT-1',reader:'pharmacist',sequence:2});
  assert.equal(family.receiptState(session.snapshot().messages.at(-1),session.snapshot().selectedCase),'read');
  assert.ok(calls.some(([url])=>url==='/api/consultations/CASE-RT-1/read'));
  assert.ok(calls.some(([url,options])=>url==='/api/consultations/CASE-RT-1/messages'&&options.method==='POST'));
  session.unmount();
});

test('queued Family view has no active composer and becomes chat-ready on realtime acceptance',async()=>{
  let handlers;const queued={...ACTIVE_CASE,state:'queued',waitingOn:'none',expiresAt:null,remainingSeconds:0};
  const request=async(url)=>{if(url.startsWith('/api/consultations/eligibility'))return {availability:'eligible',termsVersion:'v1'};if(url.startsWith('/api/consultations?'))return {items:[queued]};if(url==='/api/consultations/CASE-RT-1')return queued;throw new Error(`unexpected ${url}`);};
  const session=family.createFamilyConsultationSession({request,realtimeFactory:(value)=>{handlers=value;return {connect:()=>{},stop:()=>{},setVisible:()=>{}};}});
  await session.setProfile({profile:{care_profile_id:'CP-1',patient_name:'คุณแม่'}});await session.selectCase('CASE-RT-1');
  assert.equal(family.canMessage(session.snapshot().selectedCase),false);assert.equal(session.openChat().ignored,true);
  await handlers.onEvent({type:'case.updated',caseId:'CASE-RT-1',case:{...ACTIVE_CASE}});
  assert.equal(session.snapshot().selectedCase.state,'active');assert.match(session.snapshot().statusMessage,/เข้าห้องแชท/);
  session.unmount();
});

test('Pharmacist room receives customer message realtime, dedupes REST recovery and updates receipts',async()=>{
  let handlers;const calls=[];
  const request=async(url,options={})=>{
    calls.push([url,options]);
    if(url==='/api/pharmacist/consultations/queue')return {items:[]};
    if(url==='/api/pharmacist/consultations/active')return {items:[ACTIVE_CASE]};
    if(url==='/api/pharmacist/consultations/CASE-RT-1')return ACTIVE_CASE;
    if(url.includes('/messages?beforeSequence='))return {items:[],nextSequence:0,hasMoreOlder:false};
    if(url.endsWith('/context'))return {status:'available',careProfile:{patientName:'คุณสมใจ'}};
    if(url.includes('/messages?afterSequence='))return {items:[{messageId:'M-1',sequence:1,senderType:'customer',body:'สวัสดีค่ะ',createdAt:'2026-08-27T10:00:00Z'}],nextSequence:1};
    if(url.endsWith('/read'))return {reader:'pharmacist',sequence:1,changed:true};
    throw new Error(`unexpected ${url}`);
  };
  const session=pharmacist.createConsoleSession({request,realtimeFactory:(value)=>{handlers=value;return {connect:()=>{},stop:()=>{},setVisible:()=>{}};}});
  await session.initialize();await session.selectCase('CASE-RT-1');
  assert.equal(session.snapshot().roomOpen,true);
  await handlers.onEvent({type:'message.created',caseId:'CASE-RT-1',sequence:1,message:{messageId:'M-1',sequence:1,senderType:'customer',body:'สวัสดีค่ะ',createdAt:'2026-08-27T10:00:00Z'}});
  await session.pollOnce();assert.equal(session.snapshot().messages.length,1);
  await session.markRead(1);assert.equal(session.snapshot().selectedCase.readState.selfLastReadSequence,1);
  assert.ok(calls.some(([url])=>url==='/api/pharmacist/consultations/CASE-RT-1/read'));
  session.clearSelection();
});

test('sender-aware unread and receipt helpers never count own message as newly read by the other role',()=>{
  const rows=[{sequence:1,senderType:'customer'},{sequence:2,senderType:'pharmacist'},{sequence:3,senderType:'customer'}];
  assert.equal(family.latestIncomingSequence(rows,'customer'),2);
  assert.equal(pharmacist.latestIncomingSequence(rows,'pharmacist'),3);
  assert.equal(family.receiptState({sequence:4,senderType:'customer'}, {readState:{otherLastReadSequence:3}}),'persisted');
  assert.equal(family.receiptState({sequence:4,senderType:'customer'}, {readState:{otherLastReadSequence:4}}),'read');
});

test('read receipts require an active visible room and a visible message region',async()=>{
  for(const helper of [family.shouldMarkRead,pharmacist.shouldMarkRead]){
    assert.equal(helper({roomActive:true,documentVisible:true,nearBottom:true}),true);
    assert.equal(helper({roomActive:true,documentVisible:true,messageVisible:true}),true);
    assert.equal(helper({roomActive:true,documentVisible:true,nearBottom:false,messageVisible:false}),false);
    assert.equal(helper({roomActive:true,documentVisible:false,nearBottom:true,messageVisible:true}),false);
    assert.equal(helper({roomActive:false,documentVisible:true,nearBottom:true,messageVisible:true}),false);
  }

  let readCalls=0;
  const request=async(url)=>{
    if(url.startsWith('/api/consultations/eligibility'))return {availability:'eligible',termsVersion:'v1'};
    if(url.startsWith('/api/consultations?'))return {items:[ACTIVE_CASE]};
    if(url==='/api/consultations/CASE-RT-1')return ACTIVE_CASE;
    if(url.includes('/messages?beforeSequence='))return {items:[],nextSequence:0,hasMoreOlder:false};
    if(url.endsWith('/read')){readCalls+=1;return {reader:'customer',sequence:1,changed:true};}
    throw new Error(`unexpected ${url}`);
  };
  const session=family.createFamilyConsultationSession({request,realtimeFactory:()=>({connect:()=>{},stop:()=>{},setVisible:()=>{}})});
  await session.setProfile({profile:{care_profile_id:'CP-1',patient_name:'คุณแม่'}});await session.selectCase('CASE-RT-1');session.openChat();session.setDocumentVisible(false);
  assert.equal((await session.markRead(1)).ignored,true);assert.equal(readCalls,0);session.unmount();
});

test('dedicated chat markup and mobile CSS keep context outside transcript and do not persist clinical data',()=>{
  const familyHtml=fs.readFileSync(path.join(ROOT,'liff-app/family/index.html'),'utf8');
  const familyCss=fs.readFileSync(path.join(ROOT,'liff-app/family/consultation-ui.css'),'utf8');
  const familyJs=fs.readFileSync(path.join(ROOT,'liff-app/family/consultation-ui.js'),'utf8');
  const pharmacistHtml=fs.readFileSync(path.join(ROOT,'liff-app/pharmacist/index.html'),'utf8');
  const pharmacistCss=fs.readFileSync(path.join(ROOT,'liff-app/pharmacist/console.css'),'utf8');
  assert.match(familyHtml,/consultation-chat-room/);assert.match(familyHtml,/consultationNewMessages/);assert.match(familyCss,/safe-area-inset-bottom/);assert.match(familyCss,/overflow-x:hidden/);
  assert.match(pharmacistHtml,/ข้อมูลเคส/);assert.match(pharmacistHtml,/ผู้ช่วยเภสัชกร/);assert.match(pharmacistHtml,/support-panel/);assert.match(pharmacistCss,/pharmacist-chat-open/);
  assert.doesNotMatch(`${familyJs}\n${fs.readFileSync(path.join(ROOT,'liff-app/pharmacist/console.js'),'utf8')}`,/localStorage|sessionStorage|history\.pushState|console\.log/);
});
