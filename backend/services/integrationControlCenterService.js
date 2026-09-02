const {platformService}=require('./platformService');
const {createIntegrationEventRepository}=require('./integrationEventRepository');
const {createIntegrationAdapterRepository}=require('./integrationAdapterRepository');
const {createIntegrationControlCenterRepository}=require('./integrationControlCenterRepository');
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
  if(row.notification_delivery_status==='retrying')return{stage:'notification',reason:'การแจ้งเตือนยังส่งไม่สำเร็จและระบบกำลังลองใหม่'};
  if(row.notification_delivery_status==='dead_letter')return{stage:'notification',reason:'ระบบหยุดลองส่งการแจ้งเตือนแล้ว'};
  if(['rejected','retrying','dead'].includes(row.status))return{stage:row.resident_id?'persistence':'resident',reason:ERROR_LABELS[row.last_error_code]||'เหตุการณ์นี้ต้องตรวจสอบเพิ่มเติม'};
  return null;
}
function flowForEvent(row){
  if(!row)return{latestEvent:null,attention:null,stages:STAGE_DEFINITIONS.map(([key,label],index)=>({key,label,state:index===0?'waiting':'unknown',detail:index===0?'ยังไม่พบเหตุการณ์':'ยังตรวจสอบไม่ได้'}))};
  const isDaily=row.event_type==='care.daily_report.finalized';const processed=row.status==='processed';
  const pendingSubject=row.status==='pending'&&row.pending_reason==='subject_mapping';
  const terminalFailure=['rejected','dead'].includes(row.status);const processing=['received','processing','retrying'].includes(row.status);
  const group=row.group_reconciliation_status;const notification=row.notification_intent_status;const delivery=row.notification_delivery_status;
  const stages=[
    stage('receive','completed','ระบบบันทึกเหตุการณ์แล้ว'),
    stage('validate','completed','ผ่านการตรวจ canonical envelope ก่อนบันทึก inbox'),
    stage('transform','unknown','event ไม่ได้เก็บ Adapter version ที่ใช้ จึงยืนยันย้อนหลังไม่ได้'),
    stage('center','completed','มี Center ที่ backend อนุญาตและบันทึกไว้'),
    stage('resident',row.resident_id?'completed':pendingSubject?'attention':terminalFailure?'failed':processing?'current':'unknown',row.resident_id?'เชื่อมผู้พักแล้ว':pendingSubject?'รอผู้ดูแลเชื่อมผู้พัก':'ยังตรวจสอบไม่ได้'),
    stage('care_profile',row.care_profile_id?'completed':pendingSubject?'waiting':terminalFailure?'unknown':processing?'waiting':'unknown',row.care_profile_id?'เชื่อม Care Profile แล้ว':'ยังไม่มีหลักฐานการเชื่อม'),
    stage('persistence',processed&&row.canonical_resource_id?'completed':terminalFailure?'failed':pendingSubject?'waiting':processing?'current':'unknown',processed&&row.canonical_resource_id?'บันทึกข้อมูลมาตรฐานแล้ว':terminalFailure?'บันทึกข้อมูลไม่สำเร็จ':'กำลังรอประมวลผล'),
    stage('family_destination',!isDaily?'not_applicable':!processed?'waiting':group==='group_binding_missing'||group==='group_binding_mismatch'?'attention':(row.family_destination_verified||row.verified_line_group_id)?'completed':'unknown',!isDaily?'เหตุการณ์นี้ไม่ส่งรายงานครอบครัว':(row.family_destination_verified||row.verified_line_group_id)?'พบปลายทางที่ผ่านการตรวจสอบแล้ว':group==='group_binding_missing'?'ยังไม่ได้ผูกปลายทางครอบครัว':group==='group_binding_mismatch'?'ปลายทางไม่ตรงกัน':'ยังตรวจสอบไม่ได้'),
    stage('notification',!isDaily?'not_applicable':!processed?'waiting':delivery==='sent'?'completed':delivery==='dead_letter'?'failed':delivery==='retrying'?'attention':['pending','sending'].includes(delivery)||notification==='queued'||notification==='duplicate'?'current':['recipient_missing','held_group_missing','held_group_mismatch'].includes(notification)?'attention':notification==='enqueue_failed'?'failed':notification==='not_applicable'?'not_applicable':'unknown',!isDaily?'เหตุการณ์นี้ไม่มีการแจ้งครอบครัว':delivery==='sent'?'ผู้ให้บริการรับคำขอส่งแล้ว แต่ไม่มีหลักฐานว่าส่งถึงผู้รับปลายทาง':delivery==='dead_letter'?'ระบบหยุดลองส่งแล้ว':delivery==='retrying'?'ระบบกำลังลองส่งใหม่':notification==='queued'?'สร้างคิวแล้ว แต่ยังไม่ใช่หลักฐานว่าส่งถึงผู้รับ':notification==='duplicate'?'มีคิวของรายการนี้อยู่แล้ว':notification==='enqueue_failed'?'สร้างคิวไม่สำเร็จ':'ยังตรวจสอบสถานะการส่งไม่ได้'),
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
const MATCH_METHODS=Object.freeze({learned_automatically:'learned',configured_manually:'configured'});
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
function identityProjection(row){
  const ambiguous=row.row_kind==='ambiguity'||row.mapping_status==='ambiguous';
  const mapped=row.mapping_status==='mapped';
  const residentActive=mapped&&row.resident_status==='active';
  const careProfileReady=residentActive&&Boolean(row.care_profile_ready);
  return{safeReference:safeReference(row.row_id,'การเชื่อม'),externalCenterId:String(row.external_center_id||'').slice(0,160)||null,
    externalResidentId:String(row.external_resident_id||'').slice(0,160)||null,
    mappingStatus:ambiguous?'ambiguous':row.mapping_status||'unresolved',
    matchMethod:ambiguous?'unresolved':mapped?(MATCH_METHODS[row.mapping_source]||'unknown'):'unresolved',
    center:{state:row.center_mapping_status==='active'&&row.center_name?'resolved':row.center_mapping_status==='inactive'?'inactive':'unresolved',displayName:row.center_name||null},
    resident:{state:residentActive?'resolved':mapped?'inactive':'unresolved',displayName:residentActive?row.resident_name||null:null,room:residentActive?row.room||null:null},
    careProfile:{state:careProfileReady?'resolved':mapped?'missing':'unresolved'},
    familyDestination:{state:careProfileReady?(row.family_destination_ready?'resolved':'missing'):'unresolved'},
    ambiguity:ambiguous?{candidateCount:Number(row.candidate_count)||0,status:row.alert_status||'open'}:null,
    lastSeenAt:row.last_seen_at||row.updated_at||row.created_at||null};
}
const HISTORY_STATUSES=Object.freeze(['received','processing','processed','pending','rejected','retrying','dead']);
const HISTORY_CATEGORIES=Object.freeze(['identity','family_destination','notification','processing']);
function safeDate(value,endOfDay=false){const clean=String(value||'').trim();if(!clean)return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(clean))throw Object.assign(new Error('รูปแบบวันที่ไม่ถูกต้อง'),{code:'INVALID_HISTORY_DATE',status:400});const date=new Date(`${clean}T00:00:00+07:00`);if(!Number.isFinite(date.getTime()))throw Object.assign(new Error('รูปแบบวันที่ไม่ถูกต้อง'),{code:'INVALID_HISTORY_DATE',status:400});if(endOfDay)date.setTime(date.getTime()+86400000);return date.toISOString();}
function historyQuery(input={}){
  const status=String(input.status||'').trim()||null;if(status&&!HISTORY_STATUSES.includes(status))throw Object.assign(new Error('ตัวกรองสถานะไม่ถูกต้อง'),{code:'INVALID_HISTORY_STATUS',status:400});
  const category=String(input.category||'').trim()||null;if(category&&!HISTORY_CATEGORIES.includes(category))throw Object.assign(new Error('ตัวกรองขั้นตอนไม่ถูกต้อง'),{code:'INVALID_HISTORY_CATEGORY',status:400});
  const reference=String(input.reference||'').trim();const suffix=reference?(reference.match(/^(?:เหตุการณ์\s+••••)?([A-Za-z0-9]{6})$/u)?.[1]||null):null;if(reference&&!suffix)throw Object.assign(new Error('รหัสอ้างอิงไม่ถูกต้อง'),{code:'INVALID_HISTORY_REFERENCE',status:400});
  const page=Math.max(1,Number(input.page)||1);const limit=Math.min(50,Math.max(1,Number(input.limit)||20));return{integrationClientId:String(input.integrationClientId||'').trim()||null,status,category,from:safeDate(input.from),to:safeDate(input.to,true),referenceSuffix:suffix,page,limit,offset:(page-1)*limit};
}
const OUTCOME_LABELS=Object.freeze({received:'รับข้อมูลแล้ว',processing:'กำลังประมวลผล',processed:'บันทึกข้อมูลแล้ว',pending:'รอเชื่อมผู้พัก',rejected:'ข้อมูลถูกปฏิเสธ',retrying:'กำลังลองประมวลผลใหม่',dead:'หยุดประมวลผลแล้ว'});
function nextAction(row,flow){
  if(row.pending_reason==='subject_mapping')return'ตรวจสอบผู้พักรอเชื่อมในงานต้องตรวจ';
  if(['group_binding_missing','group_binding_mismatch'].includes(row.group_reconciliation_status))return'ตรวจสอบ GroupBinding ของ Care Profile ในงานต้องตรวจ';
  if(['retrying','dead_letter'].includes(row.notification_delivery_status))return'ตรวจสอบรายการส่งแจ้งเตือนในงานต้องตรวจ โดยไม่สั่งส่งซ้ำจากหน้านี้';
  if(row.status==='retrying')return'ระบบจะลองประมวลผลใหม่ตามเวลาที่กำหนด ไม่ต้องสั่งซ้ำ';
  if(['rejected','dead'].includes(row.status))return'ตรวจรหัสสาเหตุและการตั้งค่าระบบต้นทาง แล้วแก้ที่ต้นเหตุ';
  if(flow.attention)return'ตรวจสอบขั้นตอนที่ระบุว่าต้องตรวจ';return'ไม่ต้องดำเนินการเพิ่มเติม';
}
function historyProjection(row,{detail=false}={}){
  const flow=flowForEvent(row);const notification=row.notification_delivery_status?{status:row.notification_delivery_status,
    attempts:Number(row.delivery_attempts)||0,errorCode:row.delivery_error_code||null,createdAt:row.notification_created_at||null,
    nextAttemptAt:row.notification_next_attempt_at||null,statusUpdatedAt:row.notification_updated_at||null,
    providerAccepted:row.notification_delivery_status==='sent'&&Boolean(row.provider_acceptance),
    providerStateLabel:row.notification_delivery_status==='sent'?'ผู้ให้บริการรับคำขอส่งแล้ว':row.notification_delivery_status==='retrying'?'ระบบกำลังลองส่งใหม่':row.notification_delivery_status==='dead_letter'?'ระบบหยุดลองส่งแล้ว':['pending','sending'].includes(row.notification_delivery_status)?'อยู่ในคิวส่ง':'ไม่มีข้อมูล'}:null;
  const item={eventKey:row.integration_event_id,safeReference:safeReference(row.integration_event_id),integration:{safeReference:safeReference(row.integration_client_id,'ระบบ'),displayName:row.integration_name||'ระบบเชื่อมต่อ',sourceSystem:row.source_system||null},
    eventType:row.event_type,receivedAt:row.created_at||null,outcome:row.status,outcomeLabel:OUTCOME_LABELS[row.status]||'ไม่ทราบผล',
    problemStage:flow.attention?.stage||flow.stages.find((stageItem)=>['current','failed','attention'].includes(stageItem.state))?.key||null,
    summary:flow.attention?.reason||OUTCOME_LABELS[row.status]||'ยังตรวจสอบไม่ได้',latestAt:row.processed_at||row.updated_at||row.created_at||null,
    identity:{centerName:row.center_name||null,residentName:row.resident_name||null,room:row.room||null,
      residentState:row.resident_id?'resolved':row.pending_reason==='subject_mapping'?'unresolved':'unknown',careProfileState:row.care_profile_id?'resolved':'unknown'},
    familyDestination:{state:(row.family_destination_verified||row.verified_line_group_id)?'resolved':['group_binding_missing','group_binding_mismatch'].includes(row.group_reconciliation_status)?'attention':row.event_type==='care.vitals.recorded'?'not_applicable':'unknown'},
    notification,nextOperatorAction:nextAction(row,flow)};
  if(detail)item.detail={stages:flow.stages,technical:{safeEventReference:item.safeReference,safeIntegrationReference:item.integration.safeReference,
    adapterVersion:null,adapterEvidence:'unavailable_for_event',safeErrorCode:row.last_error_code||row.delivery_error_code||null,
    processingState:row.status,processingAttemptCount:Number(row.attempt_count)||0,nextProcessingAttemptAt:row.next_attempt_at||null,
    idempotencyEvidence:'event_id_unique_but_duplicate_receipt_count_not_persisted'}};
  return item;
}
function createIntegrationControlCenterService(overrides={}){
  const platform=overrides.platformService||platformService;
  const events=overrides.eventRepository||createIntegrationEventRepository();
  const adapters=overrides.adapterRepository||createIntegrationAdapterRepository();
  const control=overrides.controlRepository||createIntegrationControlCenterRepository();
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
  async function identityInspector({integrationClientId,status=null,page=1,limit=20}){
    const clientId=String(integrationClientId||'').trim();if(!clientId)throw Object.assign(new Error('กรุณาระบุระบบเชื่อมต่อ'),{code:'INTEGRATION_CLIENT_REQUIRED',status:400});
    const allowed=['mapped','pending_subject_mapping','inactive','ambiguous'];const cleanStatus=String(status||'').trim()||null;
    if(cleanStatus&&!allowed.includes(cleanStatus))throw Object.assign(new Error('ตัวกรองสถานะไม่ถูกต้อง'),{code:'INVALID_IDENTITY_STATUS',status:400});
    const boundedPage=Math.max(1,Number(page)||1);const boundedLimit=Math.min(50,Math.max(1,Number(limit)||20));
    const client=await platform.inspectIntegrationClient(clientId);const query={integrationClientId:clientId,status:cleanStatus,limit:boundedLimit,offset:(boundedPage-1)*boundedLimit};
    const [rows,count]=await Promise.all([control.listIdentityChains(query),control.countIdentityChains(query)]);const total=Number(count?.total)||0;
    return{integrationClient:{integrationClientId:client.integrationClientId,displayName:client.displayName,sourceSystem:client.sourceSystem},
      items:rows.map(identityProjection),pagination:{page:boundedPage,limit:boundedLimit,total,totalPages:Math.ceil(total/boundedLimit)}};
  }
  async function history(input={}){const query=historyQuery(input);const [rows,count]=await Promise.all([control.listHistory(query),control.countHistory(query)]);const total=Number(count?.total)||0;return{items:rows.map((row)=>historyProjection(row)),pagination:{page:query.page,limit:query.limit,total,totalPages:Math.ceil(total/query.limit)},filters:{status:query.status,category:query.category,from:input.from||null,to:input.to||null,reference:input.reference||null}};}
  async function historyDetail({eventKey}){const key=String(eventKey||'').trim();if(!/^[A-Za-z0-9_-]{3,80}$/.test(key))throw Object.assign(new Error('รหัสเหตุการณ์ไม่ถูกต้อง'),{code:'INVALID_HISTORY_EVENT',status:400});const row=await control.findHistoryEvent(key);if(!row)throw Object.assign(new Error('ไม่พบเหตุการณ์'),{code:'INTEGRATION_EVENT_NOT_FOUND',status:404});return{item:historyProjection(row,{detail:true})};}
  return{overview,mappingInspector,identityInspector,history,historyDetail};
}
const integrationControlCenterService=createIntegrationControlCenterService();
module.exports={STAGE_DEFINITIONS,ERROR_LABELS,TRANSFORM_LABELS,MATCH_METHODS,HISTORY_STATUSES,HISTORY_CATEGORIES,safeReference,flowForEvent,locatorPath,mappingProjection,identityProjection,historyQuery,historyProjection,createIntegrationControlCenterService,integrationControlCenterService};
