const {id,withTransaction}=require('../db');
const {tenantResolver}=require('./tenantResolver');const {platformService}=require('./platformService');
const {vitalSignService}=require('./vitalSignService');const {dailyCareService}=require('./dailyCareService');
const {createIntegrationEventRepository}=require('./integrationEventRepository');
const {IntegrationEventError,normalizeEnvelope}=require('../domain/integrationEvents');
const MAX_ATTEMPTS=5;
function projection(row,{duplicate=false}={}){const status=row.status==='pending'&&row.pending_reason==='subject_mapping'?'pending_subject_mapping':row.status;return{eventId:row.external_event_id,eventType:row.event_type,status,
  duplicate,canonicalResource:row.status==='processed'?{type:row.canonical_resource_type,id:row.canonical_resource_id}:null,
  pendingReason:row.status==='pending'?row.pending_reason:null};}
function deterministic(error){return error instanceof IntegrationEventError||(Number(error?.status)>=400&&Number(error?.status)<500);}
function errorCode(error){const clean=String(error?.code||'INTEGRATION_PROCESSING_FAILED').replace(/[^A-Z0-9_:-]/gi,'_').slice(0,100);return clean||'INTEGRATION_PROCESSING_FAILED';}
function createIntegrationEventService(overrides={}){const repository=overrides.repository||createIntegrationEventRepository();const resolver=overrides.tenantResolver||tenantResolver;const platform=overrides.platformService||platformService;const vitals=overrides.vitalSignService||vitalSignService;const daily=overrides.dailyCareService||dailyCareService;const idFactory=overrides.idFactory||id;const transact=overrides.withTransaction||withTransaction;const now=overrides.now||(()=>new Date());
  async function ingest({identity,input}){const {envelope,payloadSha256}=normalizeEnvelope(input);
    const tenant=await resolver.authorizeResolvedIntegrationTarget({identity,eventType:envelope.eventType,externalCenterId:envelope.subject.externalCenterId});
    let row=await repository.insertEvent({integrationEventId:idFactory('IEVT'),integrationClientId:identity.integrationClientId,
      organizationId:identity.organizationId,externalEventId:envelope.eventId,eventType:envelope.eventType,payloadSha256,
      canonicalPayload:envelope,externalCenterId:envelope.subject.externalCenterId,
      externalResidentId:envelope.subject.externalResidentId,centerId:tenant.centerId});
    if(!row){row=await repository.findByExternalId(identity.integrationClientId,envelope.eventId);if(!row)throw new IntegrationEventError('EVENT_INGESTION_RACE','รับ event ไม่สำเร็จ',503);if(row.payload_sha256!==payloadSha256)throw new IntegrationEventError('EVENT_ID_PAYLOAD_CONFLICT','Event ID นี้เคยใช้กับ payload อื่น',409);return projection(row,{duplicate:true});}
    return processEvent(row.integration_event_id);
  }
  async function processEvent(integrationEventId){
    const claimed=await transact(`integration-event-claim:${integrationEventId}`,()=>repository.claimEvent(integrationEventId));
    if(!claimed){const current=await repository.findEvent(integrationEventId);if(!current)throw new IntegrationEventError('EVENT_NOT_FOUND','ไม่พบ event',404);return projection(current,{duplicate:true});}
    const envelope=claimed.canonical_payload;
    try{return await transact(`integration-event-work:${integrationEventId}`,async()=>{
        const identity={integrationClientId:claimed.integration_client_id,organizationId:claimed.organization_id,sourceSystem:null};
        const client=await platform.inspectIntegrationClient(claimed.integration_client_id);identity.sourceSystem=client.sourceSystem;
        const tenant=await resolver.authorizeResolvedIntegrationTarget({identity,eventType:claimed.event_type,externalCenterId:claimed.external_center_id});
        let subject=await resolver.resolveExternalSubject({tenant,externalResidentId:claimed.external_resident_id,display:envelope.subject});
        if(subject.status!=='mapped'||!subject.careProfileId){await platform.observeExternalSubject({integrationClientId:claimed.integration_client_id,
          externalCenterId:claimed.external_center_id,externalResidentId:claimed.external_resident_id,
          firstName:envelope.subject.firstName,lastName:envelope.subject.lastName,displayName:envelope.subject.displayName,room:envelope.subject.room});
          const pending=await repository.markPending(integrationEventId,{reason:'subject_mapping'});return projection(pending);}
        const common={tenant:{organizationId:claimed.organization_id},subject:{centerId:tenant.centerId,residentId:subject.residentId,careProfileId:subject.careProfileId},occurredAt:envelope.occurredAt,
          provenance:{sourceType:'external_integration',sourceSystem:tenant.sourceSystem,integrationClientId:claimed.integration_client_id,
            integrationEventId:claimed.integration_event_id,externalRecordId:envelope.data.externalRecordId,
            externalStaffId:envelope.recorder?.externalStaffId||null,
            externalStaffDisplayName:envelope.recorder?.displayName||null,
            actorReference:`integration_client:${claimed.integration_client_id}`}};
        let result;let resourceType;
        if(claimed.event_type==='care.vitals.recorded'){result=await vitals.recordCanonical({...common,observations:envelope.data.observations});resourceType='vital_sign_set';}
        else{result=await daily.recordCanonical({...common,items:envelope.data.items,vitalSigns:envelope.data.vitalSigns||null});resourceType='daily_care_report';}
        const processed=await repository.markProcessed(integrationEventId,{residentId:subject.residentId,careProfileId:subject.careProfileId,resourceType,resourceId:result.item.vitalSetId||result.item.dailyReportId});return projection(processed);
      });}catch(error){const code=errorCode(error);return transact(`integration-event-failure:${integrationEventId}`,async()=>{
        if(deterministic(error)){const rejected=await repository.markRejected(integrationEventId,code);return projection(rejected);}
        const attempts=Number(claimed.attempt_count)||1;const dead=attempts>=MAX_ATTEMPTS;const delayMs=Math.min(60*60*1000,2**Math.max(0,attempts-1)*60*1000);
        const retry=await repository.markRetry(integrationEventId,{errorCode:code,dead,nextAttemptAt:new Date(now().getTime()+delayMs).toISOString()});return projection(retry);
      });}
  }
  async function processDue({limit=25}={}){const rows=await repository.listDue(Math.min(100,Math.max(1,Number(limit)||25)));const results=[];for(const row of rows)results.push(await processEvent(row.integration_event_id));return{processed:results.length,results};}
  async function reprocessPendingSubject({integrationClientId,externalCenterId,externalResidentId}){const rows=await repository.listPending({integrationClientId,externalCenterId,externalResidentId,limit:100});const results=[];for(const row of rows)results.push(await processEvent(row.integration_event_id));return{processed:results.length,results};}
  async function listPendingSubjects({integrationClientId=null,organizationId=null,centerId=null,externalCenterId=null,externalResidentId=null,search=null,limit=100}={}){const bounded=Math.min(200,Math.max(1,Number(limit)||100));const clean=(value,max=160)=>String(value||'').trim().slice(0,max);const rows=await repository.listPending({integrationClientId:clean(integrationClientId)||null,limit:500});const groups=new Map();for(const row of rows){const key=`${row.integration_client_id}:${row.external_center_id}:${row.external_resident_id}`;let group=groups.get(key);if(!group){group={integrationClientId:row.integration_client_id,organizationId:row.organization_id,centerId:row.center_id,externalCenterId:row.external_center_id,externalResidentId:row.external_resident_id,displayName:row.display_name||row.canonical_payload?.subject?.displayName||null,room:row.room||row.canonical_payload?.subject?.room||null,eventTypes:[],eventCount:0,firstReceivedAt:row.created_at,lastUpdatedAt:row.updated_at};groups.set(key,group);}group.eventCount+=1;if(!group.eventTypes.includes(row.event_type))group.eventTypes.push(row.event_type);if(row.created_at<group.firstReceivedAt)group.firstReceivedAt=row.created_at;if(row.updated_at>group.lastUpdatedAt)group.lastUpdatedAt=row.updated_at;}const filters={organizationId:clean(organizationId),centerId:clean(centerId),externalCenterId:clean(externalCenterId),externalResidentId:clean(externalResidentId)};const needle=clean(search,120).toLocaleLowerCase('th-TH');return{items:[...groups.values()].filter((item)=>(!filters.organizationId||item.organizationId===filters.organizationId)&&(!filters.centerId||item.centerId===filters.centerId)&&(!filters.externalCenterId||item.externalCenterId===filters.externalCenterId)&&(!filters.externalResidentId||item.externalResidentId===filters.externalResidentId)&&(!needle||[item.externalResidentId,item.displayName,item.room].some((value)=>String(value||'').toLocaleLowerCase('th-TH').includes(needle)))).sort((a,b)=>String(a.firstReceivedAt).localeCompare(String(b.firstReceivedAt))).slice(0,bounded)};}
  async function mapPendingSubject({integrationClientId,externalCenterId,externalResidentId,residentId,actorReference}){const mapping=await platform.mapExternalSubject({integrationClientId,externalCenterId,externalResidentId,residentId,actorReference});if(mapping.mapping_status!=='mapped')throw new IntegrationEventError('SUBJECT_MAPPING_NOT_CONFIRMED','การ map ผู้พักยังไม่สมบูรณ์',409);const reprocessed=await reprocessPendingSubject({integrationClientId,externalCenterId,externalResidentId});return{mapping:{integrationClientId:mapping.integration_client_id,externalCenterId:mapping.external_center_id,externalResidentId:mapping.external_resident_id,centerId:mapping.center_id,residentId:mapping.resident_id,careProfileId:mapping.care_profile_id,status:mapping.mapping_status},reprocessed};}
  return{ingest,processEvent,processDue,reprocessPendingSubject,listPendingSubjects,mapPendingSubject,repository};}
const integrationEventService=createIntegrationEventService();module.exports={createIntegrationEventService,integrationEventService,projection,MAX_ATTEMPTS};
