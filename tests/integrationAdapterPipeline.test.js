process.env.NODE_ENV='test';
const test=require('node:test');const assert=require('node:assert/strict');
const {createIntegrationAdapterService}=require('../backend/services/integrationAdapterService');
const {createIntegrationEventService}=require('../backend/services/integrationEventService');
const {createIntegrationAdapterMemoryRepository}=require('./helpers/integrationAdapterMemoryRepository');
const {createIntegrationEventMemoryRepository}=require('./helpers/integrationEventMemoryRepository');

const target='care.daily_report.finalized';
const identity={integrationClientId:'INT-ADAPTER',organizationId:'ORG-A',sourceSystem:'generic_partner'};
function native(recordId='REPORT-1'){return{branch_code:'EXT-C',resident_code:'EXT-R',resident_name:'คุณยายตัวอย่าง',report_id:recordId,care_date:'2026-09-01',recorded_at:'2026-09-01T01:00:00Z',finalized_at:'2026-09-01T01:05:00Z',finalizer_name:'ผู้จัดการ',pulse:'72 bpm',note:'พักผ่อนได้',ignored_phone:'0800000000'};}
function careItemNative(items=[{item_type:'symptom_note',value_type:'text',value:'พักผ่อนได้'}]){const payload=native();delete payload.note;payload.data={care_items:items};return payload;}
function rules(sample,{generalReportPath='note'}={}){const paths=new Map(sample.fields.map((field)=>[field.sourcePath,field.locatorKey]));return[
  ['subject.externalCenterId','branch_code'],['subject.externalResidentId','resident_code'],['subject.displayName','resident_name'],
  ['data.externalRecordId','report_id'],['data.careDate','care_date'],['data.recordedAt','recorded_at'],['data.finalizedAt','finalized_at'],
  ['data.finalizedBy.displayName','finalizer_name'],['vitals.pulse','pulse'],['data.generalReport',generalReportPath],
].map(([targetField,path])=>({targetField,locatorKey:paths.get(path)}));}
async function fixture({payload=native(),generalReportPath='note'}={}){
  const adapterRepository=createIntegrationAdapterMemoryRepository();let sequence=0;
  const adapter=createIntegrationAdapterService({repository:adapterRepository,platformService:{async inspectIntegrationClient(){return{integrationClientId:identity.integrationClientId,sourceSystem:identity.sourceSystem,eventScopes:[target]};}},idFactory:(prefix)=>`${prefix}-${++sequence}`,now:()=>new Date('2026-09-01T00:00:00Z'),withTransaction:async(_key,fn)=>fn(),audit:async()=>{}});
  await adapter.startCapture({integrationClientId:identity.integrationClientId,actorReference:'ADM-1'});
  await adapter.captureIfWaiting({identity,input:payload});const sample=(await adapter.getLatestSample({integrationClientId:identity.integrationClientId})).sample;
  const draft=await adapter.createDraft({integrationClientId:identity.integrationClientId,sampleId:sample.sampleId,mappingRules:rules(sample,{generalReportPath}),actorReference:'ADM-1'});
  await adapter.activateAdapter({integrationClientId:identity.integrationClientId,sampleId:sample.sampleId,adapterProfileId:draft.adapter.adapterProfileId,actorReference:'ADM-1'});
  const eventRepository=createIntegrationEventMemoryRepository();let writes=0;
  const events=createIntegrationEventService({repository:eventRepository,platformService:{async inspectIntegrationClient(){return{sourceSystem:identity.sourceSystem};},async observeExternalSubject(){}},tenantResolver:{async authorizeResolvedIntegrationTarget(){return{centerId:'CTR-A',sourceSystem:identity.sourceSystem};},async resolveExternalSubject(){return{status:'mapped',residentId:'RES-A',careProfileId:'CP-A'};}},dailyCareService:{async recordCanonical(input){writes+=1;assert.equal(input.items[0].itemType,'symptom_note');assert.equal(input.vitalSigns.observations[0].measurementType,'pulse');return{item:{dailyReportId:`DCR-${writes}`},notification:{notificationStatus:'queued',groupReconciliationStatus:'verified_match',verifiedLineGroupId:'G-MASKED'}};}},vitalSignService:{},idFactory:(prefix)=>`${prefix}-${eventRepository.state.events.length+1}`,withTransaction:async(_key,fn)=>fn(),now:()=>new Date('2026-09-01T02:00:00Z')});
  return{adapter,events,eventRepository,get writes(){return writes;}};
}

test('active adapter preserves canonical inbox idempotency and one clinical/notification effect',async()=>{const f=await fixture();const firstPrepared=await f.adapter.prepareInbound({identity,input:native()});const first=await f.events.ingest({identity,input:firstPrepared.input});const retryPrepared=await f.adapter.prepareInbound({identity,input:native()});const retry=await f.events.ingest({identity,input:retryPrepared.input});assert.equal(first.status,'processed');assert.equal(retry.duplicate,true);assert.equal(firstPrepared.input.eventId,retryPrepared.input.eventId);assert.equal(f.writes,1);assert.equal(f.eventRepository.state.events.length,1);assert.equal(f.eventRepository.state.events[0].notification_intent_status,'queued');});

test('care_items runtime drift fails closed before any clinical write',async()=>{const generalReportPath='data.care_items[item_type=symptom_note].value';const f=await fixture({payload:careItemNative(),generalReportPath});const valid=await f.adapter.prepareInbound({identity,input:careItemNative()});assert.equal(valid.action,'transformed');assert.equal(valid.input.data.careItems[0].value,'พักผ่อนได้');const changedPayloads=[
  careItemNative([{value_type:'text',value:'ไม่มี discriminator'}]),
  careItemNative([{item_type:'symptom_note',value_type:'text',value:'หนึ่ง'},{item_type:'symptom_note',value_type:'text',value:'สอง'}]),
  careItemNative([{item_type:'activity_note',value_type:'text',value:'เปลี่ยนชนิด'}]),
  careItemNative([{item_type:'symptom_note',value_type:'text',value:{text:'เปลี่ยนโครงสร้าง'}}]),
];for(const payload of changedPayloads){await assert.rejects(f.adapter.prepareInbound({identity,input:payload}),{code:'ADAPTER_SOURCE_CHANGED'});}assert.equal(f.writes,0);});

test('client without active adapter remains strict canonical passthrough',async()=>{const adapter=createIntegrationAdapterService({repository:createIntegrationAdapterMemoryRepository(),platformService:{},audit:async()=>{}});const canonical={schemaVersion:'1.0',eventId:'CANONICAL-1'};const prepared=await adapter.prepareInbound({identity:{integrationClientId:'INT-CANONICAL'},input:canonical});assert.equal(prepared.action,'canonical');assert.equal(prepared.input,canonical);});
