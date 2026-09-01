process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const db=require('../backend/db');
const {createPlatformService}=require('../backend/services/platformService');
const {createPlatformRepository}=require('../backend/services/platformRepository');
const {createMemoryPlatformRepository}=require('./helpers/platformMemoryRepository');

function fixture(){
  db.resetAll();const repository=createMemoryPlatformRepository();let sequence=0;
  const service=createPlatformService({repository,idFactory:(prefix)=>`${prefix}-${++sequence}`,
    randomBytes:(size)=>Buffer.alloc(size,sequence+1),withTransaction:async(_key,fn)=>fn(),
    now:()=>new Date('2026-09-01T09:00:00.000Z')});
  return{repository,service};
}

async function setupDirectory(){
  const f=fixture();
  await db.Centers.insert({center_id:'CTR-A',name:'ศูนย์ตัวอย่าง',status:'active'});
  const organization=await f.service.createOrganization({organizationCode:'archive-org',displayName:'Archive Organization',actorReference:'ADM-1'});
  await f.repository.linkCenter({organizationId:organization.organizationId,centerId:'CTR-A',actorReference:'ADM-1'});
  const active=await f.service.createIntegrationClient({organizationId:organization.organizationId,clientCode:'alpha-current',displayName:'Alpha Current',sourceSystem:'Current Vendor',actorReference:'ADM-1'});
  const suspended=await f.service.createIntegrationClient({organizationId:organization.organizationId,clientCode:'beta-suspended',displayName:'Beta Suspended',sourceSystem:'Paused Vendor',initialStatus:'suspended',actorReference:'ADM-1'});
  const archived=await f.service.createIntegrationClient({organizationId:organization.organizationId,clientCode:'gamma-archive',displayName:'Gamma Archive',sourceSystem:'Historic Vendor',initialStatus:'suspended',actorReference:'ADM-1'});
  await f.service.addClientCenterScope({integrationClientId:archived.integrationClientId,centerId:'CTR-A',actorReference:'ADM-1'});
  await f.service.addClientEventScope({integrationClientId:archived.integrationClientId,eventType:'care.daily_report.finalized',actorReference:'ADM-1'});
  const credential=await f.service.issueCredential({integrationClientId:archived.integrationClientId,actorReference:'ADM-1'});
  await f.service.mapExternalCenter({integrationClientId:archived.integrationClientId,externalCenterId:'EXT-C',centerId:'CTR-A',actorReference:'ADM-1'});
  await db.Residents.insert({resident_id:'RES-A',center_id:'CTR-A',care_profile_id:'CP-A',full_name:'ผู้พักตัวอย่าง',status:'active'});
  await f.service.mapExternalSubject({integrationClientId:archived.integrationClientId,externalCenterId:'EXT-C',externalResidentId:'EXT-R',residentId:'RES-A',actorReference:'ADM-1'});
  f.repository.state.integrationEvents.push({integration_event_id:'IEVT-HISTORY',integration_client_id:archived.integrationClientId,status:'processed'});
  const auditCountBeforeRevoke=f.repository.state.auditEvents.length;
  await f.service.revokeIntegrationClient({integrationClientId:archived.integrationClientId,actorReference:'ADM-REVOKER'});
  return{...f,active,suspended,archived,credential,auditCountBeforeRevoke};
}

test('current and archived directories are server-enforced, searchable and paginated independently',async()=>{
  const {service,active,suspended,archived}=await setupDirectory();
  const current=await service.listIntegrationClientDirectory({view:'current',page:1,limit:1});
  assert.equal(current.pagination.total,2);assert.equal(current.pagination.totalPages,2);
  const currentAll=await service.listIntegrationClientDirectory({view:'current',page:1,limit:20});
  assert.deepEqual(new Set(currentAll.items.map((item)=>item.integrationClientId)),new Set([active.integrationClientId,suspended.integrationClientId]));
  assert.equal(currentAll.items.some((item)=>item.integrationClientId===archived.integrationClientId),false);
  const history=await service.listIntegrationClientDirectory({view:'archived',page:1,limit:20});
  assert.deepEqual(history.items.map((item)=>item.integrationClientId),[archived.integrationClientId]);
  assert.equal(history.items[0].status,'revoked');assert.ok(history.items[0].revokedAt);
  assert.equal((await service.listIntegrationClientDirectory({view:'current',search:'Historic'})).pagination.total,0);
  assert.equal((await service.listIntegrationClientDirectory({view:'archived',search:'Current'})).pagination.total,0);
  assert.equal((await service.listIntegrationClientDirectory()).pagination.total,3,'legacy unfiltered caller remains backward compatible');
  await assert.rejects(service.listIntegrationClientDirectory({view:'current',status:'revoked'}),{code:'INVALID_INTEGRATION_DIRECTORY_FILTER'});
  await assert.rejects(service.listIntegrationClientDirectory({view:'archived',status:'active'}),{code:'INVALID_INTEGRATION_DIRECTORY_FILTER'});
});

test('revocation preserves client, credential metadata, mappings, event and audit history while blocking authentication and mutation',async()=>{
  const {service,repository,archived,credential,auditCountBeforeRevoke}=await setupDirectory();
  const clientId=archived.integrationClientId;
  const stored=repository.state.clients.find((row)=>row.integration_client_id===clientId);
  assert.equal(stored.status,'revoked');assert.ok(stored.revoked_at);
  assert.equal(repository.state.credentials.filter((row)=>row.integration_client_id===clientId).length,1);
  assert.equal(repository.state.credentials[0].status,'revoked');assert.ok(repository.state.credentials[0].revoked_at);
  assert.equal(repository.state.centerMappings.find((row)=>row.integration_client_id===clientId).status,'active');
  assert.equal(repository.state.subjectMappings.find((row)=>row.integration_client_id===clientId).mapping_status,'mapped');
  assert.equal(repository.state.integrationEvents.find((row)=>row.integration_client_id===clientId).status,'processed');
  assert.ok(repository.state.auditEvents.length>auditCountBeforeRevoke);
  const audit=repository.state.auditEvents.find((row)=>row.event_type==='integration.client_revoked');
  assert.equal(audit.integration_client_id,clientId);assert.equal(audit.metadata.previousStatus,'suspended');assert.ok(audit.metadata.revokedAt);
  assert.doesNotMatch(JSON.stringify(audit),/pim_int_|secret_hash|secret_salt/);
  await assert.rejects(service.authenticateCredential(credential.token),{code:'INTEGRATION_CREDENTIAL_REVOKED'});
  await assert.rejects(service.setIntegrationClientStatus({integrationClientId:clientId,status:'active',actorReference:'ADM-1'}),{code:'REVOKED_CLIENT_TERMINAL'});
  const guarded=[
    service.removeClientCenterScope({integrationClientId:clientId,centerId:'CTR-A',actorReference:'ADM-1'}),
    service.removeClientEventScope({integrationClientId:clientId,eventType:'care.daily_report.finalized',actorReference:'ADM-1'}),
    service.revokeCredential({integrationClientId:clientId,credentialId:credential.credential.credentialId,actorReference:'ADM-1'}),
    service.deactivateExternalCenterMapping({integrationClientId:clientId,externalCenterId:'EXT-C',actorReference:'ADM-1'}),
    service.deactivateExternalSubjectMapping({integrationClientId:clientId,externalCenterId:'EXT-C',externalResidentId:'EXT-R',actorReference:'ADM-1'}),
  ];
  const results=await Promise.allSettled(guarded);assert.ok(results.every((result)=>result.status==='rejected'&&result.reason.code==='INTEGRATION_CLIENT_REVOKED'));
  const detail=await service.inspectIntegrationClient(clientId);
  assert.equal(detail.status,'revoked');assert.equal(detail.credentials.length,1);assert.equal(detail.mappingCounts.centers,1);assert.equal(detail.mappingCounts.residents,1);
  assert.equal((await service.listExternalCenterMappings(clientId)).items.length,1);
  assert.equal((await service.listExternalSubjectMappings(clientId)).items.length,1);
});

test('PostgreSQL directory query keeps legacy all-status behavior and binds current/archive view as typed parameters',async()=>{
  const calls=[];const repository=createPlatformRepository({queryFn:async(sql,params)=>{calls.push({sql,params});return{rows:[]};}});
  await repository.listIntegrationClientDirectory({search:'Vendor',view:'current',limit:20,offset:0});
  await repository.countIntegrationClientDirectory({search:'Vendor',view:'archived'});
  assert.deepEqual(calls[0].params,['Vendor',null,'current',20,0]);assert.deepEqual(calls[1].params,['Vendor',null,'archived']);
  assert.match(calls[0].sql,/\$3::text = 'current'/);assert.match(calls[0].sql,/c\.status IN \('active','suspended'\)/);
  assert.match(calls[0].sql,/\$3::text = 'archived'/);assert.match(calls[0].sql,/c\.status = 'revoked'/);
});
