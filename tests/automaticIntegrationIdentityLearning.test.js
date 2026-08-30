process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const db=require('../backend/db');
const {createPlatformService}=require('../backend/services/platformService');
const {createTenantResolver}=require('../backend/services/tenantResolver');
const {createIntegrationIdentityResolutionService}=require('../backend/services/integrationIdentityResolutionService');
const {createIntegrationIdentityPolicyService}=require('../backend/services/integrationIdentityPolicyService');
const {createIntegrationEventService}=require('../backend/services/integrationEventService');
const {createPlatformRepository}=require('../backend/services/platformRepository');
const {createMemoryPlatformRepository}=require('./helpers/platformMemoryRepository');
const {createIntegrationEventMemoryRepository}=require('./helpers/integrationEventMemoryRepository');
const {normalizeIdentityName,normalizedSubjectName,ignoredProjection,
  IGNORED_INTEGRATION_STATUSES}=require('../backend/domain/integrationIdentity');
const {GROUP_BINDING_TRANSACTION_KEY}=require('../backend/services/groupBindingRepository');

async function fixture({policy={identityResolutionMode:'exact_name_learning',unresolvedEventPolicy:'ignore',familyGroupRequirement:'required_before_ingest'}}={}){
  db.resetAll();const repository=createMemoryPlatformRepository();let seq=0;
  const policies=createIntegrationIdentityPolicyService({AuditLog:db.AuditLog,withTransaction:db.withTransaction,idFactory:p=>`${p}-${++seq}`,now:()=>new Date('2026-08-30T01:00:00Z').toISOString()});
  const platform=createPlatformService({repository,integrationIdentityPolicyService:policies,idFactory:p=>`${p}-${++seq}`,withTransaction:db.withTransaction,now:()=>new Date('2026-08-30T01:00:00Z')});
  for(const center of [{center_id:'CTR-A',name:'ศูนย์สระบุรี',status:'active'},{center_id:'CTR-B',name:'ศูนย์ดอนเมือง',status:'active'},{center_id:'CTR-X',name:'ศูนย์ต่างองค์กร',status:'active'}])await db.Centers.insert(center);
  const org=await platform.createOrganization({organizationCode:'pilot-org',displayName:'Pilot Org',actorReference:'ADM-1'});
  const other=await platform.createOrganization({organizationCode:'other-org',displayName:'Other Org',actorReference:'ADM-1'});
  await repository.linkCenter({organizationId:org.organizationId,centerId:'CTR-A',actorReference:'ADM-1'});
  await repository.linkCenter({organizationId:org.organizationId,centerId:'CTR-B',actorReference:'ADM-1'});
  await repository.linkCenter({organizationId:other.organizationId,centerId:'CTR-X',actorReference:'ADM-1'});
  const client=await platform.createIntegrationClient({organizationId:org.organizationId,clientCode:'pilot-client',displayName:'Pilot Client',sourceSystem:'Generic Pilot',actorReference:'ADM-1'});
  for(const centerId of ['CTR-A','CTR-B']){await platform.addClientCenterScope({integrationClientId:client.integrationClientId,centerId,actorReference:'ADM-1'});await platform.setCenterCapability({centerId,capabilityKey:'vital_signs_v1',enabled:true,actorReference:'ADM-1'});await platform.setCenterCapability({centerId,capabilityKey:'daily_care_v1',enabled:true,actorReference:'ADM-1'});}
  await platform.addClientEventScope({integrationClientId:client.integrationClientId,eventType:'care.vitals.recorded',actorReference:'ADM-1'});
  await platform.addClientEventScope({integrationClientId:client.integrationClientId,eventType:'care.daily_report.finalized',actorReference:'ADM-1'});
  await platform.setIdentityResolutionPolicy({integrationClientId:client.integrationClientId,policy,actorReference:'ADM-1'});
  const identity={integrationClientId:client.integrationClientId,organizationId:org.organizationId,sourceSystem:'Generic Pilot',credentialId:'CRED-1'};
  const tenant=createTenantResolver({platformService:platform,repository});
  const resolution=createIntegrationIdentityResolutionService({platformService:platform,repository,tenantResolver:tenant,integrationIdentityPolicyService:policies,CareProfiles:db.CareProfiles,Residents:db.Residents,Centers:db.Centers,GroupBindings:db.GroupBindings});
  async function person({centerId='CTR-A',residentId='RES-A',profileId='CP-A',name='สมใจ ใจดี',status='active',group=true}={}){await db.CareProfiles.insert({care_profile_id:profileId,patient_name:name,status:'center_managed'});await db.Residents.insert({resident_id:residentId,center_id:centerId,care_profile_id:profileId,status,full_name:name,room:'A201'});if(group)await db.GroupBindings.insert({binding_id:`GB-${profileId}`,kind:'family',care_profile_id:profileId,line_group_id:`G-${profileId}`,status:'active'});return{residentId,profileId};}
  return{repository,policies,platform,resolution,identity,client,org,person};
}
const subject=(overrides={})=>({externalCenterId:'EXT-C',externalResidentId:'EXT-R',firstName:'สมใจ',lastName:'ใจดี',room:'A201',...overrides});

test('name normalization is Unicode-safe, whitespace-collapsed, Latin case-insensitive and Thai exact',()=>{
  assert.equal(normalizeIdentityName('  SOMJAI   JAIDEE '),'somjai jaidee');
  assert.equal(normalizedSubjectName({firstName:' สมใจ ',lastName:' ใจดี '}).comparisonKey,'สมใจ ใจดี');
  assert.notEqual(normalizeIdentityName('สมใจ ใจดี'),normalizeIdentityName('สมจัย ใจดี'));
});

test('every intentional ignored outcome has the bounded non-accepted and non-stored contract',()=>{
  assert.equal(IGNORED_INTEGRATION_STATUSES.length,9);
  for(const status of IGNORED_INTEGRATION_STATUSES){
    assert.deepEqual(ignoredProjection(status),{status,accepted:false,stored:false});
  }
});

test('unique exact name learns Center and Resident mappings with learned inventory source',async()=>{const f=await fixture();await f.person();const result=await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject()});assert.equal(result.action,'process');assert.equal(result.learned,true);assert.equal(result.tenant.centerId,'CTR-A');assert.equal(result.subject.residentId,'RES-A');assert.equal(f.repository.state.centerMappings.length,1);assert.equal(f.repository.state.subjectMappings.length,1);assert.equal((await f.platform.listExternalCenterMappings(f.client.integrationClientId)).items[0].mappingSource,'learned_automatically');assert.equal((await f.platform.listExternalSubjectMappings(f.client.integrationClientId)).items[0].mappingSource,'learned_automatically');});

test('learned mapping is authoritative after display-name and room drift and never remaps',async()=>{const f=await fixture();await f.person();await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject()});await f.person({centerId:'CTR-B',residentId:'RES-B',profileId:'CP-B',name:'ชื่อใหม่ คนใหม่'});const result=await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject({firstName:'ชื่อใหม่',lastName:'คนใหม่',room:'ZZZ'})});assert.equal(result.subject.residentId,'RES-A');assert.equal(f.repository.state.subjectMappings.length,1);assert.equal(f.repository.state.subjectMappings[0].resident_id,'RES-A');});

test('existing Center mapping narrows automatic search to its authoritative Center',async()=>{const f=await fixture();await f.person({centerId:'CTR-B',residentId:'RES-B',profileId:'CP-B'});await f.platform.mapExternalCenter({integrationClientId:f.client.integrationClientId,externalCenterId:'EXT-C',centerId:'CTR-A',actorReference:'ADM-1'});const result=await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject()});assert.equal(result.result.status,'ignored_subject_unresolved');assert.equal(f.repository.state.subjectMappings.length,0);});

test('zero exact match is ignored with bounded metric and no mapping',async()=>{const f=await fixture();await f.person({name:'คนละ ชื่อ'});const result=await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject()});assert.deepEqual(result.result,{status:'ignored_subject_unresolved',accepted:false,stored:false});assert.equal(f.repository.state.centerMappings.length,0);assert.equal((await f.policies.getMetrics(f.client.integrationClientId)).ignored_subject_unresolved,1);});

test('missing first/last identity is ignored and displayName alone is not used',async()=>{const f=await fixture();await f.person();const result=await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject({firstName:null,lastName:null,displayName:'สมใจ ใจดี'})});assert.equal(result.result.status,'ignored_subject_name_missing');});

test('room, alias, phone and fuzzy near-match never resolve identity',async()=>{const f=await fixture();await db.CareProfiles.insert({care_profile_id:'CP-A',patient_name:'สมจัย ใจดี',aliases:['สมใจ ใจดี'],phone:'0800000000'});await db.Residents.insert({resident_id:'RES-A',center_id:'CTR-A',care_profile_id:'CP-A',status:'active',room:'A201'});await db.GroupBindings.insert({binding_id:'GB-A',kind:'family',care_profile_id:'CP-A',line_group_id:'G-A',status:'active'});const result=await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject({room:'A201',phone:'0800000000'})});assert.equal(result.result.status,'ignored_subject_unresolved');});

test('two exact candidates are ignored and one deduped non-clinical alert is updated',async()=>{const f=await fixture();await f.person();await f.person({centerId:'CTR-B',residentId:'RES-B',profileId:'CP-B'});for(let i=0;i<2;i++){const result=await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject()});assert.equal(result.result.status,'ignored_subject_ambiguous');}const alerts=await f.policies.listAlerts({});assert.equal(alerts.items.length,1);assert.equal(alerts.items[0].occurrenceCount,2);assert.deepEqual(alerts.items[0].candidateCenterNames,['ศูนย์ดอนเมือง','ศูนย์สระบุรี']);const raw=JSON.stringify(await db.AuditLog.findAll());assert.doesNotMatch(raw,/observations|care_items|symptom|line_group|credential|numericValue/);});

test('strict group policy ignores missing or inactive binding while optional policy preserves eligibility',async()=>{let f=await fixture();await f.person({group:false});let result=await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject()});assert.equal(result.result.status,'ignored_family_group_not_bound');f=await fixture({policy:{identityResolutionMode:'exact_name_learning',unresolvedEventPolicy:'ignore',familyGroupRequirement:'optional_for_ingest'}});await f.person({group:false});result=await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject()});assert.equal(result.action,'process');});

test('mapped inactive Resident and invalid Care Profile relationship fail closed without name fallback',async()=>{const f=await fixture();await f.person();await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject()});await db.Residents.update((row)=>row.resident_id==='RES-A',{status:'discharged'});let result=await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject({firstName:'อื่น',lastName:'คน'})});assert.equal(result.result.status,'ignored_resident_inactive');await db.Residents.update((row)=>row.resident_id==='RES-A',{status:'active',care_profile_id:'CP-OTHER'});result=await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject()});assert.equal(result.result.status,'ignored_care_profile_not_ready');});

test('manual-only legacy client remains pending-compatible and never auto-learns',async()=>{const f=await fixture({policy:{identityResolutionMode:'manual_mapping_only',unresolvedEventPolicy:'pending_subject_mapping',familyGroupRequirement:'optional_for_ingest'}});await f.person();await f.platform.mapExternalCenter({integrationClientId:f.client.integrationClientId,externalCenterId:'EXT-C',centerId:'CTR-A',actorReference:'ADM-1'});const result=await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject()});assert.equal(result.action,'legacy');assert.equal(f.repository.state.subjectMappings.length,0);});

test('cross-Organization candidate is never searched',async()=>{const f=await fixture();await db.CareProfiles.insert({care_profile_id:'CP-X',patient_name:'สมใจ ใจดี'});await db.Residents.insert({resident_id:'RES-X',center_id:'CTR-X',care_profile_id:'CP-X',status:'active'});await db.GroupBindings.insert({binding_id:'GB-X',kind:'family',care_profile_id:'CP-X',line_group_id:'G-X',status:'active'});const result=await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject()});assert.equal(result.result.status,'ignored_subject_unresolved');});

test('concurrent first events converge to one Center mapping and one Resident mapping',async()=>{const f=await fixture();await f.person();const calls=Array.from({length:6},()=>f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject()}));const results=await Promise.all(calls);assert.ok(results.every((item)=>item.action==='process'));assert.equal(f.repository.state.centerMappings.length,1);assert.equal(f.repository.state.subjectMappings.length,1);assert.equal(new Set(f.repository.state.subjectMappings.map((item)=>item.resident_id)).size,1);});

test('ignored event returns no inbox, canonical Vital or notification and processed event stores once',async()=>{const f=await fixture();await f.person({name:'คนละ ชื่อ'});const eventRepo=createIntegrationEventMemoryRepository();let vitals=0;const service=createIntegrationEventService({repository:eventRepo,platformService:f.platform,tenantResolver:createTenantResolver({platformService:f.platform,repository:f.repository}),identityResolutionService:f.resolution,integrationIdentityPolicyService:f.policies,vitalSignService:{async recordCanonical(){vitals++;return{item:{vitalSetId:'VSET-1'}}}},dailyCareService:{},withTransaction:db.withTransaction,withTransactionLocks:db.withTransactionLocks,idFactory:()=>`IEVT-${eventRepo.state.events.length+1}`});const input={schemaVersion:'1.0',eventId:'EV-1',eventType:'care.vitals.recorded',occurredAt:'2026-08-30T01:00:00Z',subject:subject(),recorder:{displayName:'ผู้ดูแล'},data:{observations:[{measurementType:'pulse',numericValue:72,sourceUnit:'bpm'}]}};let result=await service.ingest({identity:f.identity,input});assert.equal(result.status,'ignored_subject_unresolved');assert.equal(eventRepo.state.events.length,0);assert.equal(vitals,0);await db.CareProfiles.update((row)=>row.care_profile_id==='CP-A',{patient_name:'สมใจ ใจดี'});result=await service.ingest({identity:f.identity,input:{...input,eventId:'EV-2'}});assert.equal(result.status,'processed');assert.equal(eventRepo.state.events.length,1);assert.equal(vitals,1);});

test('ignored finalized Daily payload is absent from inbox, audit, alerts, notifications and pending state',async()=>{
  const f=await fixture();await f.person({name:'คนละ ชื่อ'});const eventRepo=createIntegrationEventMemoryRepository();let dailyCalls=0;
  const service=createIntegrationEventService({repository:eventRepo,platformService:f.platform,
    tenantResolver:createTenantResolver({platformService:f.platform,repository:f.repository}),identityResolutionService:f.resolution,
    integrationIdentityPolicyService:f.policies,vitalSignService:{},dailyCareService:{async recordCanonical(){dailyCalls++;}},
    withTransaction:db.withTransaction,withTransactionLocks:db.withTransactionLocks,idFactory:()=>`IEVT-${eventRepo.state.events.length+1}`});
  const marker='PRIVATE_SYMPTOM_MARKER_9f2c';const input={schemaVersion:'1.0',eventId:'EV-PRIVATE',eventType:'care.daily_report.finalized',occurredAt:'2026-08-30T01:00:00Z',subject:{...subject(),expectedLineGroupId:'G-UNTRUSTED'},data:{externalRecordId:'REC-PRIVATE',careDate:'2026-08-30',shift:{code:'day',sourceLabel:'D'},observations:[{measurementType:'spo2',numericValue:97,sourceUnit:'%'}],careItems:[{itemType:'symptom_note',valueType:'text',value:marker}],recordedBy:{displayName:'ผู้ดูแล'},finalizedBy:{displayName:'ผู้จัดการ'},recordedAt:'2026-08-30T00:55:00Z',finalizedAt:'2026-08-30T01:00:00Z'}};
  const result=await service.ingest({identity:f.identity,input});assert.equal(result.status,'ignored_subject_unresolved');
  assert.equal(eventRepo.state.events.length,0);assert.equal(dailyCalls,0);assert.equal(f.repository.state.subjectMappings.length,0);
  assert.equal((await db.NotificationOutbox.findAll()).length,0);
  const retained=JSON.stringify({audit:await db.AuditLog.findAll(),platformAudit:f.repository.state.auditEvents});
  assert.doesNotMatch(retained,new RegExp(`${marker}|REC-PRIVATE|G-UNTRUSTED|spo2|symptom_note`));
});

test('Center-scope removal contends with first-event learning and cannot leave an out-of-scope learned mapping',async()=>{
  const f=await fixture();await f.person();const eventRepo=createIntegrationEventMemoryRepository();let entered;let release;
  const enteredPromise=new Promise(resolve=>{entered=resolve});const releasePromise=new Promise(resolve=>{release=resolve});
  const guardedResolution={resolve:async(args)=>{entered();await releasePromise;return f.resolution.resolve(args)}};
  let canonical=0;const service=createIntegrationEventService({repository:eventRepo,platformService:f.platform,
    tenantResolver:createTenantResolver({platformService:f.platform,repository:f.repository}),identityResolutionService:guardedResolution,
    integrationIdentityPolicyService:f.policies,vitalSignService:{async recordCanonical(){canonical++;return{item:{vitalSetId:'VSET-RACE'}}}},
    dailyCareService:{},withTransaction:db.withTransaction,withTransactionLocks:db.withTransactionLocks,idFactory:()=>`IEVT-${eventRepo.state.events.length+1}`});
  const input={schemaVersion:'1.0',eventId:'EV-SCOPE-RACE',eventType:'care.vitals.recorded',occurredAt:'2026-08-30T01:00:00Z',subject:subject(),recorder:{displayName:'ผู้ดูแล'},data:{observations:[{measurementType:'pulse',numericValue:72,sourceUnit:'bpm'}]}};
  const ingest=service.ingest({identity:f.identity,input});await enteredPromise;
  const removal=f.platform.removeClientCenterScope({integrationClientId:f.client.integrationClientId,centerId:'CTR-A',actorReference:'ADM-1'});
  release();const [ingested,removed]=await Promise.allSettled([ingest,removal]);
  assert.equal(ingested.status,'fulfilled');assert.equal(ingested.value.status,'processed');assert.equal(canonical,1);
  assert.equal(removed.status,'rejected');assert.equal(removed.reason.code,'CENTER_SCOPE_HAS_MAPPING');
  assert.equal(await f.repository.hasClientCenterScope(f.client.integrationClientId,'CTR-A'),true);
  assert.equal(f.repository.state.centerMappings.length,1);assert.equal(f.repository.state.subjectMappings.length,1);
});

test('concurrent manual Center mapping wins its shared identity lock and automatic learning never overwrites it',async()=>{
  const f=await fixture();await f.person();const eventRepo=createIntegrationEventMemoryRepository();let canonical=0;
  const service=createIntegrationEventService({repository:eventRepo,platformService:f.platform,
    tenantResolver:createTenantResolver({platformService:f.platform,repository:f.repository}),identityResolutionService:f.resolution,
    integrationIdentityPolicyService:f.policies,vitalSignService:{async recordCanonical(){canonical++;return{item:{vitalSetId:'VSET-MAP'}}}},
    dailyCareService:{},withTransaction:db.withTransaction,withTransactionLocks:db.withTransactionLocks,idFactory:()=>`IEVT-${eventRepo.state.events.length+1}`});
  const input={schemaVersion:'1.0',eventId:'EV-MAPPING-RACE',eventType:'care.vitals.recorded',occurredAt:'2026-08-30T01:00:00Z',subject:subject(),recorder:{displayName:'ผู้ดูแล'},data:{observations:[{measurementType:'pulse',numericValue:72,sourceUnit:'bpm'}]}};
  let ingest;await db.withTransaction(`integration-center-mapping:${f.client.integrationClientId}:EXT-C`,async()=>{
    ingest=service.ingest({identity:f.identity,input});await new Promise(resolve=>setImmediate(resolve));
    await f.repository.upsertExternalCenterMapping({mappingId:'ECM-MANUAL',integrationClientId:f.client.integrationClientId,
      organizationId:f.org.organizationId,externalCenterId:'EXT-C',centerId:'CTR-B',displayName:null});
  });
  const result=await ingest;assert.equal(result.status,'ignored_subject_unresolved');assert.equal(result.stored,false);
  assert.equal(f.repository.state.centerMappings.length,1);assert.equal(f.repository.state.centerMappings[0].center_id,'CTR-B');
  assert.equal(f.repository.state.subjectMappings.length,0);assert.equal(eventRepo.state.events.length,0);assert.equal(canonical,0);
});

test('strict first-event learning waits for GroupBinding mutation and ignores after binding is removed',async()=>{
  const f=await fixture();await f.person();const eventRepo=createIntegrationEventMemoryRepository();let canonical=0;
  const service=createIntegrationEventService({repository:eventRepo,platformService:f.platform,
    tenantResolver:createTenantResolver({platformService:f.platform,repository:f.repository}),identityResolutionService:f.resolution,
    integrationIdentityPolicyService:f.policies,vitalSignService:{async recordCanonical(){canonical++;return{item:{vitalSetId:'VSET-GROUP'}}}},
    dailyCareService:{},withTransaction:db.withTransaction,withTransactionLocks:db.withTransactionLocks,idFactory:()=>`IEVT-${eventRepo.state.events.length+1}`});
  const input={schemaVersion:'1.0',eventId:'EV-GROUP-RACE',eventType:'care.vitals.recorded',occurredAt:'2026-08-30T01:00:00Z',subject:subject(),recorder:{displayName:'ผู้ดูแล'},data:{observations:[{measurementType:'pulse',numericValue:72,sourceUnit:'bpm'}]}};
  let ingest;await db.withTransaction(GROUP_BINDING_TRANSACTION_KEY,async()=>{
    ingest=service.ingest({identity:f.identity,input});await new Promise(resolve=>setImmediate(resolve));
    await db.GroupBindings.update((row)=>row.binding_id==='GB-CP-A',{status:'inactive'});
  });
  const result=await ingest;assert.equal(result.status,'ignored_family_group_not_bound');assert.equal(result.stored,false);
  assert.equal(eventRepo.state.events.length,0);assert.equal(f.repository.state.centerMappings.length,0);
  assert.equal(f.repository.state.subjectMappings.length,0);assert.equal(canonical,0);
});

test('candidate relationship is row-locked and revalidated before learned mappings are written',async()=>{
  const f=await fixture();await f.person();let locked=0;
  f.repository.lockIdentityLearningCandidate=async()=>{
    locked++;await db.CareProfiles.update((row)=>row.care_profile_id==='CP-A',{patient_name:'ชื่อเปลี่ยน ระหว่างทำรายการ'});
    return true;
  };
  const result=await f.resolution.resolve({identity:f.identity,eventType:'care.vitals.recorded',subject:subject()});
  assert.equal(locked,1);assert.equal(result.result.status,'ignored_mapping_conflict');
  assert.equal(f.repository.state.centerMappings.length,0);assert.equal(f.repository.state.subjectMappings.length,0);
});

test('production candidate lock targets Center, Care Profile and Resident rows with FOR UPDATE',async()=>{
  const calls=[];const repository=createPlatformRepository({queryFn:async(sql,params)=>{calls.push({sql,params});return{rows:[{id:'safe-row'}]}}});
  assert.equal(await repository.lockIdentityLearningCandidate({centerId:'CTR-A',residentId:'RES-A',careProfileId:'CP-A'}),true);
  assert.equal(calls.length,3);assert.ok(calls.every((call)=>/FOR UPDATE/.test(call.sql)));
  assert.deepEqual(calls.map((call)=>call.params[0]),['CTR-A','CP-A','RES-A']);
});

test('Center capability removal contends with first-event commit and prevents canonical ingestion',async()=>{
  const f=await fixture();await f.person();const eventRepo=createIntegrationEventMemoryRepository();let canonical=0;
  const service=createIntegrationEventService({repository:eventRepo,platformService:f.platform,
    tenantResolver:createTenantResolver({platformService:f.platform,repository:f.repository}),identityResolutionService:f.resolution,
    integrationIdentityPolicyService:f.policies,vitalSignService:{async recordCanonical(){canonical++;return{item:{vitalSetId:'VSET-CAP'}}}},
    dailyCareService:{},withTransaction:db.withTransaction,withTransactionLocks:db.withTransactionLocks,idFactory:()=>`IEVT-${eventRepo.state.events.length+1}`});
  const input={schemaVersion:'1.0',eventId:'EV-CAP-RACE',eventType:'care.vitals.recorded',occurredAt:'2026-08-30T01:00:00Z',subject:subject(),recorder:{displayName:'ผู้ดูแล'},data:{observations:[{measurementType:'pulse',numericValue:72,sourceUnit:'bpm'}]}};
  let ingest;await db.withTransaction('platform-center:CTR-A',async()=>{
    ingest=service.ingest({identity:f.identity,input});await new Promise(resolve=>setImmediate(resolve));
    await f.repository.upsertCapability({centerId:'CTR-A',capabilityKey:'vital_signs_v1',enabled:false,actorReference:'ADM-1'});
  });
  const result=await ingest;assert.equal(result.status,'ignored_center_not_commissioned');assert.equal(result.stored,false);
  assert.equal(eventRepo.state.events.length,0);assert.equal(f.repository.state.centerMappings.length,0);
  assert.equal(f.repository.state.subjectMappings.length,0);assert.equal(canonical,0);
});

test('policy, alerts and safe metrics are bounded System Admin projections',async()=>{const f=await fixture();const detail=await f.platform.inspectIntegrationClient(f.client.integrationClientId);assert.equal(detail.identityResolutionPolicy.identityResolutionMode,'exact_name_learning');assert.deepEqual(Object.keys(detail.operationalCounts).sort(),['ignored_care_profile_not_ready','ignored_center_not_commissioned','ignored_client_scope_mismatch','ignored_family_group_not_bound','ignored_mapping_conflict','ignored_resident_inactive','ignored_subject_ambiguous','ignored_subject_name_missing','ignored_subject_unresolved','processed'].sort());await assert.rejects(f.platform.setIdentityResolutionPolicy({integrationClientId:f.client.integrationClientId,policy:{identityResolutionMode:'fuzzy',unresolvedEventPolicy:'ignore',familyGroupRequirement:'required_before_ingest'},actorReference:'ADM-1'}),{code:'INVALID_IDENTITY_RESOLUTION_POLICY'});});
