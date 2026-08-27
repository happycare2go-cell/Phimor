const { Centers, CenterStaff, Residents, id, withTransaction } = require('../db');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { platformService } = require('./platformService');
const { vitalSignService } = require('./vitalSignService');
const { createDailyCareRepository } = require('./dailyCareRepository');
const { projectSet:projectVitalSet } = require('./vitalSignService');
const { DailyCareError, requiredId, requiredTimestamp, optionalText, normalizeItems } = require('../domain/dailyCare');
const { familyCareNotificationService } = require('./familyCareNotificationService');

function actorReference(value) {
  const clean=String(value||'').trim();
  if(!clean||clean.length>128) throw new DailyCareError('ACTOR_REQUIRED','ไม่พบผู้บันทึก',401);
  return clean;
}
function projectItem(row){return {itemType:row.item_type,valueType:row.value_type,
  sourceValueText:row.source_value_text||null,textValue:row.text_value||null,
  numericValue:row.numeric_value===null||row.numeric_value===undefined?null:Number(row.numeric_value),
  booleanValue:row.boolean_value===null||row.boolean_value===undefined?null:Boolean(row.boolean_value),
  sourceUnit:row.source_unit||null};}
function projectReport(row,items=row.items||[],vitals=row.vital_signs||[]){return {
  dailyReportId:row.daily_report_id,status:row.status,occurredAt:row.occurred_at,
  recordedAt:row.recorded_at,sourceType:row.source_type,items:items.map(projectItem),
  vitalSigns:vitals.map((vital)=>projectVitalSet(vital,vital.observations||[])),
};}
function encodeCursor(row){return Buffer.from(JSON.stringify({occurredAt:row.occurred_at,dailyReportId:row.daily_report_id})).toString('base64url');}
function decodeCursor(value){if(!value)return null;try{const parsed=JSON.parse(Buffer.from(String(value),'base64url').toString('utf8'));
  return {occurredAt:requiredTimestamp(parsed.occurredAt,'INVALID_CURSOR'),dailyReportId:requiredId(parsed.dailyReportId,'Daily Report ID')};
}catch(error){if(error instanceof DailyCareError&&error.code==='INVALID_CURSOR')throw error;throw new DailyCareError('INVALID_CURSOR','cursor ไม่ถูกต้อง',400);}}

function createDailyCareService(overrides={}){
  const repository=overrides.repository||createDailyCareRepository();
  const centers=overrides.Centers||Centers; const staffTable=overrides.CenterStaff||CenterStaff;
  const residents=overrides.Residents||Residents;
  const authorize=overrides.authorizeCareProfileAccess||authorizeCareProfileAccess;
  const platform=overrides.platformService||platformService;
  const vitals=overrides.vitalSignService||vitalSignService;
  const idFactory=overrides.idFactory||id; const transact=overrides.withTransaction||withTransaction;
  const familyNotifications=overrides.familyCareNotificationService||familyCareNotificationService;

  async function assertSubject({organizationId,centerId,residentId,careProfileId}){
    const center=await centers.findOne((row)=>row.center_id===centerId&&row.status==='active');
    if(!center)throw new DailyCareError('CENTER_UNAVAILABLE','ศูนย์ไม่พร้อมใช้งาน',403);
    const organization=await platform.getOrganizationForCenter(centerId);
    if(!organization||organization.organizationId!==organizationId||organization.status!=='active')throw new DailyCareError('TENANT_MISMATCH','ข้อมูล tenant ไม่ถูกต้อง',403);
    const resident=await residents.findOne((row)=>row.resident_id===residentId&&row.center_id===centerId&&row.status==='active');
    if(!resident)throw new DailyCareError('RESIDENT_NOT_IN_CENTER','ไม่พบผู้พักในศูนย์นี้',403);
    if(!resident.care_profile_id||resident.care_profile_id!==careProfileId)throw new DailyCareError('CARE_PROFILE_RELATIONSHIP_MISMATCH','Care Profile ไม่สัมพันธ์กับผู้พัก',403);
    return {center,resident,organization};
  }

  async function recordCanonical({tenant,subject,occurredAt,items,vitalSigns=null,provenance}){
    const organizationId=requiredId(tenant?.organizationId,'Organization ID');
    const centerId=requiredId(subject?.centerId,'Center ID'); const residentId=requiredId(subject?.residentId,'Resident ID');
    const careProfileId=requiredId(subject?.careProfileId,'Care Profile ID');
    const subjectDetails=await assertSubject({organizationId,centerId,residentId,careProfileId});
    if(!await platform.isCenterCapabilityEnabled(centerId,'daily_care_v1'))throw new DailyCareError('CAPABILITY_DISABLED','ศูนย์ยังไม่ได้เปิดใช้การดูแลประจำวัน',403);
    const normalized=normalizeItems(items); const at=requiredTimestamp(occurredAt);
    const sourceType=provenance?.sourceType;
    if(!['native_phimor','external_integration'].includes(sourceType))throw new DailyCareError('INVALID_SOURCE_TYPE','แหล่งข้อมูลไม่ถูกต้อง',400);
    const sourceSystem=optionalText(provenance?.sourceSystem,100);
    if(!sourceSystem)throw new DailyCareError('SOURCE_SYSTEM_REQUIRED','ไม่พบระบบต้นทาง',400);
    const integrationClientId=sourceType==='external_integration'?requiredId(provenance?.integrationClientId,'Integration Client ID'):null;
    const externalRecordId=sourceType==='external_integration'?requiredId(provenance?.externalRecordId,'External record ID'):null;
    const actorType=sourceType==='external_integration'?'integration_client':'center_staff';
    const actor=actorReference(provenance?.actorReference);
    if(integrationClientId){const client=await platform.inspectIntegrationClient(integrationClientId);
      if(client.status!=='active'||client.organizationId!==organizationId)throw new DailyCareError('INTEGRATION_TENANT_MISMATCH','Integration Client ไม่สัมพันธ์กับ tenant',403);
      if(!client.centers.some((scope)=>scope.center_id===centerId))throw new DailyCareError('INTEGRATION_CENTER_SCOPE_DENIED','Integration Client ไม่มีสิทธิ์ในศูนย์นี้',403);}

    return transact(`daily-record:${integrationClientId||centerId}:${externalRecordId||`${residentId}:${at}`}`,async()=>{
      if(integrationClientId){const duplicate=await repository.findByExternalRecord(integrationClientId,externalRecordId);
        if(duplicate)return {duplicate:true,item:projectReport(duplicate,await repository.listItems(duplicate.daily_report_id),[])};}
      const dailyReportId=idFactory('DCR');
      const row=await repository.insertReport({dailyReportId,organizationId,centerId,residentId,careProfileId,occurredAt:at,
        actorType,actorReference:actor,sourceType,sourceSystem,integrationClientId,
        integrationEventId:provenance?.integrationEventId||null,externalRecordId,
        externalStaffId:optionalText(provenance?.externalStaffId,160),
        externalStaffDisplayName:optionalText(provenance?.externalStaffDisplayName,160)});
      const stored=[];for(const item of normalized)stored.push(await repository.insertItem({dailyItemId:idFactory('DCI'),dailyReportId,...item}));
      const storedVitals=[];
      if(vitalSigns){
        const vitalAt=requiredTimestamp(vitalSigns.occurredAt||at);
        const vitalResult=await vitals.recordCanonical({tenant:{organizationId},subject:{centerId,residentId,careProfileId},
          occurredAt:vitalAt,observations:vitalSigns.observations,
          provenance:{sourceType,sourceSystem,integrationClientId,integrationEventId:provenance?.integrationEventId||null,
            externalRecordId:integrationClientId?`${externalRecordId}:vitals`:null,externalStaffId:provenance?.externalStaffId||null,
            externalStaffDisplayName:provenance?.externalStaffDisplayName||null,actorReference:actor},
          suppressFamilyNotification:true});
        await repository.linkVital(dailyReportId,vitalResult.item.vitalSetId);storedVitals.push(vitalResult.item);
      }
      await repository.insertEvent({dailyEventId:idFactory('DCE'),dailyReportId,eventType:'recorded',actorType,actorReference:actor,
        metadata:{itemTypes:normalized.map((item)=>item.itemType),hasVitalSigns:Boolean(vitalSigns),sourceType}});
      await familyNotifications.enqueueRecorded({kind:'daily_care',careProfileId,resourceId:dailyReportId,
        projection:{careRecipientName:subjectDetails.resident.full_name||null,room:subjectDetails.resident.room||null,
          centerDisplayName:subjectDetails.center.name||null,occurredAt:row.occurred_at,recordedAt:row.recorded_at,
          dailyCare:stored.map(projectItem),vitalSigns:storedVitals.flatMap((item)=>item.observations||[]),
          recorderDisplayName:optionalText(provenance?.recorderDisplayName||provenance?.externalStaffDisplayName,160)}});
      return {duplicate:false,item:{...projectReport(row,stored,[]),vitalSigns:storedVitals}};
    });
  }

  async function recordNative({lineUserId,centerId,residentId,occurredAt,items,vitalSigns}){
    const centerKey=requiredId(centerId,'Center ID');const residentKey=requiredId(residentId,'Resident ID');
    const staff=await staffTable.findOne((row)=>row.center_id===centerKey&&row.line_user_id===lineUserId&&row.status==='active'&&['owner','manager','staff'].includes(row.role));
    if(!staff)throw new DailyCareError('CENTER_ACCESS_DENIED','ไม่มีสิทธิ์บันทึกข้อมูลศูนย์นี้',403);
    const resident=await residents.findOne((row)=>row.resident_id===residentKey&&row.center_id===centerKey&&row.status==='active');
    if(!resident?.care_profile_id)throw new DailyCareError('RESIDENT_NOT_READY','ผู้พักยังไม่มี Care Profile ที่พร้อมใช้งาน',409);
    const organization=await platform.getOrganizationForCenter(centerKey);
    if(!organization)throw new DailyCareError('CENTER_TENANT_UNAVAILABLE','ไม่พบ tenant ของศูนย์',409);
    return recordCanonical({tenant:{organizationId:organization.organizationId},subject:{centerId:centerKey,residentId:residentKey,careProfileId:resident.care_profile_id},
      occurredAt,items,vitalSigns,provenance:{sourceType:'native_phimor',sourceSystem:'phimor_center',actorReference:`center_staff:${staff.staff_id}`,
        recorderDisplayName:staff.display_name||staff.full_name||staff.name||null}});
  }

  async function listHistory({lineUserId,careProfileId,centerId=null,from=null,to=null,cursor=null,limit=20}){
    const profileId=requiredId(careProfileId,'Care Profile ID');
    await authorize({lineUserId,careProfileId:profileId,permission:'view',centerId:centerId||null,requireActiveCenter:false});
    const bounded=Math.min(50,Math.max(1,Number(limit)||20));const fromAt=from?requiredTimestamp(from,'INVALID_DATE_RANGE'):null;const toAt=to?requiredTimestamp(to,'INVALID_DATE_RANGE'):null;
    if(fromAt&&toAt&&new Date(fromAt)>new Date(toAt))throw new DailyCareError('INVALID_DATE_RANGE','ช่วงวันที่ไม่ถูกต้อง',400);
    if(fromAt&&toAt&&new Date(toAt)-new Date(fromAt)>366*86400000)throw new DailyCareError('DATE_RANGE_TOO_LARGE','ช่วงวันที่ต้องไม่เกิน 366 วัน',400);
    const rows=await repository.listHistory({careProfileId:profileId,centerId:centerId||null,from:fromAt,to:toAt,cursor:decodeCursor(cursor),limit:bounded});
    const hasMore=rows.length>bounded;const page=rows.slice(0,bounded);
    return {items:page.map((row)=>projectReport(row)),nextCursor:hasMore?encodeCursor(page.at(-1)):null};
  }

  async function voidReport({lineUserId,centerId,dailyReportId,reason}){
    const centerKey=requiredId(centerId,'Center ID');const reportId=requiredId(dailyReportId,'Daily Report ID');const cleanReason=optionalText(reason,500);
    if(!cleanReason)throw new DailyCareError('VOID_REASON_REQUIRED','กรุณาระบุเหตุผล',400);
    const staff=await staffTable.findOne((row)=>row.center_id===centerKey&&row.line_user_id===lineUserId&&row.status==='active'&&['owner','manager'].includes(row.role));
    if(!staff)throw new DailyCareError('CENTER_ACCESS_DENIED','ไม่มีสิทธิ์ยกเลิกรายการนี้',403);
    return transact(`daily-void:${reportId}`,async()=>{const current=await repository.findReport(reportId);
      if(!current||current.center_id!==centerKey)throw new DailyCareError('DAILY_REPORT_NOT_FOUND','ไม่พบรายการ',404);
      if(current.status==='voided')return projectReport(current,await repository.listItems(reportId),[]);
      const actor=`center_staff:${staff.staff_id}`;const updated=await repository.voidReport({dailyReportId:reportId,actorReference:actor,reason:cleanReason});
      await repository.insertEvent({dailyEventId:idFactory('DCE'),dailyReportId:reportId,eventType:'voided',actorType:'center_staff',actorReference:actor,metadata:{reasonCode:'human_void'}});
      return projectReport(updated,await repository.listItems(reportId),[]);});
  }
  return {recordCanonical,recordNative,listHistory,voidReport,repository};
}
const dailyCareService=createDailyCareService();
module.exports={createDailyCareService,dailyCareService,projectItem,projectReport,decodeCursor};
