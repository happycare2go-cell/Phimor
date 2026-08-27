process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createConsultationRealtimeTicketService } = require('../backend/services/consultationRealtimeTicketService');
const { createConsultationRealtimeAccessService } = require('../backend/services/consultationRealtimeAccessService');
const { createConsultationReadReceiptService } = require('../backend/services/consultationReadReceiptService');
const { createConsultationRealtimeBus, normalizeSignal } = require('../backend/services/consultationRealtimeBus');
const { createConsultationMessageService } = require('../backend/services/consultationMessageService');
const { createConsultationRepository } = require('../backend/services/consultationRepository');
const { projectCase } = require('../backend/services/consultationReadService');

const SECRET = 'local-test-realtime-secret-32-bytes-minimum';
const config = Object.freeze({
  configured:true,
  ticketSecret:SECRET,
  ticketTtlSeconds:60,
  heartbeatSeconds:30,
  websocketPath:'/api/consultations/realtime',
});

function caseRow(overrides={}) {
  return {
    case_id:'CASE-RT-1', care_profile_id:'CP-1', customer_line_user_id:'U-CUSTOMER',
    order_id:'ORDER-1', order_status:'paid', provisioning_status:'provisioned',
    state:'active', assigned_pharmacist_id:'PHARM-1', customer_last_read_sequence:1,
    pharmacist_last_read_sequence:2, ...overrides,
  };
}

test('short-lived realtime ticket contains no raw actor or clinical data and expires deterministically',()=>{
  let now=Date.parse('2026-08-27T10:00:00.000Z');
  const service=createConsultationRealtimeTicketService({config,clock:()=>now,ticketId:()=> 'TICKET-1'});
  const issued=service.issue({caseId:'CASE-RT-1',role:'customer',actorId:'U-CUSTOMER'});
  assert.equal(issued.websocketPath,'/api/consultations/realtime');
  assert.doesNotMatch(issued.ticket,/U-CUSTOMER|question|message|payment/i);
  assert.deepEqual(service.verify(issued.ticket),{
    version:1,ticketId:'TICKET-1',caseId:'CASE-RT-1',role:'customer',
    actorRef:service.actorReference('customer','U-CUSTOMER'),
    issuedAt:Math.floor(now/1000),expiresAt:Math.floor(now/1000)+60,
  });
  now+=61000;
  assert.throws(()=>service.verify(issued.ticket),(error)=>error.code==='REALTIME_TICKET_EXPIRED');
});

test('ticket is case/actor/role bound and Family authorization is checked again on socket join',async()=>{
  const tickets=createConsultationRealtimeTicketService({config,clock:()=>Date.parse('2026-08-27T10:00:00Z'),ticketId:()=> 'TICKET-2'});
  let authorized=true;
  const repository={findCaseForRead:async(caseId)=>caseId==='CASE-RT-1'?caseRow():caseRow({case_id:'CASE-RT-2',care_profile_id:'CP-2',customer_line_user_id:'U-OTHER'})};
  const access=createConsultationRealtimeAccessService({repository,tickets,authorize:async({lineUserId,careProfileId})=>{
    assert.equal(lineUserId,'U-CUSTOMER');assert.equal(careProfileId,'CP-1');if(!authorized){const error=new Error('denied');error.code='CARE_PROFILE_ACCESS_DENIED';error.status=403;throw error;}
  },pharmacistAccounts:{requireActive:async()=>({pharmacistId:'PHARM-1'}),requireActiveById:async()=>({pharmacistId:'PHARM-1'})}});
  const issued=await access.issueFamilyTicket({caseId:'CASE-RT-1',lineUserId:'U-CUSTOMER'});
  assert.equal((await access.authorizeTicket(issued.ticket)).role,'customer');
  const payload=tickets.verify(issued.ticket);
  await assert.rejects(()=>access.authorizeTicket({...payload,caseId:'CASE-RT-2'}),(error)=>error.code==='CONSULTATION_ACCESS_DENIED');
  await assert.rejects(()=>access.authorizeTicket({...payload,role:'pharmacist'}),(error)=>error.code==='CONSULTATION_ACCESS_DENIED');
  authorized=false;
  await assert.rejects(()=>access.authorizeTicket(issued.ticket),(error)=>error.code==='CARE_PROFILE_ACCESS_DENIED');
});

test('realtime ticket is atomically single-use through the shared consultation event ledger',async()=>{
  const tickets=createConsultationRealtimeTicketService({config,clock:()=>Date.parse('2026-08-27T10:00:00Z'),ticketId:()=> 'TICKET-SINGLE-USE'});
  const consumed=new Set();const events=[];
  const repository={
    findCaseForRead:async()=>caseRow(),
    insertEvent:async(record)=>{events.push(record);if(consumed.has(record.idempotency_key))return null;consumed.add(record.idempotency_key);return record;},
  };
  const access=createConsultationRealtimeAccessService({repository,tickets,authorize:async()=>{},pharmacistAccounts:{requireActive:async()=>({pharmacistId:'PHARM-1'}),requireActiveById:async()=>({pharmacistId:'PHARM-1'})}});
  const issued=await access.issueFamilyTicket({caseId:'CASE-RT-1',lineUserId:'U-CUSTOMER'});
  assert.equal((await access.consumeTicket(issued.ticket)).role,'customer');
  await assert.rejects(()=>access.consumeTicket(issued.ticket),(error)=>error.code==='REALTIME_TICKET_REPLAYED');
  assert.equal(events[0].event_type,'realtime_ticket_consumed');
  assert.match(events[0].idempotency_key,/^realtime-ticket:TICKET-SINGLE-USE$/);
  assert.doesNotMatch(JSON.stringify(events),/U-CUSTOMER|question|message body|LINE_CHANNEL/);
});

test('pharmacist realtime join requires active assigned account and queued/unassigned cases stay private',async()=>{
  let row=caseRow();let active=true;
  const tickets=createConsultationRealtimeTicketService({config,clock:()=>Date.parse('2026-08-27T10:00:00Z')});
  const access=createConsultationRealtimeAccessService({repository:{findCaseForRead:async()=>row},tickets,authorize:async()=>{},pharmacistAccounts:{
    requireActive:async()=>{if(!active){const error=new Error('inactive');error.code='PHARMACIST_INACTIVE';throw error;}return {pharmacistId:'PHARM-1'};},
    requireActiveById:async()=>{if(!active){const error=new Error('inactive');error.code='PHARMACIST_INACTIVE';throw error;}return {pharmacistId:'PHARM-1'};},
  }});
  const issued=await access.issuePharmacistTicket({caseId:'CASE-RT-1',pharmacistLineUserId:'U-PHARM'});
  assert.equal((await access.authorizeTicket(issued.ticket)).role,'pharmacist');
  row=caseRow({assigned_pharmacist_id:'PHARM-2'});
  await assert.rejects(()=>access.authorizeTicket(issued.ticket),(error)=>error.code==='CONSULTATION_ACCESS_DENIED');
  row=caseRow({state:'queued',assigned_pharmacist_id:null});
  await assert.rejects(()=>access.issuePharmacistTicket({caseId:'CASE-RT-1',pharmacistLineUserId:'U-PHARM'}),(error)=>error.code==='CONSULTATION_ACCESS_DENIED');
  row=caseRow();active=false;
  await assert.rejects(()=>access.authorizeTicket(issued.ticket),(error)=>error.code==='PHARMACIST_INACTIVE');
});

test('long-lived realtime authorization rejects closed and effectively expired cases',async()=>{
  let row=caseRow({database_now:'2026-08-27T10:00:00Z',expires_at:'2026-08-27T11:00:00Z'});
  const tickets=createConsultationRealtimeTicketService({config,clock:()=>Date.parse('2026-08-27T10:00:00Z')});
  const access=createConsultationRealtimeAccessService({repository:{findCaseForRead:async()=>row},tickets,authorize:async()=>{},pharmacistAccounts:{requireActive:async()=>({pharmacistId:'PHARM-1'}),requireActiveById:async()=>({pharmacistId:'PHARM-1'})}});
  const issued=await access.issueFamilyTicket({caseId:'CASE-RT-1',lineUserId:'U-CUSTOMER'});
  row=caseRow({state:'closed',close_reason:'resolved_by_policy'});
  await assert.rejects(()=>access.authorizeTicket(issued.ticket),(error)=>error.code==='CONSULTATION_CLOSED');
  row=caseRow({database_now:'2026-08-27T12:00:00Z',expires_at:'2026-08-27T11:00:00Z'});
  await assert.rejects(()=>access.authorizeTicket(issued.ticket),(error)=>error.code==='CONSULTATION_EXPIRED');
});

function readHarness({row=caseRow(),lastSequence=5}={}) {
  let current={...row};const events=[];
  const repository={
    findCaseForUpdate:async()=>({...current}),getLastMessageSequence:async()=>lastSequence,
    updateReadSequence:async(_caseId,reader,sequence)=>{const field=reader==='customer'?'customer_last_read_sequence':'pharmacist_last_read_sequence';current={...current,[field]:Math.max(Number(current[field]||0),sequence)};return {...current};},
  };
  const service=createConsultationReadReceiptService({repository,transaction:async(_key,fn)=>fn(),authorize:async()=>{},pharmacistAccounts:{requireActive:async()=>({pharmacistId:'PHARM-1'})},realtime:{publish:async(event)=>events.push(event)}});
  return {service,events,current:()=>current};
}

test('read cursors are role-safe, monotonic, bounded by transcript and broadcast only after persistence',async()=>{
  const customer=readHarness();
  assert.deepEqual(await customer.service.markRead({caseId:'CASE-RT-1',actor:{type:'customer',lineUserId:'U-CUSTOMER'},sequence:4}),{reader:'customer',sequence:4,changed:true});
  assert.deepEqual(await customer.service.markRead({caseId:'CASE-RT-1',actor:{type:'customer',lineUserId:'U-CUSTOMER'},sequence:2}),{reader:'customer',sequence:4,changed:false});
  assert.equal(customer.current().customer_last_read_sequence,4);
  assert.equal(customer.current().pharmacist_last_read_sequence,2);
  assert.deepEqual(customer.events,[{eventType:'read.updated',caseId:'CASE-RT-1',reader:'customer',sequence:4}]);
  await assert.rejects(()=>customer.service.markRead({caseId:'CASE-RT-1',actor:{type:'customer',lineUserId:'U-CUSTOMER'},sequence:6}),(error)=>error.code==='CONSULTATION_READ_SEQUENCE_AHEAD');

  const pharmacist=readHarness({row:caseRow({pharmacist_last_read_sequence:1})});
  await pharmacist.service.markRead({caseId:'CASE-RT-1',actor:{type:'pharmacist',lineUserId:'U-PHARM'},sequence:5});
  assert.equal(pharmacist.current().pharmacist_last_read_sequence,5);
  assert.equal(pharmacist.current().customer_last_read_sequence,1);
});

test('read authorization denies another customer, another pharmacist and queued room',async()=>{
  const family=readHarness();
  await assert.rejects(()=>family.service.markRead({caseId:'CASE-RT-1',actor:{type:'customer',lineUserId:'U-OTHER'},sequence:1}),(error)=>error.code==='CONSULTATION_ACCESS_DENIED');
  const otherPharmacist=createConsultationReadReceiptService({repository:{findCaseForUpdate:async()=>caseRow(),getLastMessageSequence:async()=>2},transaction:async(_key,fn)=>fn(),authorize:async()=>{},pharmacistAccounts:{requireActive:async()=>({pharmacistId:'PHARM-2'})},realtime:{publish:async()=>{}}});
  await assert.rejects(()=>otherPharmacist.markRead({caseId:'CASE-RT-1',actor:{type:'pharmacist',lineUserId:'U-PHARM-2'},sequence:1}),(error)=>error.code==='CONSULTATION_ACCESS_DENIED');
  const queued=readHarness({row:caseRow({state:'queued',assigned_pharmacist_id:null})});
  await assert.rejects(()=>queued.service.markRead({caseId:'CASE-RT-1',actor:{type:'customer',lineUserId:'U-CUSTOMER'},sequence:0}),(error)=>error.code==='CONSULTATION_NOT_ACCEPTED');
});

test('realtime bus signals contain references only, dedupe event IDs, and database failure never blocks local delivery',async()=>{
  const logged=[];const delivered=[];
  const bus=createConsultationRealtimeBus({testMode:false,queryFn:async()=>{throw new Error('database unavailable');},acquireClient:async()=>{throw new Error('unavailable');},logger:{warn:(entry)=>logged.push(entry)}});
  bus.subscribe((signal)=>delivered.push(signal));
  const result=await bus.publish({eventId:'EVENT-1',eventType:'message.created',caseId:'CASE-RT-1',sequence:7,body:'private body'});
  assert.equal(result.local,true);assert.equal(result.distributed,false);
  assert.deepEqual(delivered,[{eventId:'EVENT-1',eventType:'message.created',caseId:'CASE-RT-1',sequence:7}]);
  assert.equal(bus.deliver(normalizeSignal({eventId:'EVENT-1',eventType:'message.created',caseId:'CASE-RT-1',sequence:7})),false);
  assert.doesNotMatch(JSON.stringify(logged),/private body|U-CUSTOMER|LINE_CHANNEL_ACCESS_TOKEN/);
});

test('production realtime bus LISTEN receives safe cross-instance notification signals',async()=>{
  const listeners={},queries=[],received=[];
  const client={on:(name,fn)=>{listeners[name]=fn;},query:async(sql)=>queries.push(sql),release:()=>queries.push('release')};
  const bus=createConsultationRealtimeBus({testMode:false,queryFn:async()=>{},acquireClient:async()=>client,logger:{warn:()=>{}}});
  bus.subscribe((signal)=>received.push(signal));assert.deepEqual(await bus.start(),{available:true});assert.deepEqual(queries,['LISTEN phimor_consultation_realtime']);
  listeners.notification({channel:'phimor_consultation_realtime',payload:JSON.stringify({eventId:'REMOTE-1',eventType:'read.updated',caseId:'CASE-RT-1',reader:'pharmacist',sequence:9})});
  assert.deepEqual(received,[{eventId:'REMOTE-1',eventType:'read.updated',caseId:'CASE-RT-1',reader:'pharmacist',sequence:9}]);
  await bus.stop();assert.deepEqual(queries,['LISTEN phimor_consultation_realtime','UNLISTEN phimor_consultation_realtime','release']);
});

test('realtime bus reconnects, re-LISTENs, rejects malformed payload and requests client recovery',async()=>{
  const queries=[],scheduled=[],statuses=[],logged=[];let acquireCount=0;
  function makeClient(label){const client=new EventEmitter();client.query=async(sql)=>queries.push(`${label}:${sql}`);client.release=()=>queries.push(`${label}:release`);return client;}
  const first=makeClient('first'),second=makeClient('second');
  const bus=createConsultationRealtimeBus({testMode:false,queryFn:async()=>{},acquireClient:async()=>{acquireCount+=1;return acquireCount===1?first:second;},logger:{warn:(entry)=>logged.push(entry)},schedule:(fn,ms)=>{scheduled.push({fn,ms});return scheduled.length;},cancelSchedule:()=>{},random:()=>0});
  bus.subscribeStatus((status)=>statuses.push(status));
  assert.deepEqual(await bus.start(),{available:true});
  first.emit('error',new Error('connection lost'));
  assert.equal(bus.health().available,false);assert.equal(bus.health().reconnecting,true);assert.equal(scheduled[0].ms,1000);
  scheduled.shift().fn();await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(bus.health().available,true);assert.deepEqual(statuses,[{status:'recovered'}]);
  second.emit('notification',{channel:'phimor_consultation_realtime',payload:'{"eventType":"message.created","caseId":"CASE-RT-1","sequence":"clinical body"}'});
  assert.ok(logged.some((entry)=>entry.event==='consultation_realtime_signal_rejected'));
  assert.deepEqual(queries.slice(0,3),[
    'first:LISTEN phimor_consultation_realtime','first:release','second:LISTEN phimor_consultation_realtime',
  ]);
  await bus.stop();
});

test('message is emitted only after authoritative persistence and realtime failure cannot roll it back',async()=>{
  const calls=[];let stored=null;
  const repository={
    findCaseForUpdate:async()=>caseRow({database_now:'2026-08-27T10:00:00Z',expires_at:'2026-08-28T10:00:00Z'}),
    findMessageByIdempotency:async()=>stored,
    insertMessage:async(input)=>{calls.push('persist');stored={...input,message_sequence:1,created_at:'2026-08-27T10:00:00Z'};return {message:stored,duplicate:false};},
    updateCaseWorkflow:async()=>{calls.push('workflow');return caseRow();},insertEvent:async()=>{},
  };
  const service=createConsultationMessageService({repository,transaction:async(_key,fn)=>{calls.push('begin');const value=await fn();calls.push('commit');return value;},authorize:async()=>{},realtime:{publish:async()=>{calls.push('publish');throw new Error('bus down');}},messageId:()=> 'M-1'});
  const first=await service.sendMessage({caseId:'CASE-RT-1',actor:{type:'customer',lineUserId:'U-CUSTOMER'},body:'ข้อความที่บันทึกแล้ว',idempotencyKey:'IDEM-1'});
  assert.equal(first.message.message_sequence,1);assert.deepEqual(calls,['begin','persist','workflow','commit','publish']);
  calls.length=0;
  const duplicate=await service.sendMessage({caseId:'CASE-RT-1',actor:{type:'customer',lineUserId:'U-CUSTOMER'},body:'ข้อความที่บันทึกแล้ว',idempotencyKey:'IDEM-1'});
  assert.equal(duplicate.duplicate,true);assert.deepEqual(calls,['begin','commit']);
});

test('unread projection is sender-aware and repository queries exclude own messages',async()=>{
  const customer=projectCase({...caseRow(),database_now:'2026-08-27T10:00:00Z',expires_at:'2026-08-28T10:00:00Z',customer_unread_count:2,pharmacist_unread_count:7,last_message_sequence:9},{viewerRole:'customer'});
  const pharmacist=projectCase({...caseRow(),database_now:'2026-08-27T10:00:00Z',expires_at:'2026-08-28T10:00:00Z',customer_unread_count:2,pharmacist_unread_count:7,last_message_sequence:9},{viewerRole:'pharmacist'});
  assert.equal(customer.unreadCount,2);assert.equal(pharmacist.unreadCount,7);
  let sql='';const repository=createConsultationRepository({queryFn:async(statement)=>{sql=statement;return {rows:[]};}});
  await repository.listCasesForPharmacist('PHARM-1',{collection:'active'});
  assert.match(sql,/sender_type = 'customer'/);assert.match(sql,/message_sequence > c\.pharmacist_last_read_sequence/);
  assert.doesNotMatch(sql,/COUNT\(\*\).*last_message_sequence/s);
});
