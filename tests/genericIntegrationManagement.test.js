process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../backend/db');
const { createPlatformService } = require('../backend/services/platformService');
const { createTenantResolver } = require('../backend/services/tenantResolver');
const { createMemoryPlatformRepository } = require('./helpers/platformMemoryRepository');
const ui = require('../liff-app/system-admin/care-operations-ui');

function transactionQueue() {
  const queues = new Map();
  return async (key, fn) => {
    const previous = queues.get(key) || Promise.resolve();
    let release; const gate = new Promise((resolve) => { release = resolve; });
    queues.set(key, previous.then(() => gate)); await previous;
    try { return await fn(); } finally { release(); }
  };
}

function fixture() {
  db.resetAll(); const repository = createMemoryPlatformRepository(); let seq = 0; let random = 0;
  const service = createPlatformService({ repository, withTransaction:transactionQueue(),
    idFactory:(prefix)=>`${prefix}-${++seq}`, randomBytes:(size)=>Buffer.alloc(size,++random),
    now:()=>new Date('2026-08-27T00:00:00.000Z') });
  return { service, repository };
}

async function setup() {
  const f = fixture();
  await db.Centers.insert({center_id:'CTR-A',name:'ศูนย์ตัวอย่าง A',status:'active'});
  await db.Centers.insert({center_id:'CTR-A2',name:'ศูนย์ตัวอย่าง A2',status:'active'});
  await db.Centers.insert({center_id:'CTR-B',name:'ศูนย์อื่น',status:'active'});
  const orgA = await f.service.createOrganization({organizationCode:'org-a',displayName:'องค์กรตัวอย่าง',actorReference:'ADM-1'});
  const orgB = await f.service.createOrganization({organizationCode:'org-b',displayName:'องค์กรอื่น',actorReference:'ADM-1'});
  await f.repository.linkCenter({organizationId:orgA.organizationId,centerId:'CTR-A',actorReference:'ADM-1'});
  await f.repository.linkCenter({organizationId:orgA.organizationId,centerId:'CTR-A2',actorReference:'ADM-1'});
  await f.repository.linkCenter({organizationId:orgB.organizationId,centerId:'CTR-B',actorReference:'ADM-1'});
  return {...f,orgA,orgB};
}

test('UI-created Integration Client is suspended while omitted initial status remains backward-compatible active', async()=>{
  const {service,orgA}=await setup();
  const managed=await service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'managed-client',displayName:'Managed Client',sourceSystem:'Generic Care',initialStatus:'suspended',actorReference:'ADM-1'});
  const legacy=await service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'legacy-client',displayName:'Legacy Client',sourceSystem:'Legacy',actorReference:'ADM-1'});
  assert.equal(managed.status,'suspended');assert.equal(legacy.status,'active');
});

test('client creation is bounded, normalized, unique, organization-scoped and rejects invalid status',async()=>{
  const {service,orgA}=await setup();
  await service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'vendor-a',displayName:'Vendor A',sourceSystem:'Vendor',initialStatus:'suspended',actorReference:'ADM-1'});
  await assert.rejects(service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'VENDOR-A',displayName:'Again',sourceSystem:'Vendor',actorReference:'ADM-1'}),{code:'CLIENT_CODE_EXISTS'});
  await assert.rejects(service.createIntegrationClient({organizationId:'ORG-NO',clientCode:'valid-code',displayName:'No',sourceSystem:'No',actorReference:'ADM-1'}),{code:'ORGANIZATION_NOT_FOUND'});
  await assert.rejects(service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'valid-code',displayName:'No',sourceSystem:'No',initialStatus:'revoked',actorReference:'ADM-1'}),{code:'INVALID_INITIAL_CLIENT_STATUS'});
});

test('active and suspended transitions preserve configuration while revoked is terminal',async()=>{
  const {service,repository,orgA}=await setup();
  const client=await service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'status-client',displayName:'Status',sourceSystem:'Generic',initialStatus:'suspended',actorReference:'ADM-1'});
  await service.addClientCenterScope({integrationClientId:client.integrationClientId,centerId:'CTR-A',actorReference:'ADM-1'});
  await service.addClientEventScope({integrationClientId:client.integrationClientId,eventType:'care.daily_report.finalized',actorReference:'ADM-1'});
  await service.issueCredential({integrationClientId:client.integrationClientId,actorReference:'ADM-1'});
  await service.mapExternalCenter({integrationClientId:client.integrationClientId,externalCenterId:'EXT-A',centerId:'CTR-A',actorReference:'ADM-1'});
  assert.equal((await service.setIntegrationClientStatus({integrationClientId:client.integrationClientId,status:'active',actorReference:'ADM-1'})).status,'active');
  assert.equal((await service.setIntegrationClientStatus({integrationClientId:client.integrationClientId,status:'suspended',actorReference:'ADM-1'})).status,'suspended');
  await service.revokeIntegrationClient({integrationClientId:client.integrationClientId,actorReference:'ADM-1'});
  await assert.rejects(service.setIntegrationClientStatus({integrationClientId:client.integrationClientId,status:'active',actorReference:'ADM-1'}),{code:'REVOKED_CLIENT_TERMINAL'});
  assert.ok(repository.state.auditEvents.some((row)=>row.event_type==='integration.client_status_changed'));
});

test('direct activation of an incomplete commissioned client is denied authoritatively',async()=>{
  const {service,orgA}=await setup();
  const client=await service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'not-ready',displayName:'Not Ready',sourceSystem:'Generic',initialStatus:'suspended',actorReference:'ADM-1'});
  await assert.rejects(service.setIntegrationClientStatus({integrationClientId:client.integrationClientId,status:'active',actorReference:'ADM-1'}),{
    code:'INTEGRATION_CLIENT_NOT_READY',status:409,
  });
  assert.equal((await service.inspectIntegrationClient(client.integrationClientId)).status,'suspended');
});

test('suspended clients can be commissioned but cannot authenticate until activated',async()=>{
  const {service,orgA}=await setup();
  const client=await service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'commissioning',displayName:'Commissioning',sourceSystem:'Generic',initialStatus:'suspended',actorReference:'ADM-1'});
  await service.addClientCenterScope({integrationClientId:client.integrationClientId,centerId:'CTR-A',actorReference:'ADM-1'});
  await service.addClientEventScope({integrationClientId:client.integrationClientId,eventType:'care.daily_report.finalized',actorReference:'ADM-1'});
  await service.mapExternalCenter({integrationClientId:client.integrationClientId,externalCenterId:'EXT-C',centerId:'CTR-A',actorReference:'ADM-1'});
  const issued=await service.issueCredential({integrationClientId:client.integrationClientId,actorReference:'ADM-1'});
  await assert.rejects(service.authenticateCredential(issued.token),{code:'INTEGRATION_CREDENTIAL_REVOKED'});
  await service.setIntegrationClientStatus({integrationClientId:client.integrationClientId,status:'active',actorReference:'ADM-1'});
  assert.equal((await service.authenticateCredential(issued.token)).integrationClientId,client.integrationClientId);
});

test('Center scopes are idempotent, removable and reject another Organization',async()=>{
  const {service,repository,orgA}=await setup();
  const client=await service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'center-scope',displayName:'Scopes',sourceSystem:'Generic',initialStatus:'suspended',actorReference:'ADM-1'});
  await service.addClientCenterScope({integrationClientId:client.integrationClientId,centerId:'CTR-A',actorReference:'ADM-1'});
  await service.addClientCenterScope({integrationClientId:client.integrationClientId,centerId:'CTR-A',actorReference:'ADM-1'});
  assert.equal(repository.state.clientCenters.length,1);
  await assert.rejects(service.addClientCenterScope({integrationClientId:client.integrationClientId,centerId:'CTR-B',actorReference:'ADM-1'}),{code:'CROSS_TENANT_CENTER'});
  await service.removeClientCenterScope({integrationClientId:client.integrationClientId,centerId:'CTR-A',actorReference:'ADM-1'});
  assert.equal(repository.state.clientCenters.length,0);
});

test('event scopes use the controlled allowlist and duplicate additions converge',async()=>{
  const {service,repository,orgA}=await setup();
  const client=await service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'event-scope',displayName:'Events',sourceSystem:'Generic',initialStatus:'suspended',actorReference:'ADM-1'});
  for(const eventType of ['care.daily_report.finalized','care.vitals.recorded'])await service.addClientEventScope({integrationClientId:client.integrationClientId,eventType,actorReference:'ADM-1'});
  await service.addClientEventScope({integrationClientId:client.integrationClientId,eventType:'care.vitals.recorded',actorReference:'ADM-1'});
  assert.equal(repository.state.eventScopes.length,2);
  await assert.rejects(service.addClientEventScope({integrationClientId:client.integrationClientId,eventType:'vendor.anything',actorReference:'ADM-1'}),{code:'UNKNOWN_EVENT_TYPE'});
  await service.removeClientEventScope({integrationClientId:client.integrationClientId,eventType:'care.vitals.recorded',actorReference:'ADM-1'});
  assert.deepEqual((await service.inspectIntegrationClient(client.integrationClientId)).eventScopes,['care.daily_report.finalized']);
});

test('credential issue, concurrent duplicate issue, rotate and revoke remain one-time and serialized',async()=>{
  const {service,repository,orgA}=await setup();
  const client=await service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'credentials',displayName:'Credentials',sourceSystem:'Generic',initialStatus:'suspended',actorReference:'ADM-1'});
  const results=await Promise.allSettled([service.issueCredential({integrationClientId:client.integrationClientId,actorReference:'ADM-1'}),service.issueCredential({integrationClientId:client.integrationClientId,actorReference:'ADM-1'})]);
  assert.deepEqual(results.map((result)=>result.status).sort(),['fulfilled','rejected']);
  const first=results.find((result)=>result.status==='fulfilled').value;
  assert.equal(repository.state.credentials.filter((row)=>row.status==='active').length,1);
  assert.doesNotMatch(JSON.stringify(await service.inspectIntegrationClient(client.integrationClientId)),/pim_int_|secret_hash|secret_salt/);
  const next=await service.rotateCredential({integrationClientId:client.integrationClientId,credentialId:first.credential.credentialId,actorReference:'ADM-1'});
  assert.match(next.token,/^pim_int_/);assert.equal(repository.state.credentials.filter((row)=>row.status==='active').length,1);
  await service.revokeCredential({integrationClientId:client.integrationClientId,credentialId:next.credential.credentialId,actorReference:'ADM-1'});
  assert.equal(repository.state.credentials.filter((row)=>row.status==='active').length,0);
  assert.doesNotMatch(JSON.stringify(repository.state.auditEvents),/pim_int_|secret_hash|secret_salt/);
});

test('external Center inventory is exact, scoped, searchable, paginated and retains inactive rows',async()=>{
  const {service,orgA}=await setup();
  const client=await service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'center-map',displayName:'Maps',sourceSystem:'Generic',initialStatus:'suspended',actorReference:'ADM-1'});
  await service.addClientCenterScope({integrationClientId:client.integrationClientId,centerId:'CTR-A',actorReference:'ADM-1'});
  await service.mapExternalCenter({integrationClientId:client.integrationClientId,externalCenterId:'BRANCH_EXACT',centerId:'CTR-A',actorReference:'ADM-1'});
  await assert.rejects(service.mapExternalCenter({integrationClientId:client.integrationClientId,externalCenterId:'BRANCH_OTHER',centerId:'CTR-B',actorReference:'ADM-1'}),{code:'CROSS_TENANT_CENTER_MAPPING'});
  let result=await service.listExternalCenterMappings(client.integrationClientId,{search:'EXACT',page:1,limit:1});
  assert.equal(result.pagination.total,1);assert.deepEqual(result.items.map((item)=>[item.externalCenterId,item.centerName,item.status]),[['BRANCH_EXACT','ศูนย์ตัวอย่าง A','active']]);
  await service.deactivateExternalCenterMapping({integrationClientId:client.integrationClientId,externalCenterId:'BRANCH_EXACT',actorReference:'ADM-1'});
  result=await service.listExternalCenterMappings(client.integrationClientId,{status:'inactive'});assert.equal(result.items[0].status,'inactive');
  assert.doesNotMatch(JSON.stringify(result),/credential|clinical|line_user/i);
});

test('proactive Resident mapping requires same active Center and Care Profile readiness',async()=>{
  const {service,orgA}=await setup();
  const client=await service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'resident-map',displayName:'Residents',sourceSystem:'Generic',initialStatus:'suspended',actorReference:'ADM-1'});
  await service.addClientCenterScope({integrationClientId:client.integrationClientId,centerId:'CTR-A',actorReference:'ADM-1'});
  await service.mapExternalCenter({integrationClientId:client.integrationClientId,externalCenterId:'EXT-A',centerId:'CTR-A',actorReference:'ADM-1'});
  await db.Residents.insert({resident_id:'RES-A',center_id:'CTR-A',care_profile_id:'CP-A',full_name:'ผู้พักตัวอย่าง',room:'A1',status:'active',phone:'080-secret',allergies:['secret']});
  await db.Residents.insert({resident_id:'RES-NO-CP',center_id:'CTR-A',care_profile_id:null,full_name:'ยังไม่พร้อม',status:'active'});
  await db.Residents.insert({resident_id:'RES-B',center_id:'CTR-B',care_profile_id:'CP-B',full_name:'ต่างศูนย์',status:'active'});
  await assert.rejects(service.mapExternalSubject({integrationClientId:client.integrationClientId,externalCenterId:'EXT-A',externalResidentId:'EXT-NO-CP',residentId:'RES-NO-CP',actorReference:'ADM-1'}),{code:'RESIDENT_CARE_PROFILE_NOT_READY'});
  await assert.rejects(service.mapExternalSubject({integrationClientId:client.integrationClientId,externalCenterId:'EXT-A',externalResidentId:'EXT-B',residentId:'RES-B',actorReference:'ADM-1'}),{code:'RESIDENT_NOT_IN_MAPPED_CENTER'});
  await service.mapExternalSubject({integrationClientId:client.integrationClientId,externalCenterId:'EXT-A',externalResidentId:'EXT-R',residentId:'RES-A',actorReference:'ADM-1'});
  let result=await service.listExternalSubjectMappings(client.integrationClientId,{search:'EXT-R'});
  assert.equal(result.items[0].residentDisplayName,'ผู้พักตัวอย่าง');assert.equal(result.items[0].careProfileReady,true);
  assert.doesNotMatch(JSON.stringify(result),/CP-A|080-secret|allerg|medication|vital|line_user/i);
  await service.deactivateExternalSubjectMapping({integrationClientId:client.integrationClientId,externalCenterId:'EXT-A',externalResidentId:'EXT-R',actorReference:'ADM-1'});
  result=await service.listExternalSubjectMappings(client.integrationClientId,{status:'inactive'});assert.equal(result.items[0].mappingStatus,'inactive');
});

test('readiness is derived from server configuration and does not replace authorization',async()=>{
  const {service,orgA}=await setup();
  const client=await service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'readiness',displayName:'Readiness',sourceSystem:'Generic',initialStatus:'suspended',actorReference:'ADM-1'});
  let detail=await service.inspectIntegrationClient(client.integrationClientId);assert.equal(detail.readiness.state,'suspended');assert.equal(detail.readiness.configurationComplete,false);
  await service.addClientCenterScope({integrationClientId:client.integrationClientId,centerId:'CTR-A',actorReference:'ADM-1'});
  await service.addClientEventScope({integrationClientId:client.integrationClientId,eventType:'care.daily_report.finalized',actorReference:'ADM-1'});
  await service.issueCredential({integrationClientId:client.integrationClientId,actorReference:'ADM-1'});
  await service.mapExternalCenter({integrationClientId:client.integrationClientId,externalCenterId:'EXT-C',centerId:'CTR-A',actorReference:'ADM-1'});
  detail=await service.inspectIntegrationClient(client.integrationClientId);assert.equal(detail.readiness.configurationComplete,true);assert.equal(detail.readiness.state,'suspended');
  await service.setIntegrationClientStatus({integrationClientId:client.integrationClientId,status:'active',actorReference:'ADM-1'});
  detail=await service.inspectIntegrationClient(client.integrationClientId);assert.equal(detail.readiness.state,'ready');assert.equal(detail.readiness.checks.externalResidentMapping,false);
});

test('tenant resolver revalidates suspended client before target authorization',async()=>{
  const {service,repository,orgA}=await setup();
  const client=await service.createIntegrationClient({organizationId:orgA.organizationId,clientCode:'race-client',displayName:'Race',sourceSystem:'Generic',actorReference:'ADM-1'});
  await service.addClientCenterScope({integrationClientId:client.integrationClientId,centerId:'CTR-A',actorReference:'ADM-1'});await service.addClientEventScope({integrationClientId:client.integrationClientId,eventType:'care.vitals.recorded',actorReference:'ADM-1'});await service.mapExternalCenter({integrationClientId:client.integrationClientId,externalCenterId:'EXT-C',centerId:'CTR-A',actorReference:'ADM-1'});
  const identity={integrationClientId:client.integrationClientId,organizationId:orgA.organizationId,sourceSystem:'Generic',credentialId:'INTK-X'};
  await service.setIntegrationClientStatus({integrationClientId:client.integrationClientId,status:'suspended',actorReference:'ADM-1'});
  const resolver=createTenantResolver({platformService:service,repository});
  await assert.rejects(resolver.authorizeResolvedIntegrationTarget({identity,eventType:'care.vitals.recorded',externalCenterId:'EXT-C'}),{code:'INTEGRATION_CLIENT_INACTIVE'});
});

test('generic commissioning UI builders are exact, safe, and one-time secret state clears',()=>{
  const created=ui.buildCreateClientRequest({organizationId:'ORG A',clientCode:' Vendor Pilot ',displayName:'Vendor Pilot',sourceSystem:'Vendor'});
  assert.equal(created.path,'/api/admin/platform/organizations/ORG%20A/integration-clients');assert.equal(JSON.parse(created.options.body).initialStatus,'suspended');
  assert.deepEqual(ui.SUPPORTED_EVENT_TYPES,['care.daily_report.finalized','care.vitals.recorded']);
  assert.equal(ui.buildClientStatusRequest('INT A','active').options.method,'PATCH');
  assert.match(ui.buildCenterMappingListRequest('INT A',{page:2,search:'BRANCH'}).path,/page=2/);
  assert.match(ui.buildSubjectMappingRequest('INT','EXT/C','RES X','PH-R').path,/external-centers\/EXT%2FC\/subjects\/RES%20X/);
  const secret=ui.createOneTimeSecretState();assert.equal(secret.show('pim_int_test.secret'),true);assert.equal(secret.hasValue(),true);secret.clear();assert.equal(secret.read(),null);
  const source=fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','care-operations-ui.js'),'utf8');
  assert.doesNotMatch(source,/localStorage|sessionStorage|console\./);assert.match(source,/pagehide/);assert.match(source,/ฉันบันทึกแล้ว/);
  assert.match(ui.buildIntegrationDirectoryRequest({search:'HHS',status:'suspended',page:2,limit:20}).path,/integration-clients\?search=HHS&status=suspended&page=2&limit=20/);
});
