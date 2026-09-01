const crypto=require('node:crypto');
const {id,withTransaction,audit}=require('../db');
const {platformService}=require('./platformService');
const {createIntegrationAdapterRepository}=require('./integrationAdapterRepository');
const {
  TARGET_EVENT_TYPE,TARGET_FIELDS,IntegrationAdapterError,sanitizeSample,discoverFields,autoSuggest,
  validateMappingRules,transformPayload,compareStructure,
}=require('../domain/integrationAdapter');

const CAPTURE_WINDOW_MS=30*60*1000;
const SAMPLE_RETENTION_MS=24*60*60*1000;
function iso(value){return new Date(value).toISOString();}
function normalizeSourceSystemKey(value){const key=String(value||'').trim().toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'');if(!key)throw new IntegrationAdapterError('SOURCE_SYSTEM_REQUIRED','Integration Client ยังไม่มีระบบต้นทาง',409);return key.slice(0,120);}
function templateName(sourceSystem){return `${String(sourceSystem||'Source').trim()} Daily Health Report`;}
function versionProjection(row){if(!row)return null;return{
  adapterProfileId:row.adapter_version_id,adapterVersionId:row.adapter_version_id,
  adapterTemplateId:row.adapter_template_id,targetEventType:row.target_event_type,
  sourceSystem:row.source_system_label,displayName:row.display_name,version:Number(row.version),
  status:row.version_status||row.status,sourceStructuralFingerprint:row.source_structural_fingerprint,
  bindingCount:Number(row.binding_count)||0,createdBy:row.created_by,activatedBy:row.activated_by||null,
  activatedAt:row.activated_at||null,createdAt:row.created_at,updatedAt:row.updated_at,
};}
function sampleMetadata(row){if(!row)return null;return{sampleId:row.adapter_sample_id,integrationClientId:row.integration_client_id,
  targetEventType:row.target_event_type,status:row.status,captureExpiresAt:row.capture_expires_at,
  sampleExpiresAt:row.sample_expires_at||null,capturedAt:row.captured_at||null,
  sampleSizeBytes:row.sample_size_bytes===null?null:Number(row.sample_size_bytes),
  discoveredFieldCount:row.discovered_field_count===null?null:Number(row.discovered_field_count),
  sourceStructuralFingerprint:row.source_structural_fingerprint||null};}
function noticeProjection(row){return{noticeId:row.adapter_notice_id,noticeType:row.notice_type,sourcePath:row.source_path,
  valueType:row.value_type||null,status:row.status,occurrenceCount:Number(row.occurrence_count)||1,
  firstSeenAt:row.first_seen_at,lastSeenAt:row.last_seen_at};}
function createIntegrationAdapterService(overrides={}){
  const repository=overrides.repository||createIntegrationAdapterRepository();const platform=overrides.platformService||platformService;
  const transact=overrides.withTransaction||withTransaction;const idFactory=overrides.idFactory||id;
  const now=overrides.now||(()=>new Date());const auditFn=overrides.audit||audit;
  async function requireClient(integrationClientId){const client=await platform.inspectIntegrationClient(String(integrationClientId||'').trim());if(!client)throw new IntegrationAdapterError('INTEGRATION_CLIENT_NOT_FOUND','ไม่พบระบบเชื่อมต่อ',404);return client;}
  async function requireConfigurableClient(integrationClientId){const client=await requireClient(integrationClientId);if(client.status==='revoked')throw new IntegrationAdapterError('REVOKED_CLIENT_TERMINAL','Integration Client ที่เพิกถอนแล้วแก้ไขหรือเปิดใช้งานใหม่ไม่ได้',409);return client;}
  function assertTarget(client,targetEventType){if(targetEventType!==TARGET_EVENT_TYPE)throw new IntegrationAdapterError('ADAPTER_EVENT_TYPE_UNSUPPORTED','V1 รองรับเฉพาะรายงานสุขภาพที่ยืนยันแล้ว',400);if(!Array.isArray(client.eventScopes)||!client.eventScopes.includes(targetEventType))throw new IntegrationAdapterError('INTEGRATION_SCOPE_FORBIDDEN','Integration Client ยังไม่ได้รับ Event scope นี้',403);}
  function assertTemplateSource(client,row){if(normalizeSourceSystemKey(client.sourceSystem)!==row.source_system_key)throw new IntegrationAdapterError('ADAPTER_SOURCE_SYSTEM_MISMATCH','รูปแบบข้อมูลนี้เป็นของระบบต้นทางอื่น',409);}
  async function startCapture({integrationClientId,targetEventType=TARGET_EVENT_TYPE,actorReference}){
    const client=await requireConfigurableClient(integrationClientId);assertTarget(client,targetEventType);const sourceSystemKey=normalizeSourceSystemKey(client.sourceSystem);
    const created=await transact(`integration-adapter-capture:${integrationClientId}:${targetEventType}`,async()=>{
      await repository.expireSessions();await repository.cancelWaiting(integrationClientId,targetEventType);
      return repository.createCapture({sampleId:idFactory('IADS'),integrationClientId,sourceSystemKey,targetEventType,
        captureExpiresAt:iso(now().getTime()+CAPTURE_WINDOW_MS),createdBy:String(actorReference||'admin:unknown')});
    });
    await auditFn('integration.adapter_capture_started',String(actorReference||'admin:unknown'),{integrationClientId,targetEventType,sampleId:created.adapter_sample_id});
    return{sample:sampleMetadata(created),message:'ข้อมูลตัวอย่างจะใช้เพื่อจับคู่เท่านั้น และจะยังไม่ถูกบันทึกเป็นข้อมูลสุขภาพ'};
  }
  async function reusableForSample(client,sample){const candidates=await repository.listReusableTemplates(normalizeSourceSystemKey(client.sourceSystem),sample.target_event_type);const reusable=[];
    for(const row of candidates){const analysis=compareStructure({baselineStructure:row.source_structure,mappingRules:row.mapping_rules,payload:sample.sample_payload});if(analysis.breaking.length||!analysis.exact)continue;try{transformPayload({integrationClientId:client.integrationClientId,targetEventType:sample.target_event_type,rules:row.mapping_rules,payload:sample.sample_payload});}catch(_){continue;}reusable.push({...versionProjection(row),exactFingerprint:true});}
    return reusable;
  }
  async function projectCapturedSample(client,row){const fields=autoSuggest(discoverFields(row.sample_payload));return{...sampleMetadata(row),fields,
    targetFields:TARGET_FIELDS.map(({aliases,acceptedUnits,...field})=>field),
    reusableAdapters:await reusableForSample(client,row),
    notice:'ข้อมูลตัวอย่างใช้เพื่อจับคู่ชั่วคราวเท่านั้น ฟิลด์ที่ไม่ได้เลือกจะไม่ถูกนำเข้า'};}
  async function getLatestSample({integrationClientId,targetEventType=TARGET_EVENT_TYPE,actorReference=null}){
    const client=await requireClient(integrationClientId);assertTarget(client,targetEventType);await repository.expireSessions();
    const row=await repository.findLatestSample(integrationClientId,targetEventType);if(!row)return{sample:null,targetFields:TARGET_FIELDS.map(({aliases,acceptedUnits,...field})=>field)};
    if(row.status==='captured')await auditFn('integration.adapter_sample_viewed',String(actorReference||'admin:unknown'),{integrationClientId,targetEventType,sampleId:row.adapter_sample_id,sampleSizeBytes:Number(row.sample_size_bytes)||0,fieldCount:Number(row.discovered_field_count)||0});
    return{sample:row.status==='captured'?await projectCapturedSample(client,row):sampleMetadata(row)};
  }
  async function captureIfWaiting({identity,input}){
    await repository.expireSessions();const waiting=await repository.findWaitingCapture(identity.integrationClientId);if(!waiting)return null;
    const sanitized=sanitizeSample(input);const fields=discoverFields(sanitized.payload);
    const captured=await repository.captureSample({sampleId:waiting.adapter_sample_id,payload:sanitized.payload,
      fingerprint:sanitized.structuralFingerprint,sourceStructure:sanitized.sourceStructure,sizeBytes:sanitized.sizeBytes,
      fieldCount:fields.length,sampleExpiresAt:iso(now().getTime()+SAMPLE_RETENTION_MS)});
    if(!captured)return null;await auditFn('integration.adapter_sample_captured','system:integration_adapter',{integrationClientId:identity.integrationClientId,targetEventType:waiting.target_event_type,sampleId:waiting.adapter_sample_id,sampleSizeBytes:sanitized.sizeBytes,fieldCount:fields.length});
    return{status:'sample_captured',sampleId:waiting.adapter_sample_id,targetEventType:waiting.target_event_type,clinicalDataCreated:false,expiresAt:captured.sample_expires_at};
  }
  async function requireSample(client,sampleId){const sample=await repository.findSample(client.integrationClientId,sampleId);if(!sample||sample.status!=='captured'||new Date(sample.sample_expires_at)<=now())throw new IntegrationAdapterError('ADAPTER_SAMPLE_UNAVAILABLE','ข้อมูลตัวอย่างหมดอายุหรือไม่พร้อมใช้งาน',409);assertTarget(client,sample.target_event_type);if(sample.source_system_key!==normalizeSourceSystemKey(client.sourceSystem))throw new IntegrationAdapterError('ADAPTER_SAMPLE_SOURCE_CHANGED','ระบบต้นทางเปลี่ยนหลังรับตัวอย่าง กรุณารับข้อมูลตัวอย่างใหม่',409);return sample;}
  async function createDraft({integrationClientId,sampleId,mappingRules,actorReference}){
    const client=await requireConfigurableClient(integrationClientId);const sample=await requireSample(client,sampleId);const fields=discoverFields(sample.sample_payload);const rules=validateMappingRules(mappingRules,fields);
    const binding=await repository.findActiveBinding(integrationClientId,sample.target_event_type);
    if(!binding&&(await reusableForSample(client,sample)).length)throw new IntegrationAdapterError('ADAPTER_REUSE_AVAILABLE','พบรูปแบบข้อมูลที่รองรับแล้ว กรุณาใช้การจับคู่นี้',409);
    const row=await transact(`integration-adapter-template:${binding?.adapter_template_id||normalizeSourceSystemKey(client.sourceSystem)}:${sample.target_event_type}`,async()=>{
      let templateId=binding?.adapter_template_id;if(binding)assertTemplateSource(client,binding);
      if(!templateId){const existing=await repository.findTemplateByLineage(normalizeSourceSystemKey(client.sourceSystem),sample.target_event_type,sample.source_structural_fingerprint);if(existing)throw new IntegrationAdapterError('ADAPTER_TEMPLATE_COMMISSIONING_IN_PROGRESS','รูปแบบข้อมูลนี้กำลังถูกตั้งค่า กรุณาตรวจสอบ Adapter ที่มีอยู่',409);templateId=idFactory('IADT');await repository.createTemplate({templateId,sourceSystemKey:normalizeSourceSystemKey(client.sourceSystem),sourceSystemLabel:String(client.sourceSystem).trim(),targetEventType:sample.target_event_type,fingerprint:sample.source_structural_fingerprint,displayName:templateName(client.sourceSystem),createdBy:String(actorReference||'admin:unknown')});}
      const next=await repository.nextVersion(templateId);return repository.createDraft({adapterVersionId:idFactory('IADV'),templateId,version:Number(next?.version)||1,mappingRules:rules,fingerprint:sample.source_structural_fingerprint,sourceStructure:sample.source_structure,createdBy:String(actorReference||'admin:unknown')});
    });
    await auditFn('integration.adapter_draft_created',String(actorReference||'admin:unknown'),{integrationClientId,targetEventType:sample.target_event_type,adapterTemplateId:row.adapter_template_id,adapterVersionId:row.adapter_version_id,version:Number(row.version),mappedFieldCount:rules.length});return{adapter:versionProjection(row)};
  }
  async function previewAdapter({integrationClientId,sampleId,adapterProfileId,mappingRules=null}){
    const client=await requireClient(integrationClientId);const sample=await requireSample(client,sampleId);let rules;
    if(adapterProfileId){const version=await repository.findVersion(adapterProfileId);if(!version||version.status!=='draft')throw new IntegrationAdapterError('ADAPTER_DRAFT_NOT_FOUND','ไม่พบ Adapter Draft',404);assertTemplateSource(client,version);rules=version.mapping_rules;}
    else rules=validateMappingRules(mappingRules,discoverFields(sample.sample_payload));
    const canonical=transformPayload({integrationClientId,targetEventType:sample.target_event_type,rules,payload:sample.sample_payload});return{valid:true,adapterProfileId:adapterProfileId||null,preview:{residentDisplayName:canonical.subject.displayName||'ไม่ระบุชื่อ',externalCenterId:canonical.subject.externalCenterId,externalResidentId:canonical.subject.externalResidentId,careDate:canonical.data.careDate,recordedAt:canonical.data.recordedAt,finalizedAt:canonical.data.finalizedAt,finalizedBy:canonical.data.finalizedBy.displayName||canonical.data.finalizedBy.externalStaffId,observations:canonical.data.observations,generalReport:canonical.data.careItems.find((item)=>item.itemType==='symptom_note')?.value||null,eventId:canonical.eventId},canonicalValidation:'passed'};
  }
  async function activateAdapter({integrationClientId,sampleId,adapterProfileId,actorReference}){
    const client=await requireConfigurableClient(integrationClientId);await previewAdapter({integrationClientId,sampleId,adapterProfileId});const draft=await repository.findVersion(adapterProfileId);assertTemplateSource(client,draft);
    const activated=await transact(`integration-adapter-template:${draft.adapter_template_id}`,async()=>{
      const current=await repository.findVersion(adapterProfileId);if(!current)throw new IntegrationAdapterError('ADAPTER_DRAFT_NOT_FOUND','ไม่พบ Adapter Draft',404);
      if(current.status==='active')return current;if(current.status!=='draft')throw new IntegrationAdapterError('ADAPTER_DRAFT_NOT_ACTIVATABLE','Adapter นี้เปิดใช้งานไม่ได้',409);
      await repository.supersedeActive(current.adapter_template_id);const row=await repository.activateVersion(adapterProfileId,String(actorReference||'admin:unknown'));if(!row)throw new IntegrationAdapterError('ADAPTER_ACTIVATION_RACE','สถานะ Adapter เปลี่ยนไปแล้ว',409);
      const binding=await repository.findActiveBinding(integrationClientId,current.target_event_type);if(binding&&binding.adapter_template_id!==current.adapter_template_id)throw new IntegrationAdapterError('ADAPTER_BINDING_CONFLICT','ระบบเชื่อมต่อนี้ใช้ Adapter อื่นอยู่',409);
      const updated=await repository.updateTemplateBindings(current.adapter_template_id,row.adapter_version_id,String(actorReference||'admin:unknown'));
      if(!updated.length){await repository.deactivateClientBinding(integrationClientId,current.target_event_type);await repository.createBinding({bindingId:idFactory('IADB'),integrationClientId,targetEventType:current.target_event_type,templateId:current.adapter_template_id,versionId:row.adapter_version_id,actorReference:String(actorReference||'admin:unknown')});}
      await repository.consumeSample(sampleId);return repository.findVersion(row.adapter_version_id);
    });
    await auditFn('integration.adapter_activated',String(actorReference||'admin:unknown'),{integrationClientId,targetEventType:activated.target_event_type,adapterTemplateId:activated.adapter_template_id,adapterVersionId:activated.adapter_version_id,version:Number(activated.version)});return{adapter:versionProjection(activated)};
  }
  async function reuseAdapter({integrationClientId,sampleId,adapterVersionId,actorReference}){
    const client=await requireConfigurableClient(integrationClientId);const sample=await requireSample(client,sampleId);const version=await repository.findVersion(adapterVersionId);if(!version||version.status!=='active')throw new IntegrationAdapterError('ADAPTER_REUSE_NOT_AVAILABLE','ไม่พบรูปแบบข้อมูลที่พร้อมใช้',404);assertTemplateSource(client,version);
    const analysis=compareStructure({baselineStructure:version.source_structure,mappingRules:version.mapping_rules,payload:sample.sample_payload});if(analysis.breaking.length||!analysis.exact)throw new IntegrationAdapterError('ADAPTER_REUSE_NOT_AVAILABLE','รูปแบบข้อมูลตัวอย่างไม่ตรงกับ Adapter ที่เลือก',409);transformPayload({integrationClientId,targetEventType:sample.target_event_type,rules:version.mapping_rules,payload:sample.sample_payload});
    const binding=await transact(`integration-adapter-template:${version.adapter_template_id}`,async()=>{const current=await repository.findVersion(adapterVersionId);if(!current||current.status!=='active')throw new IntegrationAdapterError('ADAPTER_REUSE_NOT_AVAILABLE','รูปแบบข้อมูลนี้เปลี่ยนเวอร์ชันแล้ว กรุณาโหลดใหม่',409);await repository.deactivateClientBinding(integrationClientId,sample.target_event_type);const row=await repository.createBinding({bindingId:idFactory('IADB'),integrationClientId,targetEventType:sample.target_event_type,templateId:current.adapter_template_id,versionId:current.adapter_version_id,actorReference:String(actorReference||'admin:unknown')});await repository.consumeSample(sampleId);return row;});
    await auditFn('integration.adapter_reused',String(actorReference||'admin:unknown'),{integrationClientId,targetEventType:sample.target_event_type,adapterTemplateId:version.adapter_template_id,adapterVersionId:version.adapter_version_id});return{binding,adapter:versionProjection(version)};
  }
  async function rollbackAdapter({integrationClientId,adapterVersionId,actorReference}){
    const client=await requireConfigurableClient(integrationClientId);const binding=await repository.findActiveBinding(integrationClientId,TARGET_EVENT_TYPE);if(!binding)throw new IntegrationAdapterError('ADAPTER_BINDING_NOT_FOUND','ระบบเชื่อมต่อนี้ยังไม่มี Adapter',404);assertTemplateSource(client,binding);const target=await repository.findVersion(adapterVersionId);if(!target||target.adapter_template_id!==binding.adapter_template_id||target.status!=='superseded')throw new IntegrationAdapterError('ADAPTER_ROLLBACK_NOT_AVAILABLE','เวอร์ชันนี้ไม่พร้อมสำหรับย้อนกลับ',409);
    const rolled=await transact(`integration-adapter-template:${binding.adapter_template_id}`,async()=>{await repository.supersedeActive(binding.adapter_template_id);await repository.activateVersion(adapterVersionId,String(actorReference||'admin:unknown'));await repository.updateTemplateBindings(binding.adapter_template_id,adapterVersionId,String(actorReference||'admin:unknown'));return repository.findVersion(adapterVersionId);});
    await auditFn('integration.adapter_rolled_back',String(actorReference||'admin:unknown'),{adapterTemplateId:binding.adapter_template_id,adapterVersionId,version:Number(rolled.version)});return{adapter:versionProjection(rolled),futureEventsOnly:true};
  }
  async function updateNotice({integrationClientId,noticeId,status,actorReference}){if(!['ignored','review_later','resolved'].includes(status))throw new IntegrationAdapterError('ADAPTER_NOTICE_STATUS_INVALID','สถานะรายการเปลี่ยนแปลงไม่ถูกต้อง',400);const client=await requireConfigurableClient(integrationClientId);const binding=await repository.findActiveBinding(integrationClientId,TARGET_EVENT_TYPE);if(!binding)throw new IntegrationAdapterError('ADAPTER_BINDING_NOT_FOUND','ระบบเชื่อมต่อนี้ยังไม่มี Adapter',404);assertTemplateSource(client,binding);const row=await repository.updateNotice(binding.adapter_template_id,noticeId,status,String(actorReference||'admin:unknown'));if(!row)throw new IntegrationAdapterError('ADAPTER_NOTICE_NOT_FOUND','ไม่พบรายการเปลี่ยนแปลง',404);await auditFn('integration.adapter_notice_updated',String(actorReference||'admin:unknown'),{adapterTemplateId:binding.adapter_template_id,adapterNoticeId:noticeId,status});return{notice:noticeProjection(row)};}
  async function getAdapterStatus({integrationClientId,targetEventType=TARGET_EVENT_TYPE}){const client=await requireClient(integrationClientId);assertTarget(client,targetEventType);const binding=await repository.findActiveBinding(integrationClientId,targetEventType);if(!binding)return{activeAdapter:null,versions:[],notices:[]};assertTemplateSource(client,binding);const [versions,notices,count]=await Promise.all([repository.listVersions(binding.adapter_template_id),repository.listNotices(binding.adapter_template_id),repository.countBindings(binding.adapter_template_id)]);const active={...binding,binding_count:count?.count};return{activeAdapter:versionProjection(active),versions:versions.map(versionProjection),notices:notices.map(noticeProjection)};}
  async function recordNotice(binding,noticeType,item){const fieldKey=String(item.fieldKey||crypto.createHash('sha256').update(`${noticeType}:${item.sourcePath||'structure'}`).digest('hex'));return repository.upsertNotice({noticeId:idFactory('IADN'),templateId:binding.adapter_template_id,versionId:binding.adapter_version_id,noticeType,fieldKey,sourcePath:String(item.sourcePath||'source_structure').slice(0,600),valueType:item.valueType||null});}
  async function prepareInbound({identity,input}){
    const captured=await captureIfWaiting({identity,input});if(captured)return{action:'captured',result:captured};const binding=await repository.findActiveBinding(identity.integrationClientId);if(!binding)return{action:'canonical',input};
    if(normalizeSourceSystemKey(identity.sourceSystem)!==binding.source_system_key)throw new IntegrationAdapterError('ADAPTER_SOURCE_SYSTEM_MISMATCH','Integration Client ไม่ตรงกับ Adapter ที่เปิดใช้งาน',409);
    const sanitized=sanitizeSample(input);const analysis=compareStructure({baselineStructure:binding.source_structure,mappingRules:binding.mapping_rules,payload:sanitized.payload});if(analysis.breaking.length){for(const item of analysis.breaking)await recordNotice(binding,'ADAPTER_SOURCE_CHANGED',item);throw new IntegrationAdapterError('ADAPTER_SOURCE_CHANGED','รูปแบบข้อมูลต้นทางเปลี่ยน',422);}
    let canonical;try{canonical=transformPayload({integrationClientId:identity.integrationClientId,targetEventType:binding.target_event_type,rules:binding.mapping_rules,payload:sanitized.payload});}catch(error){if(String(error?.code||'').startsWith('ADAPTER_')){await recordNotice(binding,error.code==='ADAPTER_SOURCE_CHANGED'?'ADAPTER_SOURCE_CHANGED':'ADAPTER_TRANSFORM_FAILURE',{sourcePath:'mapped_source',fieldKey:crypto.createHash('sha256').update(String(error.code)).digest('hex')});if(error.code!=='ADAPTER_SOURCE_CHANGED')throw new IntegrationAdapterError('ADAPTER_SOURCE_CHANGED','รูปแบบหรือค่าข้อมูลต้นทางไม่ตรงกับ Adapter',422);}throw error;}
    for(const item of analysis.added)await recordNotice(binding,'NEW_SOURCE_FIELDS_AVAILABLE',item);
    return{action:'transformed',input:canonical,adapterVersion:Number(binding.version),adapterTemplateId:binding.adapter_template_id};
  }
  async function purgeExpired(){const rows=await repository.expireSessions();return{expired:rows.length};}
  return{startCapture,getLatestSample,createDraft,previewAdapter,activateAdapter,reuseAdapter,rollbackAdapter,updateNotice,getAdapterStatus,captureIfWaiting,prepareInbound,purgeExpired,repository};
}
const integrationAdapterService=createIntegrationAdapterService();
module.exports={createIntegrationAdapterService,integrationAdapterService,profileProjection:versionProjection,versionProjection,sampleMetadata,normalizeSourceSystemKey,CAPTURE_WINDOW_MS,SAMPLE_RETENTION_MS};
