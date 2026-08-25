const test=require('node:test');
const assert=require('node:assert/strict');

process.env.NODE_ENV='test';

const {createConsultationReadService,projectCase}=require('../backend/services/consultationReadService');
const {createConsultationCaseService}=require('../backend/services/consultationCaseService');
const {createConsultationExpirationService}=require('../backend/services/consultationExpirationService');
const {createConsultationOperationsService}=require('../backend/services/consultationOperationsService');
const {createConsultationMessageService}=require('../backend/services/consultationMessageService');
const {
  buildConsultationNotificationIntent,getNearExpiryMilestones,
}=require('../backend/services/consultationNotificationEventService');

const NOW='2026-08-25T12:00:00.000Z';
function clone(value){return value==null?value:structuredClone(value);}
function row(overrides={}) {
  return {
    case_id:'CASE-1',order_id:'ORD-1',care_profile_id:'CP-1',customer_line_user_id:'U-FAMILY',
    state:'active',waiting_on:'pharmacist',assigned_pharmacist_id:'PH-1',
    queued_at:'2026-08-25T09:00:00.000Z',accepted_at:'2026-08-25T10:00:00.000Z',
    expires_at:'2026-08-26T10:00:00.000Z',resolved_at:null,closed_at:null,close_reason:null,
    order_status:'paid',provisioning_status:'provisioned',database_now:NOW,last_message_sequence:4,
    initial_question:'กินยาสองตัวนี้ด้วยกันได้ไหม',...overrides,
  };
}

function createHarness(initial=row()) {
  const state={cases:new Map([[initial.case_id,clone(initial)]]),events:[],profileWrites:0,healthHistoryWrites:0};
  const pharmacists=new Map([
    ['U-PH-1',{pharmacistId:'PH-1',status:'active',licenseVerifiedAt:'verified'}],
    ['U-PH-2',{pharmacistId:'PH-2',status:'active',licenseVerifiedAt:'verified'}],
    ['U-SUSP',{pharmacistId:'PH-S',status:'suspended',licenseVerifiedAt:'verified'}],
    ['U-UNVERIFIED',{pharmacistId:'PH-U',status:'active',licenseVerifiedAt:null}],
  ]);
  const accounts={async requireActive(lineUserId){
    const account=pharmacists.get(lineUserId);
    if (!account || account.status!=='active') {const e=new Error('inactive');e.code='PHARMACIST_INACTIVE';throw e;}
    if (!account.licenseVerifiedAt) {const e=new Error('unverified');e.code='PHARMACIST_LICENSE_NOT_VERIFIED';throw e;}
    return account;
  }};
  const repository={
    async findCaseForUpdate(id){return clone(state.cases.get(id)||null);},
    async findCaseForRead(id){return clone(state.cases.get(id)||null);},
    async updateCaseWorkflow(id,{state:next,waitingOn,closedAt=null,closeReason=null}){
      const item=state.cases.get(id);Object.assign(item,{state:next,waiting_on:waitingOn});
      if(next==='resolved') item.resolved_at=NOW;
      if(closedAt)item.closed_at=closedAt;if(closeReason)item.close_reason=closeReason;
      item.database_now=NOW;return clone(item);
    },
    async insertEvent(event){
      if(event.idempotency_key&&state.events.some((item)=>item.case_id===event.case_id&&item.idempotency_key===event.idempotency_key))return null;
      state.events.push(clone(event));return clone(event);
    },
    async listExpiredCaseIds(){return [...state.cases.values()].filter((item)=>['active','resolved'].includes(item.state)&&item.expires_at&&new Date(item.expires_at)<=new Date(item.database_now)).map((item)=>item.case_id);},
    async reassignCase(id,pharmacistId){const item=state.cases.get(id);item.assigned_pharmacist_id=pharmacistId;return clone(item);},
    async findMessageByIdempotency(){return null;},
    async insertMessage(){throw new Error('message insert must not be reached');},
  };
  const transaction=async(_key,fn)=>fn();
  return {state,repository,transaction,accounts};
}

test('queue supports oldest-first pagination, age/category filters and minimal disclosure',async()=>{
  const rows=[
    row({case_id:'C-1',state:'queued',assigned_pharmacist_id:null,accepted_at:null,expires_at:null,queued_at:'2026-08-25T08:00:00Z'}),
    row({case_id:'C-2',state:'queued',assigned_pharmacist_id:null,accepted_at:null,expires_at:null,queued_at:'2026-08-25T09:00:00Z'}),
    row({case_id:'C-3',state:'queued',assigned_pharmacist_id:null,accepted_at:null,expires_at:null,queued_at:'2026-08-25T10:00:00Z',initial_question:'ควรรักษายังไง'}),
  ];
  const repository={async listQueuedCases({cursorQueuedAt,cursorCaseId,minQueuedMinutes}){
    return rows.filter((item)=>(!cursorQueuedAt||new Date(item.queued_at)>new Date(cursorQueuedAt)||(new Date(item.queued_at).getTime()===new Date(cursorQueuedAt).getTime()&&item.case_id>cursorCaseId))
      && (new Date(item.database_now)-new Date(item.queued_at))/60000>=minQueuedMinutes);
  }};
  const accounts={async requireActive(){return {pharmacistId:'PH-1'};}};
  const service=createConsultationReadService({repository,pharmacistAccounts:accounts});
  const first=await service.listQueue({pharmacistLineUserId:'U-PH',limit:2,minQueuedMinutes:60});
  assert.deepEqual(first.items.map((item)=>item.caseId),['C-1','C-2']);assert.equal(first.hasMore,true);
  const second=await service.listQueue({pharmacistLineUserId:'U-PH',limit:2,cursor:first.nextCursor});
  assert.deepEqual(second.items.map((item)=>item.caseId),['C-3']);
  const filtered=await service.listQueue({pharmacistLineUserId:'U-PH',topicCategory:'treatment'});
  assert.deepEqual(filtered.items.map((item)=>item.caseId),['C-3']);
  const serialized=JSON.stringify(first);
  for(const secret of ['CP-1','U-FAMILY','กินยาสองตัวนี้','customer_line_user_id'])assert.equal(serialized.includes(secret),false);
  assert.deepEqual(Object.keys(first.items[0]).sort(),['caseId','queuedAt','topicCategory','triageCategory','waitingSeconds'].sort());
});

test('pharmacist active, resolved and closed collections are case-scoped and status is fresh',async()=>{
  const rows=[row(),row({case_id:'CASE-R',state:'resolved',waiting_on:'none'}),row({case_id:'CASE-C',state:'closed',waiting_on:'none',closed_at:NOW})];
  const repository={async listCasesForPharmacist(id,{collection}){return rows.filter((item)=>item.assigned_pharmacist_id===id&&item.state===collection);}};
  const accounts={async requireActive(id){if(id==='SUSP'){const e=new Error();e.code='PHARMACIST_INACTIVE';throw e;}return {pharmacistId:'PH-1'};}};
  const service=createConsultationReadService({repository,pharmacistAccounts:accounts});
  assert.equal((await service.listPharmacistCases({pharmacistLineUserId:'OK',collection:'active'})).items.length,1);
  assert.equal((await service.listPharmacistCases({pharmacistLineUserId:'OK',collection:'resolved'})).items.length,1);
  assert.equal((await service.listPharmacistCases({pharmacistLineUserId:'OK',collection:'closed'})).items.length,1);
  await assert.rejects(()=>service.listPharmacistCases({pharmacistLineUserId:'SUSP',collection:'active'}),(e)=>e.code==='PHARMACIST_INACTIVE');
});

test('case projection exposes runtime metadata without identity, payment or clinical internals',()=>{
  const projected=projectCase(row({provider_secret:'SECRET',customer_line_user_id:'PRIVATE',care_profile_id:'CP-SECRET',medications:['ยา']}));
  assert.equal(projected.effectiveClosed,false);assert.equal(projected.remainingSeconds,79200);
  assert.deepEqual(projected.messageCursor,{lastSequence:4});
  const serialized=JSON.stringify(projected);
  for(const value of ['SECRET','PRIVATE','CP-SECRET','ยา','provider'])assert.equal(serialized.includes(value),false);
});

test('assigned pharmacist resolves without closing or changing the consultation window',async()=>{
  const h=createHarness();const service=createConsultationCaseService({repository:h.repository,transaction:h.transaction,pharmacistAccounts:h.accounts,eventId:()=>`E-${h.state.events.length+1}`});
  const before=clone(h.state.cases.get('CASE-1'));
  const result=await service.resolveCase({caseId:'CASE-1',pharmacistLineUserId:'U-PH-1'});
  assert.equal(result.case.state,'resolved');assert.equal(result.case.waiting_on,'none');
  assert.equal(result.case.accepted_at,before.accepted_at);assert.equal(result.case.expires_at,before.expires_at);
  assert.equal(h.state.events.filter((item)=>item.event_type==='resolved').length,1);
  await assert.rejects(()=>service.resolveCase({caseId:'CASE-1',pharmacistLineUserId:'U-SUSP'}),(e)=>e.code==='PHARMACIST_INACTIVE');
});

test('expiration materialization is exact-time, append-only and idempotent without scheduler',async()=>{
  const h=createHarness(row({database_now:'2026-08-26T10:00:00.000Z'}));
  const service=createConsultationExpirationService({repository:h.repository,transaction:h.transaction,eventId:()=>`E-${h.state.events.length+1}`});
  const first=await service.materializeCase('CASE-1');const second=await service.materializeCase('CASE-1');
  assert.equal(first.changed,true);assert.equal(second.changed,false);
  assert.equal(h.state.cases.get('CASE-1').state,'closed');assert.equal(h.state.cases.get('CASE-1').waiting_on,'none');
  assert.equal(h.state.events.filter((item)=>item.event_type==='closed').length,1);
  const sweep=await service.sweepExpired();assert.deepEqual(sweep,{scanned:0,closed:0});
});

test('internal reassignment preserves timer, requires active verified target and revokes original access',async()=>{
  const h=createHarness();const service=createConsultationOperationsService({repository:h.repository,transaction:h.transaction,pharmacistAccounts:h.accounts,eventId:()=>`E-${h.state.events.length+1}`});
  const before=clone(h.state.cases.get('CASE-1'));
  await service.reassignCase({caseId:'CASE-1',toPharmacistLineUserId:'U-PH-2',operationalActorId:'OPS-1'});
  const after=h.state.cases.get('CASE-1');assert.equal(after.assigned_pharmacist_id,'PH-2');
  assert.equal(after.accepted_at,before.accepted_at);assert.equal(after.expires_at,before.expires_at);
  const messages=createConsultationMessageService({repository:h.repository,transaction:h.transaction,pharmacistAccounts:h.accounts});
  await assert.rejects(()=>messages.sendMessage({caseId:'CASE-1',actor:{type:'pharmacist',lineUserId:'U-PH-1'},body:'x',idempotencyKey:'K-1'}),(e)=>e.code==='CONSULTATION_ACCESS_DENIED');
  for(const target of ['U-SUSP','U-UNVERIFIED'])await assert.rejects(()=>service.reassignCase({caseId:'CASE-1',toPharmacistLineUserId:target,operationalActorId:'OPS-1'}));
  assert.equal(h.state.profileWrites,0);assert.equal(h.state.healthHistoryWrites,0);
});

test('notification intents and 2h/30m milestones contain no clinical or identity payload',()=>{
  const intent=buildConsultationNotificationIntent({type:'consultation_expiring_soon',caseId:'CASE-1',milestoneMinutes:120,
    question:'SECRET QUESTION',medications:['SECRET MED'],lineUserId:'U-SECRET'});
  assert.deepEqual(getNearExpiryMilestones('2026-08-26T10:00:00Z'),[
    {milestoneMinutes:120,notifyAt:'2026-08-26T08:00:00.000Z'},
    {milestoneMinutes:30,notifyAt:'2026-08-26T09:30:00.000Z'},
  ]);
  const serialized=JSON.stringify(intent);
  for(const secret of ['QUESTION','MED','U-SECRET'])assert.equal(serialized.includes(secret),false);
  const firstMessage=buildConsultationNotificationIntent({type:'new_consultation_message',caseId:'CASE-1',messageSequence:1});
  const secondMessage=buildConsultationNotificationIntent({type:'new_consultation_message',caseId:'CASE-1',messageSequence:2});
  assert.notEqual(firstMessage.dedupeKey,secondMessage.dedupeKey);
});

test('runtime operational services introduce no external API or Care Profile write dependency',()=>{
  const sources=[createConsultationExpirationService,createConsultationOperationsService,buildConsultationNotificationIntent].join('\n');
  assert.doesNotMatch(sources,/fetch\(|axios|pushMessage|CareProfiles\.update|HealthHistory/i);
});
