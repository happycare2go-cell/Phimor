const {platformService}=require('./platformService');
const {createIntegrationEventRepository}=require('./integrationEventRepository');
const {createIntegrationAdapterRepository}=require('./integrationAdapterRepository');
const {TARGET_FIELDS,TARGET_EVENT_TYPE}=require('../domain/integrationAdapter');

const STAGE_DEFINITIONS=Object.freeze([
  ['receive','รับข้อมูล'],['validate','ตรวจรูปแบบข้อมูล'],['transform','แปลงข้อมูล'],
  ['center','ระบุศูนย์'],['resident','จับคู่ผู้พัก'],['care_profile','เชื่อม Care Profile'],
  ['persistence','บันทึกข้อมูล'],['family_destination','ระบุปลายทางครอบครัว'],
  ['notification','ส่งการแจ้งเตือน'],
]);
const ERROR_LABELS=Object.freeze({
  CENTER_MAPPING_NOT_FOUND:'ยังไม่พบศูนย์ที่ตรงกับรหัสจากระบบภายนอก',
  SUBJECT_MAPPING_NOT_FOUND:'ยังไม่พบผู้พักที่ตรงกับข้อมูลจากระบบภายนอก',
  RESIDENT_MAPPING_INVALID:'การเชื่อมผู้พักไม่พร้อมใช้งาน',
  CARE_PROFILE_RELATIONSHIP_INVALID:'ยังไม่พบ Care Profile ที่พร้อมใช้งาน',
  GROUP_RECONCILIATION_BLOCKED:'ปลายทางครอบครัวยังไม่พร้อม',
  INVALID_FINALIZED_RECORD:'ข้อมูลไม่ผ่านข้อกำหนดของรายงานที่ยืนยันแล้ว',
  TEMPORARY_PROCESSING_UNAVAILABLE:'ระบบประมวลผลชั่วคราวไม่สำเร็จ',
  PROCESSING_RETRY_EXHAUSTED:'ระบบประมวลผลไม่สำเร็จหลังลองครบจำนวนครั้ง',
});
function safeReference(value,prefix='เหตุการณ์'){
  const text=String(value||'').trim();return text?`${prefix} ••••${text.slice(-6)}`:null;
}
function stage(key,state,detail=null){const definition=STAGE_DEFINITIONS.find(([id])=>id===key);return{key,label:definition?.[1]||key,state,detail};}
function attentionFor(row){
  if(row.pending_reason==='subject_mapping')return{stage:'resident',reason:'ยังไม่พบผู้พักที่ตรงกับข้อมูลจากระบบภายนอก'};
  if(row.group_reconciliation_status==='group_binding_missing')return{stage:'family_destination',reason:'ยังไม่ได้ผูกปลายทางครอบครัว'};
  if(row.group_reconciliation_status==='group_binding_mismatch')return{stage:'family_destination',reason:'ปลายทางครอบครัวไม่ตรงกับการเชื่อมที่ยืนยันไว้'};
  if(row.notification_intent_status==='enqueue_failed')return{stage:'notification',reason:'สร้างคิวการแจ้งเตือนไม่สำเร็จ'};
  if(['rejected','retrying','dead'].includes(row.status))return{stage:row.resident_id?'persistence':'resident',reason:ERROR_LABELS[row.last_error_code]||'เหตุการณ์นี้ต้องตรวจสอบเพิ่มเติม'};
  return null;
}
function flowForEvent(row){
  if(!row)return{latestEvent:null,attention:null,stages:STAGE_DEFINITIONS.map(([key,label],index)=>({key,label,state:index===0?'waiting':'unknown',detail:index===0?'ยังไม่พบเหตุการณ์':'ยังตรวจสอบไม่ได้'}))};
  const isDaily=row.event_type==='care.daily_report.finalized';const processed=row.status==='processed';
  const pendingSubject=row.status==='pending'&&row.pending_reason==='subject_mapping';
  const terminalFailure=['rejected','dead'].includes(row.status);const processing=['received','processing','retrying'].includes(row.status);
  const group=row.group_reconciliation_status;const notification=row.notification_intent_status;
  const stages=[
    stage('receive','completed','ระบบบันทึกเหตุการณ์แล้ว'),
    stage('validate','completed','ผ่านการตรวจ canonical envelope ก่อนบันทึก inbox'),
    stage('transform','unknown','event ไม่ได้เก็บ Adapter version ที่ใช้ จึงยืนยันย้อนหลังไม่ได้'),
    stage('center','completed','มี Center ที่ backend อนุญาตและบันทึกไว้'),
    stage('resident',row.resident_id?'completed':pendingSubject?'attention':terminalFailure?'failed':processing?'current':'unknown',row.resident_id?'เชื่อมผู้พักแล้ว':pendingSubject?'รอผู้ดูแลเชื่อมผู้พัก':'ยังตรวจสอบไม่ได้'),
    stage('care_profile',row.care_profile_id?'completed':pendingSubject?'waiting':terminalFailure?'unknown':processing?'waiting':'unknown',row.care_profile_id?'เชื่อม Care Profile แล้ว':'ยังไม่มีหลักฐานการเชื่อม'),
    stage('persistence',processed&&row.canonical_resource_id?'completed':terminalFailure?'failed':pendingSubject?'waiting':processing?'current':'unknown',processed&&row.canonical_resource_id?'บันทึกข้อมูลมาตรฐานแล้ว':terminalFailure?'บันทึกข้อมูลไม่สำเร็จ':'กำลังรอประมวลผล'),
    stage('family_destination',!isDaily?'not_applicable':!processed?'waiting':group==='group_binding_missing'||group==='group_binding_mismatch'?'attention':row.verified_line_group_id?'completed':'unknown',!isDaily?'เหตุการณ์นี้ไม่ส่งรายงานครอบครัว':row.verified_line_group_id?'พบปลายทางที่ผ่านการตรวจสอบแล้ว':group==='group_binding_missing'?'ยังไม่ได้ผูกปลายทางครอบครัว':group==='group_binding_mismatch'?'ปลายทางไม่ตรงกัน':'ยังตรวจสอบไม่ได้'),
    stage('notification',!isDaily?'not_applicable':!processed?'waiting':notification==='queued'||notification==='duplicate'?'current':['recipient_missing','held_group_missing','held_group_mismatch'].includes(notification)?'attention':notification==='enqueue_failed'?'failed':notification==='not_applicable'?'not_applicable':'unknown',!isDaily?'เหตุการณ์นี้ไม่มีการแจ้งครอบครัว':notification==='queued'?'สร้างคิวแล้ว แต่ยังไม่ใช่หลักฐานว่าส่งถึงผู้รับ':notification==='duplicate'?'มีคิวของรายการนี้อยู่แล้ว':notification==='enqueue_failed'?'สร้างคิวไม่สำเร็จ':'ยังตรวจสอบสถานะการส่งไม่ได้'),
  ];
  return{latestEvent:{safeReference:safeReference(row.integration_event_id),eventType:row.event_type,status:row.status,
    receivedAt:row.created_at||null,latestMeaningfulAt:row.processed_at||row.updated_at||row.created_at||null,
    processedAt:row.processed_at||null,attemptCount:Number(row.attempt_count)||0,nextAttemptAt:row.next_attempt_at||null},
    attention:attentionFor(row),stages};
}
function locatorPath(locator){
  if(locator?.kind==='object_path')return Array.isArray(locator.path)?locator.path.join('.'):'ไม่ทราบ';
  if(locator?.kind==='array_match'){
    const root=Array.isArray(locator.arrayPath)?locator.arrayPath.join('.'):'รายการ';
    const field=String(locator.where?.field||'ชนิด');const value=String(locator.where?.equals||'').slice(0,80);
    const tail=Array.isArray(locator.valuePath)?locator.valuePath.join('.'):'ค่า';
    return `${root}[${field}=${value}].${tail}`;
  }
  return 'ไม่ทราบ';
}
const TRANSFORM_LABELS=Object.freeze({join_text:'รวมข้อความตามลำดับ',identifier:'รหัสอ้างอิง',text:'ข้อความ',number:'ตัวเลขมาตรฐาน',date:'วันที่มาตรฐาน',datetime:'วันเวลามาตรฐาน'});
function mappingProjection(binding){
  if(!binding)return{mappingMode:'canonical_contract',activeAdapter:null,mappings:[],message:'รับข้อมูลตาม PHIMOR canonical contract โดยไม่มี Adapter field mapping ที่ตั้งค่าไว้'};
  const targets=new Map(TARGET_FIELDS.map((item)=>[item.id,item]));
  const mappings=(Array.isArray(binding.mapping_rules)?binding.mapping_rules:[]).map((rule)=>{
    const target=targets.get(rule.targetField);return{sourcePaths:(Array.isArray(rule.locators)?rule.locators:[]).map(locatorPath),
      canonicalField:target?.id||String(rule.targetField||'unknown'),phimorLabel:target?.label||'ไม่ทราบข้อมูลปลายทาง',
      section:target?.section||'ข้อมูลมาตรฐาน',required:Boolean(target?.required),
      transformation:TRANSFORM_LABELS[rule.transform]||'ตามการตั้งค่า Adapter',state:target?'configured':'unknown'};
  });
  return{mappingMode:'adapter',activeAdapter:{displayName:binding.display_name||'Adapter',sourceSystem:binding.source_system_label||null,
    targetEventType:binding.target_event_type||TARGET_EVENT_TYPE,version:Number(binding.version)||null,status:binding.version_status||null,
    activatedAt:binding.activated_at||null},mappings,message:mappings.length?'การจับคู่ข้อมูลปัจจุบันจาก Adapter ที่เปิดใช้งาน':'Adapter นี้ไม่มีรายการจับคู่ที่ตรวจสอบได้'};
}
function createIntegrationControlCenterService(overrides={}){
  const platform=overrides.platformService||platformService;
  const events=overrides.eventRepository||createIntegrationEventRepository();
  const adapters=overrides.adapterRepository||createIntegrationAdapterRepository();
  async function overview(input={}){
    const directory=await platform.listIntegrationClientDirectory({...input,view:input.view||'current',limit:Math.min(50,Math.max(1,Number(input.limit)||20))});
    const rows=await events.listLatestForClients(directory.items.map((item)=>item.integrationClientId));
    const latest=new Map(rows.map((row)=>[row.integration_client_id,row]));
    return{items:directory.items.map((client)=>({integrationClientId:client.integrationClientId,
      displayName:client.displayName,clientStatus:client.status,...flowForEvent(latest.get(client.integrationClientId)||null)})),
      pagination:directory.pagination,refreshedAt:new Date().toISOString()};
  }
  async function mappingInspector({integrationClientId}){
    const clientId=String(integrationClientId||'').trim();
    if(!clientId)throw Object.assign(new Error('กรุณาระบุระบบเชื่อมต่อ'),{code:'INTEGRATION_CLIENT_REQUIRED',status:400});
    const client=await platform.inspectIntegrationClient(clientId);
    const binding=await adapters.findActiveBinding(clientId,TARGET_EVENT_TYPE);
    return{integrationClient:{integrationClientId:client.integrationClientId,displayName:client.displayName,
      sourceSystem:client.sourceSystem,status:client.status},...mappingProjection(binding)};
  }
  return{overview,mappingInspector};
}
const integrationControlCenterService=createIntegrationControlCenterService();
module.exports={STAGE_DEFINITIONS,ERROR_LABELS,TRANSFORM_LABELS,safeReference,flowForEvent,locatorPath,mappingProjection,createIntegrationControlCenterService,integrationControlCenterService};
