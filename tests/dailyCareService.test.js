process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const db=require('../backend/db');
const {createDailyCareService}=require('../backend/services/dailyCareService');
const {createFamilyCareNotificationService}=require('../backend/services/familyCareNotificationService');
const {normalizeItems}=require('../backend/domain/dailyCare');
const {createDailyCareMemoryRepository}=require('./helpers/dailyCareMemoryRepository');

function fixture({capability=true,vitalService=null,transaction=null,familyNotifications=null}={}) {
  db.resetAll();const repository=createDailyCareMemoryRepository();let seq=0;
  const platformService={
    async getOrganizationForCenter(id){return id==='CTR-A'?{organizationId:'ORG-A',status:'active'}:id==='CTR-B'?{organizationId:'ORG-B',status:'active'}:null;},
    async isCenterCapabilityEnabled(id,key){return capability&&id==='CTR-A'&&['daily_care_v1','vital_signs_v1'].includes(key);},
    async inspectIntegrationClient(id){return id==='INT-A'?{organizationId:'ORG-A',status:'active',centers:[{center_id:'CTR-A'}]}:{organizationId:'ORG-B',status:'revoked',centers:[]};},
  };
  const service=createDailyCareService({repository,platformService,
    vitalSignService:vitalService||{async recordCanonical(input){return{duplicate:false,item:{vitalSetId:'VSET-1',status:'recorded',occurredAt:input.occurredAt,recordedAt:'2026-08-27T01:00:01Z',sourceType:input.provenance.sourceType,observations:input.observations}};}},
    familyCareNotificationService:familyNotifications||{async enqueueFinalized(){return{ok:false,reason:'no_family_recipient',groupReconciliationStatus:'no_expected_group'};}},
    idFactory:(prefix)=>`${prefix}-${++seq}`,withTransaction:transaction||(async(_key,fn)=>fn()),
    now:()=>new Date('2026-08-27T03:00:00Z').toISOString(),
    authorizeCareProfileAccess:async({lineUserId,careProfileId})=>{if(lineUserId!=='U-OWNER'||careProfileId!=='CP-A')throw Object.assign(new Error('denied'),{code:'FORBIDDEN',status:403});return{principalType:'family_owner'};},
  });
  return{service,repository};
}

async function seed() {
  await db.Centers.insert({center_id:'CTR-A',name:'ศูนย์ A',status:'active'});
  await db.Centers.insert({center_id:'CTR-B',name:'ศูนย์ B',status:'active'});
  await db.CenterStaff.insert({staff_id:'STF-A',center_id:'CTR-A',line_user_id:'U-STAFF',display_name:'ผู้ดูแลเอ',role:'staff',status:'active'});
  await db.CenterStaff.insert({staff_id:'STF-M',center_id:'CTR-A',line_user_id:'U-MANAGER',display_name:'ผู้จัดการเอ',role:'manager',status:'active'});
  await db.CenterStaff.insert({staff_id:'STF-O',center_id:'CTR-A',line_user_id:'U-OWNER-CENTER',display_name:'เจ้าของเอ',role:'owner',status:'active'});
  await db.CenterStaff.insert({staff_id:'STF-B',center_id:'CTR-B',line_user_id:'U-MANAGER-B',role:'manager',status:'active'});
  await db.Residents.insert({resident_id:'RES-A',center_id:'CTR-A',care_profile_id:'CP-A',full_name:'คุณยายเอ',room:'A-1',status:'active'});
  await db.Residents.insert({resident_id:'RES-B',center_id:'CTR-B',care_profile_id:'CP-B',full_name:'คุณตาบี',status:'active'});
}

const items=[
  {itemType:'nutrition',valueType:'text',value:'รับประทานอาหารได้ครึ่งจาน'},
  {itemType:'fluid_intake',valueType:'numeric',value:500,sourceUnit:'mL'},
  {itemType:'bowel_movement',valueType:'numeric',value:1,sourceUnit:'times'},
];

test('daily items preserve factual typed values and never derive clinical interpretation',()=>{
  const out=normalizeItems(items);assert.deepEqual(out.map((item)=>item.itemType),['nutrition','fluid_intake','bowel_movement']);
  assert.equal(out[0].textValue,'รับประทานอาหารได้ครึ่งจาน');assert.equal(out[1].numericValue,500);
  assert.equal('severity' in out[0],false);assert.equal(normalizeItems([{itemType:'mood',valueType:'text',value:'พูดคุยดี'}])[0].itemType,'mood_behavior');
  assert.throws(()=>normalizeItems([{itemType:'diagnosis',valueType:'text',value:'x'}]),{code:'UNSUPPORTED_DAILY_ITEM'});
});

test('Center staff submit creates an auditable submitted record and no Family notification',async()=>{
  const calls=[];const{service,repository}=fixture({familyNotifications:{async enqueueFinalized(input){calls.push(input);return{ok:true};}}});await seed();
  const result=await service.recordNative({lineUserId:'U-STAFF',centerId:'CTR-A',residentId:'RES-A',occurredAt:'2026-08-27T08:00:00+07:00',
    careDate:'2026-08-27',shift:{code:'day',sourceLabel:'กลางวัน'},items});
  assert.equal(result.item.status,'submitted');assert.equal(result.item.items.length,3);
  assert.equal(repository.state.reports[0].recorded_by_actor_reference,'center_staff:STF-A');
  assert.equal(repository.state.events[0].event_type,'submitted');assert.equal(calls.length,0);
  assert.doesNotMatch(JSON.stringify(result),/U-STAFF|organization_id|care_profile_id/i);
});

test('submitted Daily Care and nested vitals share one canonical transaction without any push',async()=>{
  let vitalInput;const calls=[];const{service,repository}=fixture({familyNotifications:{async enqueueFinalized(input){calls.push(input);return{ok:true};}},
    vitalService:{async recordCanonical(input){vitalInput=input;return{item:{vitalSetId:'VSET-NEST',status:'recorded',occurredAt:input.occurredAt,
      recordedAt:'2026-08-27T01:00:01Z',sourceType:'native_phimor',observations:[{measurementType:'pulse',numericValue:70,sourceValueText:'70',sourceUnit:'/min',canonicalUnit:'/min',context:null}]}};}}});
  await seed();const result=await service.recordNative({lineUserId:'U-STAFF',centerId:'CTR-A',residentId:'RES-A',occurredAt:'2026-08-27T01:00:00Z',items,
    vitalSigns:{observations:[{measurementType:'pulse',numericValue:70,sourceUnit:'/min'}]}});
  assert.deepEqual(vitalInput.subject,{centerId:'CTR-A',residentId:'RES-A',careProfileId:'CP-A'});
  assert.equal(result.item.vitalSigns[0].vitalSetId,'VSET-NEST');assert.equal(repository.state.links.length,1);assert.equal(calls.length,0);
});

test('failed nested vital rolls back the submitted report under the shared transaction boundary',async()=>{
  let repository;const transaction=async(_key,fn)=>{const snapshot=structuredClone(repository.state);try{return await fn();}catch(error){for(const key of Object.keys(snapshot))repository.state[key].splice(0,repository.state[key].length,...snapshot[key]);throw error;}};
  const f=fixture({vitalService:{async recordCanonical(){throw Object.assign(new Error('invalid vital'),{code:'INVALID_VITAL'});}},transaction});repository=f.repository;await seed();
  await assert.rejects(f.service.recordNative({lineUserId:'U-STAFF',centerId:'CTR-A',residentId:'RES-A',occurredAt:'2026-08-27T01:00:00Z',items,vitalSigns:{observations:[]}}),{code:'INVALID_VITAL'});
  assert.equal(repository.state.reports.length,0);assert.equal(repository.state.items.length,0);
});

test('native writes reject cross-Center subject, revoked staff and disabled capability',async()=>{
  const f=fixture();await seed();
  await assert.rejects(f.service.recordNative({lineUserId:'U-STAFF',centerId:'CTR-A',residentId:'RES-B',occurredAt:'2026-08-27T01:00:00Z',items}),{code:'RESIDENT_NOT_READY'});
  await db.CenterStaff.update((row)=>row.staff_id==='STF-A',{status:'revoked'});
  await assert.rejects(f.service.recordNative({lineUserId:'U-STAFF',centerId:'CTR-A',residentId:'RES-A',occurredAt:'2026-08-27T01:00:00Z',items}),{code:'CENTER_ACCESS_DENIED'});
  const disabled=fixture({capability:false});await seed();
  await assert.rejects(disabled.service.recordNative({lineUserId:'U-STAFF',centerId:'CTR-A',residentId:'RES-A',occurredAt:'2026-08-27T01:00:00Z',items}),{code:'CAPABILITY_DISABLED'});
  await assert.rejects(disabled.service.recordCanonical(externalInput()),{code:'CAPABILITY_DISABLED'});
});

function externalInput(extra={}) {
  return {tenant:{organizationId:'ORG-A'},subject:{centerId:'CTR-A',residentId:'RES-A',careProfileId:'CP-A'},
    occurredAt:'2026-08-27T02:00:00Z',careDate:'2026-08-27',shift:{code:'day',sourceLabel:'D'},items,
    expectedLineGroupId:null,
    provenance:{sourceType:'external_integration',sourceSystem:'vendor_a',integrationClientId:'INT-A',externalRecordId:'EXT-D-1',
      externalStaffDisplayName:'ผู้ดูแลภายนอก',actorReference:'integration_client:INT-A',sourceRecordedAt:'2026-08-27T01:55:00Z',
      finalizedAt:'2026-08-27T02:00:00Z',finalizedByActorReference:'integration_client:INT-A',finalizerDisplayName:'ผู้จัดการภายนอก'},...extra};
}

test('external finalized snapshot is idempotent and mismatched client tenant is denied',async()=>{
  const{service,repository}=fixture();await seed();const input=externalInput();
  assert.equal((await service.recordCanonical(input)).duplicate,false);assert.equal((await service.recordCanonical(input)).duplicate,true);
  assert.equal(repository.state.reports.length,1);assert.equal(repository.state.reports[0].status,'finalized');
  await assert.rejects(service.recordCanonical({...input,provenance:{...input.provenance,integrationClientId:'INT-B',externalRecordId:'EXT-D-2'}}),{code:'INTEGRATION_TENANT_MISMATCH'});
});

test('external expected group is reconciled against the exact Care Profile binding and can be retried after binding correction',async()=>{
  const queued=[];
  const notifications=createFamilyCareNotificationService({CareProfiles:db.CareProfiles,GroupBindings:db.GroupBindings,
    enqueue:async(input)=>{queued.push(input);return{ok:true};}});
  const {service,repository}=fixture({familyNotifications:notifications});
  await seed();
  await db.CareProfiles.insert({care_profile_id:'CP-A',patient_name:'คุณยายเอ',owner_line_id:'U-OWNER',status:'active'});
  await db.GroupBindings.insert({binding_id:'GB-OTHER',kind:'family',care_profile_id:'CP-B',line_group_id:'G-EXPECTED',status:'active'});
  const first=await service.recordCanonical(externalInput({expectedLineGroupId:'G-EXPECTED'}));
  assert.equal(first.item.status,'finalized');assert.equal(repository.state.reports.length,1);
  assert.equal(first.notification.notificationStatus,'held_group_missing');assert.equal(queued.length,0);
  await db.GroupBindings.insert({binding_id:'GB-A',kind:'family',care_profile_id:'CP-A',line_group_id:'G-WRONG',status:'active'});
  const mismatch=await service.enqueueFinalizedNotificationByReport({dailyReportId:first.item.dailyReportId,expectedLineGroupId:'G-EXPECTED'});
  assert.equal(mismatch.notificationStatus,'held_group_mismatch');assert.equal(queued.length,0);
  await db.GroupBindings.update((row)=>row.binding_id==='GB-A',{line_group_id:'G-EXPECTED'});
  const matched=await service.enqueueFinalizedNotificationByReport({dailyReportId:first.item.dailyReportId,expectedLineGroupId:'G-EXPECTED'});
  assert.equal(matched.notificationStatus,'queued');assert.equal(matched.groupReconciliationStatus,'verified_match');
  assert.equal(queued.length,1);assert.equal(queued[0].to,'G-EXPECTED');
});

test('Manager return then staff correction creates a new submitted version without overwriting prior items',async()=>{
  const{service,repository}=fixture();await seed();
  const first=await service.recordNative({lineUserId:'U-STAFF',centerId:'CTR-A',residentId:'RES-A',occurredAt:'2026-08-27T01:00:00Z',items});
  await service.returnForCorrection({lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:first.item.dailyReportId,reason:'ตรวจจำนวนอาหารอีกครั้ง'});
  const revisedItems=[{itemType:'nutrition',valueType:'text',value:'รับประทานหมดจาน'}];
  const revised=await service.resubmitReport({lineUserId:'U-STAFF',centerId:'CTR-A',dailyReportId:first.item.dailyReportId,
    occurredAt:'2026-08-27T01:10:00Z',items:revisedItems});
  assert.equal(revised.item.status,'submitted');assert.equal(revised.item.versionNo,2);
  assert.equal(repository.state.reports[0].status,'changes_requested');assert.equal(repository.state.reports[1].supersedes_report_id,first.item.dailyReportId);
  assert.equal((await repository.listItems(first.item.dailyReportId))[0].text_value,'รับประทานอาหารได้ครึ่งจาน');
  await assert.rejects(service.resubmitReport({lineUserId:'U-STAFF',centerId:'CTR-A',dailyReportId:first.item.dailyReportId,
    occurredAt:'2026-08-27T01:20:00Z',items:revisedItems}),{code:'DAILY_REPORT_ALREADY_RESUBMITTED'});
});

test('Staff cannot finalize; Manager and Owner can finalize own Center idempotently with one deduped intent',async()=>{
  const seen=new Set();let calls=0;const family={async enqueueFinalized(input){calls++;const duplicate=seen.has(input.resourceId);seen.add(input.resourceId);return{ok:true,duplicate,groupReconciliationStatus:'no_expected_group'};}};
  const{service,repository}=fixture({familyNotifications:family});await seed();
  const submitted=await service.recordNative({lineUserId:'U-STAFF',centerId:'CTR-A',residentId:'RES-A',occurredAt:'2026-08-27T01:00:00Z',items});
  await assert.rejects(service.finalizeReport({lineUserId:'U-STAFF',centerId:'CTR-A',dailyReportId:submitted.item.dailyReportId}),{code:'CENTER_ACCESS_DENIED'});
  const first=await service.finalizeReport({lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:submitted.item.dailyReportId});
  const replay=await service.finalizeReport({lineUserId:'U-OWNER-CENTER',centerId:'CTR-A',dailyReportId:submitted.item.dailyReportId});
  assert.equal(first.item.status,'finalized');assert.equal(replay.duplicate,true);assert.equal(seen.size,1);assert.equal(calls,2);
  assert.equal(repository.state.events.filter((event)=>event.event_type==='finalized').length,1);
  await assert.rejects(service.finalizeReport({lineUserId:'U-MANAGER-B',centerId:'CTR-B',dailyReportId:submitted.item.dailyReportId}),{code:'DAILY_REPORT_NOT_FOUND'});
});

test('LINE/outbox enqueue failure never rolls back finalized canonical care',async()=>{
  const{service,repository}=fixture({familyNotifications:{async enqueueFinalized(){throw new Error('LINE unavailable clinical text');}}});await seed();
  const submitted=await service.recordNative({lineUserId:'U-STAFF',centerId:'CTR-A',residentId:'RES-A',occurredAt:'2026-08-27T01:00:00Z',items});
  const result=await service.finalizeReport({lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:submitted.item.dailyReportId});
  assert.equal(result.item.status,'finalized');assert.equal(result.notification.notificationStatus,'enqueue_failed');
  assert.equal(repository.state.reports[0].status,'finalized');
});

test('Family history is authorized, paginated and exposes finalized records only',async()=>{
  const{service}=fixture();await seed();const reports=[];
  for(let day=1;day<=3;day++)reports.push(await service.recordNative({lineUserId:'U-STAFF',centerId:'CTR-A',residentId:'RES-A',occurredAt:`2026-08-0${day}T01:00:00Z`,items}));
  assert.equal((await service.listHistory({lineUserId:'U-OWNER',careProfileId:'CP-A'})).items.length,0);
  for(const report of reports)await service.finalizeReport({lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:report.item.dailyReportId});
  const first=await service.listHistory({lineUserId:'U-OWNER',careProfileId:'CP-A',limit:2});assert.equal(first.items.length,2);assert.ok(first.nextCursor);assert.equal(first.items[0].centerName,'ศูนย์ A');
  assert.equal((await service.listHistory({lineUserId:'U-OWNER',careProfileId:'CP-A',limit:2,cursor:first.nextCursor})).items.length,1);
  await assert.rejects(service.listHistory({lineUserId:'U-X',careProfileId:'CP-A'}),{code:'FORBIDDEN'});
});

test('only the latest finalized Daily version is authoritative and void never resurrects an older version', async () => {
  const suppressed=[]; const family={
    async enqueueFinalized(){return {ok:true,groupReconciliationStatus:'no_expected_group'};},
    async suppressFinalized(input){suppressed.push(input);return {suppressed:1};},
  };
  const { service, repository } = fixture({ familyNotifications:family }); await seed();
  const first = await service.recordNative({
    lineUserId:'U-STAFF',centerId:'CTR-A',residentId:'RES-A',occurredAt:'2026-08-27T01:00:00Z',items,
  });
  await service.returnForCorrection({
    lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:first.item.dailyReportId,reason:'แก้ไข',
  });
  const second = await service.resubmitReport({
    lineUserId:'U-STAFF',centerId:'CTR-A',dailyReportId:first.item.dailyReportId,
    occurredAt:'2026-08-27T02:00:00Z',items,
  });
  await service.finalizeReport({
    lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:second.item.dailyReportId,
  });
  let history=await service.listHistory({lineUserId:'U-OWNER',careProfileId:'CP-A'});
  assert.deepEqual(history.items.map((item)=>item.versionNo),[2]);
  await service.voidReport({
    lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:second.item.dailyReportId,reason:'ยกเลิกฉบับแก้ไข',
  });
  await service.voidReport({
    lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:second.item.dailyReportId,reason:'retry',
  });
  history=await service.listHistory({lineUserId:'U-OWNER',careProfileId:'CP-A'});
  assert.equal(history.items.length,0); assert.equal(suppressed.length,1);
  assert.equal(repository.state.events.filter((event)=>event.daily_report_id===second.item.dailyReportId
    &&event.event_type==='voided').length,1);
  assert.equal(repository.state.events.some((event)=>/notification/i.test(event.event_type)),false);
});

test('finalized Daily correction creates one submitted V2 and preserves linked authority until finalization', async () => {
  let vitalSequence=0;
  const vitalService={async recordCanonical(input){vitalSequence+=1;return{duplicate:false,item:{vitalSetId:`VSET-${vitalSequence}`,
    status:'recorded',occurredAt:input.occurredAt,recordedAt:'2026-08-27T01:00:01Z',sourceType:input.provenance.sourceType,
    observations:input.observations.map((item)=>({...item,canonicalUnit:item.sourceUnit}))}};}};
  const {service,repository}=fixture({vitalService});await seed();
  const first=await service.recordNative({lineUserId:'U-STAFF',centerId:'CTR-A',residentId:'RES-A',
    occurredAt:'2026-08-27T01:00:00Z',items,vitalSigns:{occurredAt:'2026-08-27T01:00:00Z',observations:[
      {measurementType:'pulse',numericValue:72,sourceValueText:'72',sourceUnit:'/min'},
    ]}});
  await service.finalizeReport({lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:first.item.dailyReportId});
  await assert.rejects(service.createCorrectionVersion({lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:first.item.dailyReportId,reason:'   '}),{code:'CORRECTION_REASON_REQUIRED'});
  await assert.rejects(service.createCorrectionVersion({lineUserId:'U-STAFF',centerId:'CTR-A',dailyReportId:first.item.dailyReportId,reason:'แก้ไข'}),{code:'CENTER_ACCESS_DENIED'});
  const second=await service.createCorrectionVersion({lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:first.item.dailyReportId,reason:'แก้ค่าที่ตรวจพบ'});
  const replay=await service.createCorrectionVersion({lineUserId:'U-OWNER-CENTER',centerId:'CTR-A',dailyReportId:first.item.dailyReportId,reason:'retry'});
  assert.equal(second.item.status,'submitted');assert.equal(second.item.versionNo,2);assert.equal(second.item.vitalSigns.length,1);
  assert.equal(replay.duplicate,true);assert.equal(repository.state.reports.length,2);
  let history=await service.listHistory({lineUserId:'U-OWNER',careProfileId:'CP-A'});
  assert.deepEqual(history.items.map((item)=>[item.versionNo,item.vitalSigns[0].vitalSetId]),[[1,'VSET-1']]);
  const workflow=await service.listCenterWorkflow({lineUserId:'U-MANAGER',centerId:'CTR-A',status:'submitted'});
  assert.equal(workflow.items[0].mutationCapabilities.canVoid,false);
  await service.finalizeReport({lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:second.item.dailyReportId});
  history=await service.listHistory({lineUserId:'U-OWNER',careProfileId:'CP-A'});
  assert.deepEqual(history.items.map((item)=>[item.versionNo,item.vitalSigns[0].vitalSetId]),[[2,'VSET-2']]);
  const finalized=await service.listCenterWorkflow({lineUserId:'U-OWNER-CENTER',centerId:'CTR-A',status:'finalized'});
  assert.equal(finalized.items.find((item)=>item.versionNo===2).mutationCapabilities.canCreateCorrection,true);
  assert.equal(finalized.items.find((item)=>item.versionNo===1).mutationCapabilities.canCreateCorrection,false);
  await service.voidReport({lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:second.item.dailyReportId,reason:'ยกเลิกฉบับแก้ไข'});
  assert.equal((await service.listHistory({lineUserId:'U-OWNER',careProfileId:'CP-A'})).items.length,0);
});

test('Daily correction authority fails closed across Center and external provenance', async () => {
  const {service}=fixture();await seed();
  const local=await service.recordNative({lineUserId:'U-STAFF',centerId:'CTR-A',residentId:'RES-A',occurredAt:'2026-08-27T01:00:00Z',items});
  await service.finalizeReport({lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:local.item.dailyReportId});
  await assert.rejects(service.createCorrectionVersion({lineUserId:'U-MANAGER-B',centerId:'CTR-B',dailyReportId:local.item.dailyReportId,reason:'ข้ามศูนย์'}),{code:'DAILY_REPORT_NOT_FOUND'});
  const external=await service.recordCanonical(externalInput());
  await assert.rejects(service.createCorrectionVersion({lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:external.item.dailyReportId,reason:'local'}),{code:'EXTERNAL_RECORD_LOCAL_MUTATION_DENIED'});
  const projected=await service.listCenterWorkflow({lineUserId:'U-MANAGER',centerId:'CTR-A',status:'finalized'});
  assert.equal(projected.items.find((item)=>item.sourceType==='external_integration').mutationCapabilities.canVoid,false);
});

test('local mutation rejects external Daily Care while duplicate integration ingestion remains idempotent', async () => {
  const { service, repository }=fixture(); await seed();
  const first=await service.recordCanonical(externalInput());
  const duplicate=await service.recordCanonical(externalInput());
  await assert.rejects(service.voidReport({
    lineUserId:'U-MANAGER',centerId:'CTR-A',dailyReportId:first.item.dailyReportId,reason:'local',
  }),{code:'EXTERNAL_RECORD_LOCAL_MUTATION_DENIED'});
  assert.equal(duplicate.duplicate,true);assert.equal(repository.state.reports[0].status,'finalized');
});
