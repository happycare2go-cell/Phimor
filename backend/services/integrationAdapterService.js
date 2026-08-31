const {id,withTransaction,audit}=require('../db');
const {platformService}=require('./platformService');
const {createIntegrationAdapterRepository}=require('./integrationAdapterRepository');
const {
  TARGET_EVENT_TYPE,TARGET_FIELDS,IntegrationAdapterError,sanitizeSample,discoverFields,autoSuggest,
  validateMappingRules,transformPayload,
}=require('../domain/integrationAdapter');

const CAPTURE_WINDOW_MS=30*60*1000;
const SAMPLE_RETENTION_MS=24*60*60*1000;
function iso(value){return new Date(value).toISOString();}
function profileProjection(row){if(!row)return null;return{adapterProfileId:row.adapter_profile_id,integrationClientId:row.integration_client_id,
  targetEventType:row.target_event_type,version:Number(row.version),status:row.status,
  sourceStructuralFingerprint:row.source_structural_fingerprint,createdBy:row.created_by,
  activatedBy:row.activated_by||null,activatedAt:row.activated_at||null,createdAt:row.created_at,updatedAt:row.updated_at};}
function sampleMetadata(row){if(!row)return null;return{sampleId:row.adapter_sample_id,integrationClientId:row.integration_client_id,
  targetEventType:row.target_event_type,status:row.status,captureExpiresAt:row.capture_expires_at,
  sampleExpiresAt:row.sample_expires_at||null,capturedAt:row.captured_at||null,
  sampleSizeBytes:row.sample_size_bytes===null?null:Number(row.sample_size_bytes),
  discoveredFieldCount:row.discovered_field_count===null?null:Number(row.discovered_field_count),
  sourceStructuralFingerprint:row.source_structural_fingerprint||null};}
function createIntegrationAdapterService(overrides={}){
  const repository=overrides.repository||createIntegrationAdapterRepository();const platform=overrides.platformService||platformService;
  const transact=overrides.withTransaction||withTransaction;const idFactory=overrides.idFactory||id;
  const now=overrides.now||(()=>new Date());const auditFn=overrides.audit||audit;
  async function requireClient(integrationClientId){const client=await platform.inspectIntegrationClient(String(integrationClientId||'').trim());if(!client)throw new IntegrationAdapterError('INTEGRATION_CLIENT_NOT_FOUND','ไม่พบระบบเชื่อมต่อ',404);return client;}
  function assertTarget(client,targetEventType){if(targetEventType!==TARGET_EVENT_TYPE)throw new IntegrationAdapterError('ADAPTER_EVENT_TYPE_UNSUPPORTED','V1 รองรับเฉพาะรายงานสุขภาพที่ยืนยันแล้ว',400);if(!Array.isArray(client.eventScopes)||!client.eventScopes.includes(targetEventType))throw new IntegrationAdapterError('INTEGRATION_SCOPE_FORBIDDEN','Integration Client ยังไม่ได้รับ Event scope นี้',403);}
  async function startCapture({integrationClientId,targetEventType=TARGET_EVENT_TYPE,actorReference}){
    const client=await requireClient(integrationClientId);assertTarget(client,targetEventType);
    const created=await transact(`integration-adapter-capture:${integrationClientId}:${targetEventType}`,async()=>{
      await repository.expireSessions();await repository.cancelWaiting(integrationClientId,targetEventType);
      return repository.createCapture({sampleId:idFactory('IADS'),integrationClientId,targetEventType,
        captureExpiresAt:iso(now().getTime()+CAPTURE_WINDOW_MS),createdBy:String(actorReference||'admin:unknown')});
    });
    await auditFn('integration.adapter_capture_started',String(actorReference||'admin:unknown'),{
      integrationClientId,targetEventType,sampleId:created.adapter_sample_id,
    });return{sample:sampleMetadata(created),message:'ข้อมูลตัวอย่างจะใช้เพื่อจับคู่เท่านั้น และจะยังไม่ถูกบันทึกเป็นข้อมูลสุขภาพ'};
  }
  function projectCapturedSample(row){
    const fields=autoSuggest(discoverFields(row.sample_payload));return{...sampleMetadata(row),fields,
      targetFields:TARGET_FIELDS.map(({aliases,acceptedUnits,...field})=>field),
      notice:'ข้อมูลตัวอย่างใช้เพื่อจับคู่ชั่วคราวเท่านั้น ฟิลด์ที่ไม่ได้เลือกจะไม่ถูกนำเข้า'};
  }
  async function getLatestSample({integrationClientId,targetEventType=TARGET_EVENT_TYPE,actorReference=null}){
    const client=await requireClient(integrationClientId);assertTarget(client,targetEventType);await repository.expireSessions();
    const row=await repository.findLatestSample(integrationClientId,targetEventType);if(!row)return{sample:null,targetFields:TARGET_FIELDS.map(({aliases,acceptedUnits,...field})=>field)};
    if(row.status==='captured')await auditFn('integration.adapter_sample_viewed',String(actorReference||'admin:unknown'),{
      integrationClientId,targetEventType,sampleId:row.adapter_sample_id,
      sampleSizeBytes:Number(row.sample_size_bytes)||0,fieldCount:Number(row.discovered_field_count)||0,
    });
    return{sample:row.status==='captured'?projectCapturedSample(row):sampleMetadata(row)};
  }
  async function captureIfWaiting({identity,input}){
    await repository.expireSessions();const waiting=await repository.findWaitingCapture(identity.integrationClientId);if(!waiting)return null;
    const sanitized=sanitizeSample(input);const fields=discoverFields(sanitized.payload);
    const captured=await repository.captureSample({sampleId:waiting.adapter_sample_id,payload:sanitized.payload,
      fingerprint:sanitized.structuralFingerprint,sizeBytes:sanitized.sizeBytes,fieldCount:fields.length,
      sampleExpiresAt:iso(now().getTime()+SAMPLE_RETENTION_MS)});
    if(!captured)return null;
    await auditFn('integration.adapter_sample_captured','system:integration_adapter',{
      integrationClientId:identity.integrationClientId,targetEventType:waiting.target_event_type,
      sampleId:waiting.adapter_sample_id,sampleSizeBytes:sanitized.sizeBytes,fieldCount:fields.length,
    });
    return{status:'sample_captured',sampleId:waiting.adapter_sample_id,targetEventType:waiting.target_event_type,
      clinicalDataCreated:false,expiresAt:captured.sample_expires_at};
  }
  async function createDraft({integrationClientId,sampleId,mappingRules,actorReference}){
    const client=await requireClient(integrationClientId);const sample=await repository.findSample(integrationClientId,sampleId);
    if(!sample||sample.status!=='captured'||new Date(sample.sample_expires_at)<=now())throw new IntegrationAdapterError('ADAPTER_SAMPLE_UNAVAILABLE','ข้อมูลตัวอย่างหมดอายุหรือไม่พร้อมใช้งาน',409);
    assertTarget(client,sample.target_event_type);const fields=discoverFields(sample.sample_payload);
    const rules=validateMappingRules(mappingRules,fields);
    const row=await transact(`integration-adapter-profile:${integrationClientId}:${sample.target_event_type}`,async()=>{
      const next=await repository.nextVersion(integrationClientId,sample.target_event_type);
      return repository.createDraft({adapterProfileId:idFactory('IADP'),integrationClientId,targetEventType:sample.target_event_type,
        version:Number(next?.version)||1,mappingRules:rules,fingerprint:sample.source_structural_fingerprint,
        createdBy:String(actorReference||'admin:unknown')});
    });
    await auditFn('integration.adapter_draft_created',String(actorReference||'admin:unknown'),{
      integrationClientId,targetEventType:sample.target_event_type,adapterProfileId:row.adapter_profile_id,version:Number(row.version),mappedFieldCount:rules.length,
    });return{adapter:profileProjection(row)};
  }
  async function previewAdapter({integrationClientId,sampleId,adapterProfileId,mappingRules=null}){
    const client=await requireClient(integrationClientId);const sample=await repository.findSample(integrationClientId,sampleId);
    if(!sample||sample.status!=='captured'||new Date(sample.sample_expires_at)<=now())throw new IntegrationAdapterError('ADAPTER_SAMPLE_UNAVAILABLE','ข้อมูลตัวอย่างหมดอายุหรือไม่พร้อมใช้งาน',409);
    assertTarget(client,sample.target_event_type);let rules;
    if(adapterProfileId){const profile=await repository.findProfile(integrationClientId,adapterProfileId);if(!profile||profile.status!=='draft')throw new IntegrationAdapterError('ADAPTER_DRAFT_NOT_FOUND','ไม่พบ Adapter Draft',404);rules=profile.mapping_rules;}
    else rules=validateMappingRules(mappingRules,discoverFields(sample.sample_payload));
    const canonical=transformPayload({integrationClientId,targetEventType:sample.target_event_type,rules,payload:sample.sample_payload});
    return{valid:true,adapterProfileId:adapterProfileId||null,preview:{residentDisplayName:canonical.subject.displayName||'ไม่ระบุชื่อ',
      externalCenterId:canonical.subject.externalCenterId,externalResidentId:canonical.subject.externalResidentId,
      careDate:canonical.data.careDate,recordedAt:canonical.data.recordedAt,finalizedAt:canonical.data.finalizedAt,
      finalizedBy:canonical.data.finalizedBy.displayName||canonical.data.finalizedBy.externalStaffId,
      observations:canonical.data.observations,generalReport:canonical.data.careItems.find((item)=>item.itemType==='symptom_note')?.value||null,
      eventId:canonical.eventId},canonicalValidation:'passed'};
  }
  async function activateAdapter({integrationClientId,sampleId,adapterProfileId,actorReference}){
    await previewAdapter({integrationClientId,sampleId,adapterProfileId});
    const activated=await transact(`integration-adapter-profile:${integrationClientId}:${TARGET_EVENT_TYPE}`,async()=>{
      const profile=await repository.findProfile(integrationClientId,adapterProfileId);
      if(!profile)throw new IntegrationAdapterError('ADAPTER_DRAFT_NOT_FOUND','ไม่พบ Adapter Draft',404);
      if(profile.status==='active')return profile;if(profile.status!=='draft')throw new IntegrationAdapterError('ADAPTER_DRAFT_NOT_ACTIVATABLE','Adapter นี้เปิดใช้งานไม่ได้',409);
      await repository.supersedeActive(integrationClientId,profile.target_event_type);
      const row=await repository.activateProfile(adapterProfileId,String(actorReference||'admin:unknown'));
      if(!row)throw new IntegrationAdapterError('ADAPTER_ACTIVATION_RACE','สถานะ Adapter เปลี่ยนไปแล้ว',409);
      await repository.consumeSample(sampleId);return row;
    });
    await auditFn('integration.adapter_activated',String(actorReference||'admin:unknown'),{
      integrationClientId,targetEventType:activated.target_event_type,adapterProfileId:activated.adapter_profile_id,version:Number(activated.version),
    });return{adapter:profileProjection(activated)};
  }
  async function getAdapterStatus({integrationClientId,targetEventType=TARGET_EVENT_TYPE}){
    const client=await requireClient(integrationClientId);assertTarget(client,targetEventType);const [active,profiles]=await Promise.all([repository.findActive(integrationClientId,targetEventType),repository.listProfiles(integrationClientId,targetEventType)]);
    return{activeAdapter:profileProjection(active),versions:profiles.map(profileProjection)};
  }
  async function prepareInbound({identity,input}){
    const captured=await captureIfWaiting({identity,input});if(captured)return{action:'captured',result:captured};
    const active=await repository.findActive(identity.integrationClientId);if(!active)return{action:'canonical',input};
    const canonical=transformPayload({integrationClientId:identity.integrationClientId,targetEventType:active.target_event_type,rules:active.mapping_rules,payload:input});
    return{action:'transformed',input:canonical,adapterVersion:Number(active.version)};
  }
  async function purgeExpired(){const rows=await repository.expireSessions();return{expired:rows.length};}
  return{startCapture,getLatestSample,createDraft,previewAdapter,activateAdapter,getAdapterStatus,
    captureIfWaiting,prepareInbound,purgeExpired,repository};
}
const integrationAdapterService=createIntegrationAdapterService();
module.exports={createIntegrationAdapterService,integrationAdapterService,profileProjection,sampleMetadata,CAPTURE_WINDOW_MS,SAMPLE_RETENTION_MS};
