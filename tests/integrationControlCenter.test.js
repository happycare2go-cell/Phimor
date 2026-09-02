process.env.NODE_ENV='test';
process.env.ADMIN_API_KEY='integration-control-admin-key';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {flowForEvent,mappingProjection,createIntegrationControlCenterService}=require('../backend/services/integrationControlCenterService');
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
  app.locals.integrationControlCenterService={async overview(){return{items:[],pagination:{page:1,limit:20,total:0,totalPages:0},refreshedAt:'2026-09-01T00:00:00Z'};},async mappingInspector(){return{mappingMode:'canonical_contract',mappings:[]};}};
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
