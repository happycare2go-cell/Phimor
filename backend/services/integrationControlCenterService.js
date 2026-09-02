const {platformService}=require('./platformService');
const {createIntegrationEventRepository}=require('./integrationEventRepository');

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
function createIntegrationControlCenterService(overrides={}){
  const platform=overrides.platformService||platformService;
  const events=overrides.eventRepository||createIntegrationEventRepository();
  async function overview(input={}){
    const directory=await platform.listIntegrationClientDirectory({...input,view:input.view||'current',limit:Math.min(50,Math.max(1,Number(input.limit)||20))});
    const rows=await events.listLatestForClients(directory.items.map((item)=>item.integrationClientId));
    const latest=new Map(rows.map((row)=>[row.integration_client_id,row]));
    return{items:directory.items.map((client)=>({integrationClientId:client.integrationClientId,
      displayName:client.displayName,clientStatus:client.status,...flowForEvent(latest.get(client.integrationClientId)||null)})),
      pagination:directory.pagination,refreshedAt:new Date().toISOString()};
  }
  return{overview};
}
const integrationControlCenterService=createIntegrationControlCenterService();
module.exports={STAGE_DEFINITIONS,ERROR_LABELS,safeReference,flowForEvent,createIntegrationControlCenterService,integrationControlCenterService};
