process.env.NODE_ENV='test';
process.env.ADMIN_API_KEY='integration-control-admin-key';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {flowForEvent,mappingProjection,identityProjection,historyQuery,historyProjection,createIntegrationControlCenterService}=require('../backend/services/integrationControlCenterService');
const {createIntegrationControlCenterRepository}=require('../backend/services/integrationControlCenterRepository');
const ui=require('../liff-app/system-admin/care-operations-ui.js');

const baseRow={integration_event_id:'IEVT-PRIVATE-123456',integration_client_id:'INT-A',
  event_type:'care.daily_report.finalized',status:'processed',resident_id:'RES-A',care_profile_id:'CP-A',
  canonical_resource_type:'daily_care_report',canonical_resource_id:'DCR-A',pending_reason:null,last_error_code:null,
  verified_line_group_id:'C-SECRET-GROUP',group_reconciliation_status:'verified_match',notification_intent_status:'queued',
  attempt_count:1,created_at:'2026-09-01T01:00:00Z',updated_at:'2026-09-01T01:01:00Z',processed_at:'2026-09-01T01:01:00Z'};

test('latest flow uses only persisted evidence and never calls queued notification delivered',()=>{
  const flow=flowForEvent(baseRow);
  assert.equal(flow.stages.find((item)=>item.key==='persistence').state,'completed');
  assert.equal(flow.stages.find((item)=>item.key==='transform').state,'unknown');
  assert.equal(flow.stages.find((item)=>item.key==='notification').state,'current');
  assert.match(flow.stages.find((item)=>item.key==='notification').detail,/สร้างคิวแล้ว/);
  assert.doesNotMatch(JSON.stringify(flow),/ส่งถึงผู้รับแล้ว|C-SECRET-GROUP|RES-A|CP-A|DCR-A/);
  assert.equal(flow.latestEvent.safeReference,'เหตุการณ์ ••••123456');
});

test('pending subject highlights resident mapping and blocks downstream success',()=>{
  const flow=flowForEvent({...baseRow,status:'pending',resident_id:null,care_profile_id:null,
    canonical_resource_id:null,pending_reason:'subject_mapping',processed_at:null,
    verified_line_group_id:null,group_reconciliation_status:null,notification_intent_status:null});
  assert.equal(flow.attention.stage,'resident');
  assert.equal(flow.stages.find((item)=>item.key==='resident').state,'attention');
  assert.equal(flow.stages.find((item)=>item.key==='care_profile').state,'waiting');
  assert.equal(flow.stages.find((item)=>item.key==='persistence').state,'waiting');
});

test('overview is bounded and performs one latest-event lookup for the page',async()=>{
  const calls=[];
  const service=createIntegrationControlCenterService({
    platformService:{async listIntegrationClientDirectory(input){calls.push(['directory',input]);return{items:[{integrationClientId:'INT-A',displayName:'ระบบตัวอย่าง',status:'active'}],pagination:{page:1,limit:20,total:1,totalPages:1}};}},
    eventRepository:{async listLatestForClients(ids){calls.push(['events',ids]);return[baseRow];}},
  });
  const result=await service.overview({limit:500,view:'current'});
  assert.deepEqual(calls.map((item)=>item[0]),['directory','events']);
  assert.equal(calls[0][1].limit,50);
  assert.deepEqual(calls[1][1],['INT-A']);
  assert.equal(result.items[0].latestEvent.safeReference,'เหตุการณ์ ••••123456');
  assert.doesNotMatch(JSON.stringify(result),/C-SECRET-GROUP|canonical_payload|medical|patient/);
});

test('System Admin overview route is authorized by the existing admin boundary',async()=>{
  const app=require('../backend/server');
  app.locals.integrationControlCenterService={async overview(){return{items:[],pagination:{page:1,limit:20,total:0,totalPages:0},refreshedAt:'2026-09-01T00:00:00Z'};},async mappingInspector(){return{mappingMode:'canonical_contract',mappings:[]};},async identityInspector(){return{items:[],pagination:{page:1,limit:20,total:0,totalPages:0}};},async history(){return{items:[],pagination:{page:1,limit:20,total:0,totalPages:0}};},async historyDetail(){return{item:{}};}};
  const server=http.createServer(app);await new Promise((resolve)=>server.listen(0,resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/admin/platform/integration-control/overview`;
  try{
    let response=await fetch(url);assert.equal(response.status,401);
    response=await fetch(url,{headers:{'X-Admin-Key':'integration-control-admin-key'}});assert.equal(response.status,200);
    assert.deepEqual((await response.json()).items,[]);
    const mappingUrl=`http://127.0.0.1:${server.address().port}/api/admin/platform/integration-clients/INT-A/control/mapping`;
    response=await fetch(mappingUrl);assert.equal(response.status,401);
    response=await fetch(mappingUrl,{headers:{'X-Admin-Key':'integration-control-admin-key'}});assert.equal(response.status,200);
    assert.equal((await response.json()).mappingMode,'canonical_contract');
    const identityUrl=`http://127.0.0.1:${server.address().port}/api/admin/platform/integration-clients/INT-A/control/identities`;
    response=await fetch(identityUrl);assert.equal(response.status,401);
    response=await fetch(identityUrl,{headers:{'X-Admin-Key':'integration-control-admin-key'}});assert.equal(response.status,200);
    const historyUrl=`http://127.0.0.1:${server.address().port}/api/admin/platform/integration-control/history`;
    response=await fetch(historyUrl);assert.equal(response.status,401);
    response=await fetch(historyUrl,{headers:{'X-Admin-Key':'integration-control-admin-key'}});assert.equal(response.status,200);
  }finally{delete app.locals.integrationControlCenterService;await new Promise((resolve)=>server.close(resolve));}
});

test('System Admin UI exposes bounded overview request and evidence wording',()=>{
  const descriptor=ui.buildIntegrationOverviewRequest({search:'HHS',status:'active',page:2,limit:20});
  assert.match(descriptor.path,/integration-control\/overview\?/);
  assert.match(descriptor.path,/search=HHS/);assert.match(descriptor.path,/limit=20/);
  const source=require('node:fs').readFileSync(require('node:path').resolve(__dirname,'../liff-app/system-admin/care-operations-ui.js'),'utf8');
  assert.match(source,/เส้นทางข้อมูลล่าสุด/);assert.match(source,/ตรวจสอบรายละเอียด/);
  assert.match(source,/“สร้างคิวแล้ว” ไม่ได้หมายความว่า LINE ส่งถึงผู้รับแล้ว/);
  assert.doesNotMatch(source,/setInterval\s*\(/);
});

test('field mapping projection reads adapter rules without sample values or raw locators',()=>{
  const result=mappingProjection({display_name:'Generic Daily',source_system_label:'Vendor',target_event_type:'care.daily_report.finalized',
    version:3,version_status:'active',activated_at:'2026-09-01T00:00:00Z',mapping_rules:[
      {targetField:'subject.externalCenterId',transform:'identifier',locators:[{kind:'object_path',path:['branch','code']}]},
      {targetField:'vitals.temperature',transform:'number',locators:[{kind:'array_match',arrayPath:['observations'],where:{field:'type',equals:'temperature'},valuePath:['value']}]},
    ]});
  assert.equal(result.mappingMode,'adapter');assert.equal(result.activeAdapter.version,3);
  assert.deepEqual(result.mappings.map((item)=>item.sourcePaths[0]),['branch.code','observations[type=temperature].value']);
  assert.equal(result.mappings[0].required,true);assert.equal(result.mappings[1].phimorLabel,'อุณหภูมิ');
  assert.doesNotMatch(JSON.stringify(result),/patient|sample_payload|valuePreview|raw/i);
});

test('canonical passthrough reports an explicit empty mapping configuration',()=>{
  const result=mappingProjection(null);assert.equal(result.mappingMode,'canonical_contract');
  assert.deepEqual(result.mappings,[]);assert.match(result.message,/canonical contract/);
});

test('mapping inspector is one bounded binding lookup and returns safe client context',async()=>{
  const calls=[];const service=createIntegrationControlCenterService({
    platformService:{async inspectIntegrationClient(id){calls.push(['client',id]);return{integrationClientId:id,displayName:'Vendor',sourceSystem:'Generic',status:'active'};}},
    eventRepository:{},adapterRepository:{async findActiveBinding(id,type){calls.push(['binding',id,type]);return null;}},
  });
  const result=await service.mappingInspector({integrationClientId:'INT-A'});
  assert.deepEqual(calls.map((entry)=>entry[0]),['client','binding']);assert.equal(result.mappingMode,'canonical_contract');
  assert.deepEqual(Object.keys(result.integrationClient),['integrationClientId','displayName','sourceSystem','status']);
});

test('mapping inspector UI uses a read-only purpose-specific endpoint',()=>{
  const descriptor=ui.buildIntegrationMappingInspectorRequest('INT/A');
  assert.equal(descriptor.path,'/api/admin/platform/integration-clients/INT%2FA/control/mapping');
  assert.equal(descriptor.options.method,'GET');
  const source=require('node:fs').readFileSync(require('node:path').resolve(__dirname,'../liff-app/system-admin/care-operations-ui.js'),'utf8');
  assert.match(source,/ดูการจับคู่ข้อมูล/);assert.match(source,/ไม่แสดงค่าตัวอย่างจาก event/);
  assert.doesNotMatch(source,/control\/mapping[^\n]+method:'(?:POST|PUT|PATCH|DELETE)'/);
});

test('resolved identity projection uses persisted mapping origin and current relationship state',()=>{
  const result=identityProjection({row_id:'ESM-PRIVATE-123456',row_kind:'mapping',external_center_id:'EXT-C',external_resident_id:'EXT-R',mapping_status:'mapped',mapping_source:'learned_automatically',center_mapping_status:'active',center_name:'ศูนย์ตัวอย่าง',resident_status:'active',resident_name:'ผู้พักตัวอย่าง',room:'A1',care_profile_ready:true,family_destination_ready:true,last_seen_at:'2026-09-01T00:00:00Z'});
  assert.equal(result.matchMethod,'learned');assert.equal(result.center.state,'resolved');assert.equal(result.resident.state,'resolved');assert.equal(result.careProfile.state,'resolved');assert.equal(result.familyDestination.state,'resolved');
  assert.doesNotMatch(JSON.stringify(result),/ESM-PRIVATE|care_profile_id|line_group_id/i);
});

test('legacy, unresolved, ambiguous and missing destination states never infer success',()=>{
  const legacy=identityProjection({row_id:'ESM-1',row_kind:'mapping',mapping_status:'mapped',mapping_source:null,center_mapping_status:'active',center_name:'ศูนย์',resident_status:'active',resident_name:'ผู้พัก',care_profile_ready:true,family_destination_ready:false});
  assert.equal(legacy.matchMethod,'unknown');assert.equal(legacy.familyDestination.state,'missing');
  const unresolved=identityProjection({row_id:'ESM-2',row_kind:'mapping',mapping_status:'pending_subject_mapping',external_center_id:'EXT-C',external_resident_id:'EXT-R'});
  assert.equal(unresolved.matchMethod,'unresolved');assert.equal(unresolved.resident.state,'unresolved');
  const ambiguous=identityProjection({row_id:'ALERT-1',row_kind:'ambiguity',mapping_status:'ambiguous',candidate_count:2});
  assert.equal(ambiguous.mappingStatus,'ambiguous');assert.equal(ambiguous.ambiguity.candidateCount,2);assert.notEqual(ambiguous.resident.state,'resolved');
});

test('identity inspector pagination is bounded and query is server-side without N+1',async()=>{
  const calls=[];const row={row_id:'ESM-1',row_kind:'mapping',mapping_status:'mapped'};
  const service=createIntegrationControlCenterService({platformService:{async inspectIntegrationClient(id){return{integrationClientId:id,displayName:'Vendor',sourceSystem:'Generic'};}},eventRepository:{},adapterRepository:{},controlRepository:{async listIdentityChains(q){calls.push(['list',q]);return[row];},async countIdentityChains(q){calls.push(['count',q]);return{total:1};}}});
  const result=await service.identityInspector({integrationClientId:'INT-A',page:2,limit:500});
  assert.equal(result.pagination.limit,50);assert.equal(calls[0][1].offset,50);assert.deepEqual(calls.map((item)=>item[0]).sort(),['count','list']);
});

test('identity repository uses bounded SQL joins and never selects clinical payload or LINE destination',async()=>{
  const calls=[];const repository=createIntegrationControlCenterRepository({queryFn:async(sql,params)=>{calls.push({sql,params});return{rows:sql.includes('COUNT(*)')?[{total:0}]:[]};}});
  await repository.listIdentityChains({integrationClientId:'INT-A',limit:20,offset:0});await repository.countIdentityChains({integrationClientId:'INT-A'});
  assert.equal(calls.length,2);assert.match(calls[0].sql,/LIMIT \$3 OFFSET \$4/);assert.match(calls[0].sql,/external_subject_mappings/);assert.match(calls[0].sql,/groupBindings/);
  assert.doesNotMatch(calls[0].sql,/canonical_payload|line_group_id|patient_name|medication|lab/i);
});

test('identity inspector UI request is read-only and bounded',()=>{
  const descriptor=ui.buildIntegrationIdentityInspectorRequest('INT/A',{page:3,limit:20});
  assert.match(descriptor.path,/INT%2FA\/control\/identities\?/);assert.match(descriptor.path,/page=3/);assert.match(descriptor.path,/limit=20/);assert.equal(descriptor.options.method,'GET');
});

test('history query is server bounded and accepts only exact operational filters',()=>{
  const query=historyQuery({integrationClientId:'INT-A',status:'dead',category:'notification',from:'2026-09-01',to:'2026-09-02',reference:'เหตุการณ์ ••••ABC123',page:2,limit:500});
  assert.equal(query.limit,50);assert.equal(query.offset,50);assert.equal(query.referenceSuffix,'ABC123');assert.match(query.from,/T17:00:00\.000Z$/);assert.match(query.to,/T17:00:00\.000Z$/);
  assert.throws(()=>historyQuery({status:'unknown'}),/สถานะ/);assert.throws(()=>historyQuery({reference:'free text payload search'}),/อ้างอิง/);
});

test('history detail separates queued, provider accepted, retrying and dead-letter evidence',()=>{
  const sent=historyProjection({...baseRow,integration_name:'Vendor',source_system:'Generic',notification_delivery_status:'sent',delivery_attempts:1,provider_acceptance:'accepted'},{detail:true});
  assert.equal(sent.notification.providerAccepted,true);assert.match(sent.notification.providerStateLabel,/ผู้ให้บริการรับคำขอส่งแล้ว/);assert.doesNotMatch(JSON.stringify(sent),/ส่งถึงผู้รับแล้ว|C-SECRET-GROUP|RES-A|CP-A|DCR-A/);
  assert.equal(sent.detail.technical.adapterEvidence,'unavailable_for_event');assert.equal(sent.detail.technical.adapterVersion,null);
  const retry=historyProjection({...baseRow,notification_delivery_status:'retrying',delivery_attempts:2,delivery_error_code:'LINE_DELIVERY_FAILED'});
  assert.equal(retry.notification.status,'retrying');assert.match(retry.nextOperatorAction,/งานต้องตรวจ/);
  const dead=historyProjection({...baseRow,notification_delivery_status:'dead_letter',delivery_attempts:5});assert.equal(dead.notification.status,'dead_letter');assert.match(dead.notification.providerStateLabel,/หยุดลองส่ง/);
});

test('history repository filters and paginates in SQL without raw payload or destination',async()=>{
  const calls=[];const repository=createIntegrationControlCenterRepository({queryFn:async(sql,params)=>{calls.push({sql,params});return{rows:sql.includes('COUNT(*)')?[{total:0}]:[]};}});
  const query={integrationClientId:'INT-A',status:'rejected',from:null,to:null,category:'processing',referenceSuffix:'ABC123',limit:20,offset:0};
  await repository.listHistory(query);await repository.countHistory(query);
  assert.match(calls[0].sql,/LIMIT \$7 OFFSET \$8/);assert.match(calls[0].sql,/notificationOutbox/);assert.match(calls[0].sql,/RIGHT\(e\.integration_event_id,6\)/);
  assert.match(calls[0].sql,/verified_line_group_id IS NOT NULL/);
  assert.doesNotMatch(calls[0].sql,/canonical_payload|data->>'to'|messages|patient_name|general_report/i);
});

test('history service returns a bounded page and one safe detail projection',async()=>{
  const calls=[];const control={async listHistory(q){calls.push(['list',q]);return[{...baseRow,integration_name:'Vendor'}];},async countHistory(q){calls.push(['count',q]);return{total:1};},async findHistoryEvent(key){calls.push(['detail',key]);return{...baseRow,integration_name:'Vendor'};}};
  const service=createIntegrationControlCenterService({platformService:{},eventRepository:{},adapterRepository:{},controlRepository:control});
  const page=await service.history({page:1,limit:100});assert.equal(page.pagination.limit,50);assert.equal(page.items.length,1);
  const detail=await service.historyDetail({eventKey:'IEVT-123'});assert.ok(detail.item.detail);assert.deepEqual(calls.map((item)=>item[0]).sort(),['count','detail','list']);
});

test('history UI contracts are read-only, paginated, and expose no recovery request',()=>{
  const list=ui.buildIntegrationHistoryRequest({status:'retrying',page:2,limit:20,reference:'ABC123'});assert.match(list.path,/integration-control\/history\?/);assert.match(list.path,/page=2/);assert.equal(list.options.method,'GET');
  const detail=ui.buildIntegrationHistoryDetailRequest('IEVT/A');assert.equal(detail.path,'/api/admin/platform/integration-control/history/IEVT%2FA');assert.equal(detail.options.method,'GET');
  const source=require('node:fs').readFileSync(require('node:path').resolve(__dirname,'../liff-app/system-admin/care-operations-ui.js'),'utf8');assert.match(source,/ประวัติเหตุการณ์/);assert.match(source,/ไม่มีคำสั่งส่งซ้ำ/);assert.doesNotMatch(source,/integration-control\/history[^\n]+method:'(?:POST|PUT|PATCH|DELETE)'/);
});

test('synthetic cross-flow matrix highlights only the stage supported by persisted evidence',()=>{
  const stageState=(flow,key)=>flow.stages.find((item)=>item.key===key)?.state;
  const success=historyProjection({...baseRow,notification_delivery_status:'sent',delivery_attempts:1,provider_acceptance:'accepted'},{detail:true});
  assert.equal(success.problemStage,null);assert.equal(stageState({stages:success.detail.stages},'persistence'),'completed');assert.equal(stageState({stages:success.detail.stages},'notification'),'completed');
  assert.match(success.notification.providerStateLabel,/ผู้ให้บริการรับคำขอส่งแล้ว/);assert.doesNotMatch(JSON.stringify(success),/ส่งถึงผู้รับแล้ว/);

  const rejected=historyProjection({...baseRow,status:'rejected',resident_id:null,care_profile_id:null,canonical_resource_id:null,last_error_code:'INVALID_FINALIZED_RECORD',notification_intent_status:null,notification_delivery_status:null},{detail:true});
  assert.equal(rejected.problemStage,'persistence');assert.equal(stageState({stages:rejected.detail.stages},'persistence'),'failed');assert.match(rejected.nextOperatorAction,/ตรวจรหัสสาเหตุ/);

  const noCenterRecord=flowForEvent(null);assert.equal(noCenterRecord.latestEvent,null);assert.equal(stageState(noCenterRecord,'receive'),'waiting');assert.notEqual(stageState(noCenterRecord,'center'),'completed');
  const unresolved=flowForEvent({...baseRow,status:'pending',resident_id:null,care_profile_id:null,canonical_resource_id:null,pending_reason:'subject_mapping',processed_at:null,notification_intent_status:null,verified_line_group_id:null});
  assert.equal(unresolved.attention.stage,'resident');assert.equal(stageState(unresolved,'resident'),'attention');assert.notEqual(stageState(unresolved,'persistence'),'completed');

  const missingProfile=historyProjection({...baseRow,status:'rejected',care_profile_id:null,canonical_resource_id:null,last_error_code:'CARE_PROFILE_RELATIONSHIP_INVALID',notification_intent_status:null,notification_delivery_status:null},{detail:true});
  assert.equal(missingProfile.problemStage,'care_profile');assert.equal(stageState({stages:missingProfile.detail.stages},'care_profile'),'failed');assert.equal(stageState({stages:missingProfile.detail.stages},'persistence'),'waiting');
  const missingDestination=historyProjection({...baseRow,verified_line_group_id:null,family_destination_verified:false,group_reconciliation_status:'group_binding_missing',notification_intent_status:'held_group_missing'},{detail:true});
  assert.equal(missingDestination.problemStage,'family_destination');assert.equal(missingDestination.familyDestination.state,'attention');assert.match(missingDestination.nextOperatorAction,/GroupBinding/);
  for(const delivery of ['retrying','dead_letter']){const item=historyProjection({...baseRow,notification_delivery_status:delivery,delivery_attempts:delivery==='retrying'?2:5},{detail:true});assert.equal(item.problemStage,'notification');assert.match(item.nextOperatorAction,/งานต้องตรวจ/);}

  const legacy=historyProjection({integration_event_id:'IEVT-LEGACY-000001',integration_client_id:'INT-LEGACY',event_type:'care.daily_report.finalized',status:'processed',created_at:'2026-09-01T01:00:00Z'},{detail:true});
  assert.equal(stageState({stages:legacy.detail.stages},'transform'),'unknown');assert.equal(stageState({stages:legacy.detail.stages},'persistence'),'unknown');assert.equal(legacy.identity.residentState,'unknown');assert.equal(legacy.familyDestination.state,'unknown');assert.equal(legacy.detail.technical.adapterEvidence,'unavailable_for_event');
  assert.equal(legacy.detail.technical.idempotencyEvidence,'event_id_unique_but_duplicate_receipt_count_not_persisted');
});

test('synthetic identity ambiguity and HHS-equivalent resolution never mislabel field mapping or LINE delivery',()=>{
  const ambiguous=identityProjection({row_id:'ALERT-SYNTHETIC-000001',row_kind:'ambiguity',mapping_status:'ambiguous',candidate_count:2,external_center_id:'SYNTH-CENTER',external_resident_id:'SYNTH-SUBJECT'});
  assert.equal(ambiguous.mappingStatus,'ambiguous');assert.equal(ambiguous.resident.state,'unresolved');assert.equal(ambiguous.careProfile.state,'unresolved');

  const before=flowForEvent({...baseRow,integration_event_id:'IEVT-SYNTHETIC-BEFORE',status:'pending',resident_id:null,care_profile_id:null,canonical_resource_id:null,pending_reason:'subject_mapping',processed_at:null,verified_line_group_id:null,group_reconciliation_status:null,notification_intent_status:null});
  assert.equal(before.attention.stage,'resident');assert.equal(before.stages.find((item)=>item.key==='transform').state,'unknown');assert.equal(before.stages.find((item)=>item.key==='notification').state,'waiting');
  assert.doesNotMatch(JSON.stringify(before),/จับคู่ field ไม่สำเร็จ|LINE ล้มเหลว/);

  const after=flowForEvent({...baseRow,integration_event_id:'IEVT-SYNTHETIC-AFTER',notification_delivery_status:'pending',delivery_attempts:0});
  assert.equal(after.attention,null);assert.equal(after.stages.find((item)=>item.key==='resident').state,'completed');assert.equal(after.stages.find((item)=>item.key==='care_profile').state,'completed');assert.equal(after.stages.find((item)=>item.key==='family_destination').state,'completed');assert.equal(after.stages.find((item)=>item.key==='notification').state,'current');
  assert.match(after.stages.find((item)=>item.key==='notification').detail,/ยังไม่ใช่หลักฐานว่าส่งถึงผู้รับ/);
});
