const { Centers, CenterStaff, Residents, id, withTransaction, now } = require('../db');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { platformService } = require('./platformService');
const { vitalSignService, projectSet:projectVitalSet } = require('./vitalSignService');
const { createDailyCareRepository } = require('./dailyCareRepository');
const {
  DailyCareError, requiredId, requiredTimestamp, optionalText, optionalCareDate,
  normalizeShift, normalizeItems,
} = require('../domain/dailyCare');
const { familyCareNotificationService } = require('./familyCareNotificationService');

function actorReference(value) {
  const clean=String(value||'').trim();
  if(!clean||clean.length>128) throw new DailyCareError('ACTOR_REQUIRED','ไม่พบผู้บันทึก',401);
  return clean;
}

function projectItem(row) {
  return {
    itemType:row.item_type, valueType:row.value_type,
    sourceValueText:row.source_value_text||null, textValue:row.text_value||null,
    numericValue:row.numeric_value===null||row.numeric_value===undefined?null:Number(row.numeric_value),
    booleanValue:row.boolean_value===null||row.boolean_value===undefined?null:Boolean(row.boolean_value),
    sourceUnit:row.source_unit||null,
  };
}

function projectReport(row, items=row.items||[], vitals=row.vital_signs||[], subject={}) {
  const projected = {
    dailyReportId:row.daily_report_id, status:row.status,
    versionNo:Number(row.version_no||1), occurredAt:row.occurred_at,
    careDate:row.care_date||null,
    shift:row.shift_code||row.shift_source_label
      ? { code:row.shift_code||null, sourceLabel:row.shift_source_label||null } : null,
    recordedAt:row.source_recorded_at||row.recorded_at,
    submittedAt:row.submitted_at||null, returnedAt:row.returned_at||null,
    returnReason:row.return_reason||null, finalizedAt:row.finalized_at||null,
    sourceType:row.source_type,
    centerName:row.center_name||null,
    recorderDisplayName:row.recorder_display_name||row.external_staff_display_name||null,
    finalizerDisplayName:row.finalizer_display_name||null,
    residentId:subject.residentId||null, careRecipientName:subject.careRecipientName||null, room:subject.room||null,
    items:items.map(projectItem),
    vitalSigns:vitals.map((vital)=>projectVitalSet(vital,vital.observations||[])),
  };
  if(typeof row.is_authoritative==='boolean')projected.isCurrent=row.is_authoritative;
  if(subject.mutationCapabilities)projected.mutationCapabilities=subject.mutationCapabilities;
  return projected;
}

function dailyItemToInput(row) {
  return {itemType:row.item_type,valueType:row.value_type,sourceValueText:row.source_value_text||null,
    textValue:row.text_value||null,numericValue:row.numeric_value===null||row.numeric_value===undefined?null:Number(row.numeric_value),
    booleanValue:row.boolean_value===null||row.boolean_value===undefined?null:Boolean(row.boolean_value),sourceUnit:row.source_unit||null};
}

function linkedVitalsToInput(rows, fallbackAt) {
  const observations=(rows||[]).flatMap((set)=>(set.observations||[]).map((row)=>({
    measurementType:row.measurement_type,sourceValueText:row.source_value_text,
    numericValue:Number(row.numeric_value),sourceUnit:row.source_unit,context:row.measurement_context||undefined,
  })));
  return observations.length?{occurredAt:rows[0]?.occurred_at||fallbackAt,observations}:null;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({occurredAt:row.occurred_at,dailyReportId:row.daily_report_id})).toString('base64url');
}
function decodeCursor(value) {
  if(!value)return null;
  try {
    const parsed=JSON.parse(Buffer.from(String(value),'base64url').toString('utf8'));
    return {occurredAt:requiredTimestamp(parsed.occurredAt,'INVALID_CURSOR'),dailyReportId:requiredId(parsed.dailyReportId,'Daily Report ID')};
  } catch(error) {
    if(error instanceof DailyCareError&&error.code==='INVALID_CURSOR')throw error;
    throw new DailyCareError('INVALID_CURSOR','cursor ไม่ถูกต้อง',400);
  }
}

function bangkokCareDate(iso) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit',
  }).formatToParts(new Date(iso));
  const values = Object.fromEntries(parts.map((part)=>[part.type,part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function notificationState(result) {
  if (result?.ok) return result.duplicate ? 'duplicate' : 'queued';
  if (result?.reason === 'group_binding_missing') return 'held_group_missing';
  if (result?.reason === 'group_binding_mismatch') return 'held_group_mismatch';
  if (result?.reason === 'no_family_recipient') return 'recipient_missing';
  return 'enqueue_failed';
}

function createDailyCareService(overrides={}) {
  const repository=overrides.repository||createDailyCareRepository();
  const centers=overrides.Centers||Centers; const staffTable=overrides.CenterStaff||CenterStaff;
  const residents=overrides.Residents||Residents;
  const authorize=overrides.authorizeCareProfileAccess||authorizeCareProfileAccess;
  const platform=overrides.platformService||platformService;
  const vitals=overrides.vitalSignService||vitalSignService;
  const idFactory=overrides.idFactory||id; const transact=overrides.withTransaction||withTransaction;
  const clock=overrides.now||now;
  const familyNotifications=overrides.familyCareNotificationService||familyCareNotificationService;

  async function assertSubject({organizationId,centerId,residentId,careProfileId}) {
    const center=await centers.findOne((row)=>row.center_id===centerId&&row.status==='active');
    if(!center)throw new DailyCareError('CENTER_UNAVAILABLE','ศูนย์ไม่พร้อมใช้งาน',403);
    const organization=await platform.getOrganizationForCenter(centerId);
    if(!organization||organization.organizationId!==organizationId||organization.status!=='active') {
      throw new DailyCareError('TENANT_MISMATCH','ข้อมูล tenant ไม่ถูกต้อง',403);
    }
    const resident=await residents.findOne((row)=>row.resident_id===residentId&&row.center_id===centerId&&row.status==='active');
    if(!resident)throw new DailyCareError('RESIDENT_NOT_IN_CENTER','ไม่พบผู้พักในศูนย์นี้',403);
    if(!resident.care_profile_id||resident.care_profile_id!==careProfileId) {
      throw new DailyCareError('CARE_PROFILE_RELATIONSHIP_MISMATCH','Care Profile ไม่สัมพันธ์กับผู้พัก',403);
    }
    return {center,resident,organization};
  }

  async function requireStaff({ lineUserId, centerId, roles=['owner','manager','staff'] }) {
    const staff=await staffTable.findOne((row)=>row.center_id===centerId&&row.line_user_id===lineUserId
      && row.status==='active'&&roles.includes(row.role));
    if(!staff)throw new DailyCareError('CENTER_ACCESS_DENIED','ไม่มีสิทธิ์ดำเนินการรายงานของศูนย์นี้',403);
    return staff;
  }

  async function validateExternalClient({integrationClientId,organizationId,centerId}) {
    const client=await platform.inspectIntegrationClient(integrationClientId);
    if(client.status!=='active'||client.organizationId!==organizationId) {
      throw new DailyCareError('INTEGRATION_TENANT_MISMATCH','Integration Client ไม่สัมพันธ์กับ tenant',403);
    }
    if(!client.centers.some((scope)=>scope.center_id===centerId)) {
      throw new DailyCareError('INTEGRATION_CENTER_SCOPE_DENIED','Integration Client ไม่มีสิทธิ์ในศูนย์นี้',403);
    }
  }

  async function createCanonicalReport({
    tenant,subject,occurredAt,careDate=null,shift=null,items,vitalSigns=null,provenance,
    lifecycleStatus,reportGroupId=null,versionNo=1,supersedesReportId=null,
  }) {
    const organizationId=requiredId(tenant?.organizationId,'Organization ID');
    const centerId=requiredId(subject?.centerId,'Center ID');
    const residentId=requiredId(subject?.residentId,'Resident ID');
    const careProfileId=requiredId(subject?.careProfileId,'Care Profile ID');
    await assertSubject({organizationId,centerId,residentId,careProfileId});
    if(!await platform.isCenterCapabilityEnabled(centerId,'daily_care_v1')) {
      throw new DailyCareError('CAPABILITY_DISABLED','ศูนย์ยังไม่ได้เปิดใช้การดูแลประจำวัน',403);
    }
    if(!['submitted','finalized'].includes(lifecycleStatus)) {
      throw new DailyCareError('INVALID_INITIAL_STATUS','สถานะเริ่มต้นของรายงานไม่ถูกต้อง',400);
    }
    const normalized=normalizeItems(items); const at=requiredTimestamp(occurredAt);
    const normalizedCareDate=optionalCareDate(careDate)||bangkokCareDate(at);
    const normalizedShift=normalizeShift(shift);
    const sourceType=provenance?.sourceType;
    if(!['native_phimor','external_integration'].includes(sourceType)) {
      throw new DailyCareError('INVALID_SOURCE_TYPE','แหล่งข้อมูลไม่ถูกต้อง',400);
    }
    if(sourceType==='native_phimor'&&lifecycleStatus!=='submitted') {
      throw new DailyCareError('NATIVE_REVIEW_REQUIRED','รายงานจาก PHIMOR ต้องผ่านการตรวจสอบก่อนยืนยัน',409);
    }
    if(sourceType==='external_integration'&&lifecycleStatus!=='finalized') {
      throw new DailyCareError('EXTERNAL_FINALIZED_REQUIRED','Integration ต้องส่งเฉพาะรายงานที่ยืนยันแล้ว',400);
    }
    const sourceSystem=optionalText(provenance?.sourceSystem,100);
    if(!sourceSystem)throw new DailyCareError('SOURCE_SYSTEM_REQUIRED','ไม่พบระบบต้นทาง',400);
    const integrationClientId=sourceType==='external_integration'
      ? requiredId(provenance?.integrationClientId,'Integration Client ID'):null;
    const externalRecordId=sourceType==='external_integration'
      ? requiredId(provenance?.externalRecordId,'External record ID'):null;
    const externalFinalizerReference=sourceType==='external_integration'
      ? optionalText(provenance?.externalFinalizerReference,160):null;
    const actorType=sourceType==='external_integration'?'integration_client':'center_staff';
    const actor=actorReference(provenance?.actorReference);
    if(integrationClientId)await validateExternalClient({integrationClientId,organizationId,centerId});

    return transact(`daily-create:${integrationClientId||centerId}:${externalRecordId||`${reportGroupId||residentId}:${versionNo}`}`,async()=>{
      if(integrationClientId) {
        const duplicate=await repository.findByExternalRecord(integrationClientId,externalRecordId);
        if(duplicate) {
          const detail=await repository.getReportDetail(duplicate.daily_report_id);
          return {duplicate:true,item:projectReport(detail)};
        }
      }
      const dailyReportId=idFactory('DCR');
      const groupId=reportGroupId||dailyReportId;
      const submittedAt=lifecycleStatus==='submitted' ? clock() : null;
      const finalizedAt=lifecycleStatus==='finalized'
        ? requiredTimestamp(provenance?.finalizedAt,'INVALID_FINALIZED_AT') : null;
      const finalizedByActorReference=lifecycleStatus==='finalized'
        ? actorReference(provenance?.finalizedByActorReference||actor) : null;
      const row=await repository.insertReport({
        dailyReportId,reportGroupId:groupId,versionNo,supersedesReportId,
        organizationId,centerId,residentId,careProfileId,status:lifecycleStatus,occurredAt:at,
        careDate:normalizedCareDate,shiftCode:normalizedShift.code,shiftSourceLabel:normalizedShift.sourceLabel,
        sourceRecordedAt:provenance?.sourceRecordedAt?requiredTimestamp(provenance.sourceRecordedAt,'INVALID_RECORDED_AT'):null,
        actorType,actorReference:actor,recorderDisplayName:optionalText(provenance?.recorderDisplayName||provenance?.externalStaffDisplayName,160),
        submittedAt,submittedByActorReference:submittedAt?actor:null,
        finalizedAt,finalizedByActorType:finalizedAt?actorType:null,
        finalizedByActorReference,finalizerDisplayName:optionalText(provenance?.finalizerDisplayName,160),
        sourceType,sourceSystem,integrationClientId,
        integrationEventId:provenance?.integrationEventId||null,externalRecordId,
        externalStaffId:optionalText(provenance?.externalStaffId,160),
        externalStaffDisplayName:optionalText(provenance?.externalStaffDisplayName,160),
      });
      const stored=[];
      for(const item of normalized)stored.push(await repository.insertItem({dailyItemId:idFactory('DCI'),dailyReportId,...item}));
      const storedVitals=[];
      if(vitalSigns) {
        const vitalAt=requiredTimestamp(vitalSigns.occurredAt||at);
        const vitalResult=await vitals.recordCanonical({tenant:{organizationId},subject:{centerId,residentId,careProfileId},
          occurredAt:vitalAt,observations:vitalSigns.observations,
          provenance:{sourceType,sourceSystem,integrationClientId,integrationEventId:provenance?.integrationEventId||null,
            externalRecordId:integrationClientId?`${externalRecordId}:vitals`:null,
            externalStaffId:provenance?.externalStaffId||null,
            externalStaffDisplayName:provenance?.externalStaffDisplayName||null,actorReference:actor}});
        await repository.linkVital(dailyReportId,vitalResult.item.vitalSetId,vitalResult.item);
        storedVitals.push(vitalResult.item);
      }
      const eventType=lifecycleStatus==='finalized'?'finalized':(versionNo>1?'correction_submitted':'submitted');
      await repository.insertEvent({dailyEventId:idFactory('DCE'),dailyReportId,eventType,
        actorType,actorReference:actor,metadata:{itemTypes:normalized.map((item)=>item.itemType),
          hasVitalSigns:storedVitals.length>0,sourceType,versionNo,
          ...(externalFinalizerReference?{externalFinalizerReference}:{}),
          ...(versionNo>1&&provenance?.correctionReason?{correctionReason:provenance.correctionReason}:{})}});
      return {duplicate:false,item:{...projectReport(row,stored,[]),vitalSigns:storedVitals}};
    });
  }

  async function enqueueFinalizedNotificationByReport({dailyReportId,expectedLineGroupId=null}) {
    const reportId=requiredId(dailyReportId,'Daily Report ID');
    const authoritative=await repository.findAuthoritativeFinalized(reportId);
    if(!authoritative) {
      throw new DailyCareError('FINALIZED_REPORT_NOT_FOUND','ไม่พบรายงานที่ยืนยันแล้ว',404);
    }
    const row=await repository.getReportDetail(reportId);
    const resident=await residents.findOne((item)=>item.resident_id===row.resident_id
      && item.center_id===row.center_id&&item.care_profile_id===row.care_profile_id&&item.status==='active');
    const center=await centers.findOne((item)=>item.center_id===row.center_id&&item.status==='active');
    if(!resident||!center)throw new DailyCareError('REPORT_SUBJECT_UNAVAILABLE','ความสัมพันธ์ผู้รับการดูแลไม่พร้อมใช้งาน',409);
    try {
      const result=await familyNotifications.enqueueFinalized({kind:'daily_care',careProfileId:row.care_profile_id,
        resourceId:reportId,expectedLineGroupId,
        projection:{careRecipientName:resident.full_name||null,room:resident.room||null,
          centerDisplayName:center.name||null,careDate:row.care_date||null,occurredAt:row.occurred_at,
          recordedAt:row.source_recorded_at||row.recorded_at,finalizedAt:row.finalized_at,
          dailyCare:(row.items||[]).map(projectItem),
          vitalSigns:(row.vital_signs||[]).flatMap((item)=>(item.observations||[]).map((observation)=>({
            measurementType:observation.measurement_type,sourceValueText:observation.source_value_text,
            numericValue:observation.numeric_value===null?null:Number(observation.numeric_value),
            sourceUnit:observation.source_unit,canonicalUnit:observation.canonical_unit,
            context:observation.measurement_context||null,
          }))),
          recorderDisplayName:row.recorder_display_name||row.external_staff_display_name||null,
          finalizerDisplayName:row.finalizer_display_name||null}});
      return {...result,notificationStatus:notificationState(result)};
    } catch (_error) {
      return {ok:false,reason:'enqueue_failed',notificationStatus:'enqueue_failed',
        groupReconciliationStatus:expectedLineGroupId?'group_binding_missing':'no_expected_group',
        expectedLineGroupId:expectedLineGroupId||null,verifiedLineGroupId:null};
    }
  }

  async function recordCanonical(input) {
    const result=await createCanonicalReport({...input,lifecycleStatus:'finalized'});
    const notification=await enqueueFinalizedNotificationByReport({dailyReportId:result.item.dailyReportId,
      expectedLineGroupId:input.expectedLineGroupId||null});
    return {...result,notification};
  }

  async function recordNative({lineUserId,centerId,residentId,occurredAt,careDate=null,shift=null,items,vitalSigns}) {
    const centerKey=requiredId(centerId,'Center ID');const residentKey=requiredId(residentId,'Resident ID');
    const staff=await requireStaff({lineUserId,centerId:centerKey});
    const resident=await residents.findOne((row)=>row.resident_id===residentKey&&row.center_id===centerKey&&row.status==='active');
    if(!resident?.care_profile_id)throw new DailyCareError('RESIDENT_NOT_READY','ผู้พักยังไม่มี Care Profile ที่พร้อมใช้งาน',409);
    const organization=await platform.getOrganizationForCenter(centerKey);
    if(!organization)throw new DailyCareError('CENTER_TENANT_UNAVAILABLE','ไม่พบ tenant ของศูนย์',409);
    return createCanonicalReport({tenant:{organizationId:organization.organizationId},
      subject:{centerId:centerKey,residentId:residentKey,careProfileId:resident.care_profile_id},
      occurredAt,careDate,shift,items,vitalSigns,lifecycleStatus:'submitted',
      provenance:{sourceType:'native_phimor',sourceSystem:'phimor_center',
        actorReference:`center_staff:${staff.staff_id}`,
        recorderDisplayName:staff.display_name||staff.full_name||staff.name||null}});
  }

  async function listHistory({lineUserId,careProfileId,centerId=null,from=null,to=null,cursor=null,limit=20}) {
    const profileId=requiredId(careProfileId,'Care Profile ID');
    await authorize({lineUserId,careProfileId:profileId,permission:'view',centerId:centerId||null,requireActiveCenter:false});
    const bounded=Math.min(50,Math.max(1,Number(limit)||20));
    const fromAt=from?requiredTimestamp(from,'INVALID_DATE_RANGE'):null;
    const toAt=to?requiredTimestamp(to,'INVALID_DATE_RANGE'):null;
    if(fromAt&&toAt&&new Date(fromAt)>new Date(toAt))throw new DailyCareError('INVALID_DATE_RANGE','ช่วงวันที่ไม่ถูกต้อง',400);
    if(fromAt&&toAt&&new Date(toAt)-new Date(fromAt)>366*86400000)throw new DailyCareError('DATE_RANGE_TOO_LARGE','ช่วงวันที่ต้องไม่เกิน 366 วัน',400);
    const rows=await repository.listHistory({careProfileId:profileId,centerId:centerId||null,from:fromAt,to:toAt,cursor:decodeCursor(cursor),limit:bounded});
    const hasMore=rows.length>bounded;const page=rows.slice(0,bounded);
    const centerNames=new Map();
    for(const centerId of [...new Set(page.map((row)=>row.center_id).filter(Boolean))]) {
      const center=await centers.findOne((item)=>item.center_id===centerId);
      centerNames.set(centerId,center?.name||null);
    }
    return {items:page.map((row)=>projectReport({...row,center_name:centerNames.get(row.center_id)||null})),nextCursor:hasMore?encodeCursor(page.at(-1)):null};
  }

  async function listCenterWorkflow({lineUserId,centerId,status='submitted',limit=50}) {
    const centerKey=requiredId(centerId,'Center ID');
    const staff=await requireStaff({lineUserId,centerId:centerKey});
    if(!await platform.isCenterCapabilityEnabled(centerKey,'daily_care_v1')) {
      throw new DailyCareError('CAPABILITY_DISABLED','ศูนย์ยังไม่ได้เปิดใช้การดูแลประจำวัน',403);
    }
    const requested=String(status||'submitted');
    if(!['submitted','changes_requested','finalized','voided'].includes(requested)) {
      throw new DailyCareError('INVALID_REVIEW_STATUS','สถานะรายการตรวจไม่ถูกต้อง',400);
    }
    if(requested==='submitted'&&!['owner','manager'].includes(staff.role)) {
      const rows=await repository.listCenterWorkflow({centerId:centerKey,statuses:['submitted'],
        actorReference:`center_staff:${staff.staff_id}`,limit:Math.min(100,Math.max(1,Number(limit)||50))});
      return {items:await attachSubjects(rows,staff.role),role:staff.role};
    }
    const rows=await repository.listCenterWorkflow({centerId:centerKey,statuses:[requested],
      actorReference:staff.role==='staff'?`center_staff:${staff.staff_id}`:null,
      limit:Math.min(100,Math.max(1,Number(limit)||50))});
    return {items:await attachSubjects(rows,staff.role),role:staff.role};
  }

  async function attachSubjects(rows,staffRole) {
    const items=[];
    for(const row of rows) {
      const resident=await residents.findOne((item)=>item.resident_id===row.resident_id&&item.center_id===row.center_id);
      const canMutate=['owner','manager'].includes(staffRole)&&row.source_type==='native_phimor'
        &&row.status==='finalized'&&row.is_authoritative===true;
      items.push(projectReport(row,row.items||[],row.vital_signs||[],{
        residentId:resident?.resident_id||null,careRecipientName:resident?.full_name||null,room:resident?.room||null,
        mutationCapabilities:{canCreateCorrection:canMutate,canVoid:canMutate},
      }));
    }
    return items;
  }

  async function returnForCorrection({lineUserId,centerId,dailyReportId,reason}) {
    const centerKey=requiredId(centerId,'Center ID');const reportId=requiredId(dailyReportId,'Daily Report ID');
    const staff=await requireStaff({lineUserId,centerId:centerKey,roles:['owner','manager']});
    const cleanReason=optionalText(reason,500);
    if(!cleanReason)throw new DailyCareError('RETURN_REASON_REQUIRED','กรุณาระบุสิ่งที่ต้องแก้ไข',400);
    return transact(`daily-return:${reportId}`,async()=>{
      const current=await repository.findReportForUpdate(reportId);
      if(!current||current.center_id!==centerKey||current.source_type!=='native_phimor') {
        throw new DailyCareError('DAILY_REPORT_NOT_FOUND','ไม่พบรายงาน',404);
      }
      if(current.status==='changes_requested')return projectReport(await repository.getReportDetail(reportId));
      if(current.status!=='submitted')throw new DailyCareError('DAILY_REPORT_NOT_SUBMITTED','รายงานนี้ไม่อยู่ระหว่างรอตรวจ',409);
      const actor=`center_staff:${staff.staff_id}`;
      const updated=await repository.markReturned({dailyReportId:reportId,actorReference:actor,reason:cleanReason});
      await repository.insertEvent({dailyEventId:idFactory('DCE'),dailyReportId:reportId,eventType:'returned',
        actorType:'center_staff',actorReference:actor,metadata:{reasonCode:'changes_requested'}});
      return projectReport(updated,await repository.listItems(reportId),[]);
    });
  }

  async function resubmitReport({lineUserId,centerId,dailyReportId,occurredAt,careDate=null,shift=null,items,vitalSigns}) {
    const centerKey=requiredId(centerId,'Center ID');const reportId=requiredId(dailyReportId,'Daily Report ID');
    const staff=await requireStaff({lineUserId,centerId:centerKey});
    return transact(`daily-revision:${reportId}`,async()=>{
      const current=await repository.findReportForUpdate(reportId);
      if(!current||current.center_id!==centerKey||current.source_type!=='native_phimor') {
        throw new DailyCareError('DAILY_REPORT_NOT_FOUND','ไม่พบรายงาน',404);
      }
      if(current.status!=='changes_requested')throw new DailyCareError('DAILY_REPORT_NOT_RETURNED','รายงานนี้ยังไม่ได้ถูกส่งกลับแก้ไข',409);
      if(staff.role==='staff'&&current.recorded_by_actor_reference!==`center_staff:${staff.staff_id}`) {
        throw new DailyCareError('CENTER_ACCESS_DENIED','แก้ไขได้เฉพาะรายงานที่ตนเองบันทึก',403);
      }
      if(await repository.findSupersedingReport(reportId)) {
        throw new DailyCareError('DAILY_REPORT_ALREADY_RESUBMITTED','รายงานนี้ถูกแก้ไขและส่งตรวจอีกครั้งแล้ว',409);
      }
      const organization=await platform.getOrganizationForCenter(centerKey);
      const versionRow=await repository.nextVersion(current.report_group_id);
      return createCanonicalReport({tenant:{organizationId:organization.organizationId},
        subject:{centerId:centerKey,residentId:current.resident_id,careProfileId:current.care_profile_id},
        occurredAt,careDate,shift,items,vitalSigns,lifecycleStatus:'submitted',
        reportGroupId:current.report_group_id,versionNo:Number(versionRow.next_version),supersedesReportId:reportId,
        provenance:{sourceType:'native_phimor',sourceSystem:'phimor_center',
          actorReference:`center_staff:${staff.staff_id}`,
          recorderDisplayName:staff.display_name||staff.full_name||staff.name||null}});
    });
  }

  async function finalizeReport({lineUserId,centerId,dailyReportId}) {
    const centerKey=requiredId(centerId,'Center ID');const reportId=requiredId(dailyReportId,'Daily Report ID');
    const staff=await requireStaff({lineUserId,centerId:centerKey,roles:['owner','manager']});
    const finalized=await transact(`daily-finalize:${reportId}`,async()=>{
      const current=await repository.findReportForUpdate(reportId);
      if(!current||current.center_id!==centerKey||current.source_type!=='native_phimor') {
        throw new DailyCareError('DAILY_REPORT_NOT_FOUND','ไม่พบรายงาน',404);
      }
      if(current.status==='finalized')return {duplicate:true,row:current};
      if(current.status!=='submitted')throw new DailyCareError('DAILY_REPORT_NOT_SUBMITTED','รายงานนี้ไม่อยู่ระหว่างรอตรวจ',409);
      if(!await platform.isCenterCapabilityEnabled(centerKey,'daily_care_v1')) {
        throw new DailyCareError('CAPABILITY_DISABLED','ศูนย์ยังไม่ได้เปิดใช้การดูแลประจำวัน',403);
      }
      const actor=`center_staff:${staff.staff_id}`;
      const row=await repository.markFinalized({dailyReportId:reportId,actorType:'center_staff',actorReference:actor,
        finalizerDisplayName:staff.display_name||staff.full_name||staff.name||null});
      await repository.insertEvent({dailyEventId:idFactory('DCE'),dailyReportId:reportId,eventType:'finalized',
        actorType:'center_staff',actorReference:actor,metadata:{versionNo:Number(row.version_no||1)}});
      return {duplicate:false,row};
    });
    const notification=await enqueueFinalizedNotificationByReport({dailyReportId:reportId});
    const detail=await repository.getReportDetail(reportId);
    return {duplicate:finalized.duplicate,item:projectReport(detail),notification};
  }

  async function createCorrectionVersion({lineUserId,centerId,dailyReportId,reason}) {
    const centerKey=requiredId(centerId,'Center ID');const reportId=requiredId(dailyReportId,'Daily Report ID');
    const cleanReason=optionalText(reason,500);
    if(!cleanReason)throw new DailyCareError('CORRECTION_REASON_REQUIRED','กรุณาระบุเหตุผลที่สร้างฉบับแก้ไข',400);
    const staff=await requireStaff({lineUserId,centerId:centerKey,roles:['owner','manager']});
    const prior=await repository.findReport(reportId);
    if(!prior||prior.center_id!==centerKey)throw new DailyCareError('DAILY_REPORT_NOT_FOUND','ไม่พบรายการ',404);
    if(prior.source_type==='external_integration') {
      throw new DailyCareError('EXTERNAL_RECORD_LOCAL_MUTATION_DENIED','รายการจากระบบภายนอกต้องแก้ไขที่ระบบต้นทาง',409);
    }
    if(prior.status!=='finalized')throw new DailyCareError('DAILY_REPORT_NOT_FINALIZED','สร้างฉบับแก้ไขได้เฉพาะรายงานที่ยืนยันแล้ว',409);
    return transact(`daily-report-group:${prior.report_group_id}`,async()=>{
      const latest=await repository.findLatestVersionForUpdate(prior.report_group_id);
      if(!latest)throw new DailyCareError('DAILY_REPORT_NOT_FOUND','ไม่พบรายการ',404);
      if(latest.daily_report_id!==reportId) {
        if(latest.supersedes_report_id===reportId&&latest.status==='submitted') {
          return {duplicate:true,item:projectReport(await repository.getReportDetail(latest.daily_report_id))};
        }
        throw new DailyCareError('VERSION_CONFLICT','ข้อมูลรายการนี้มีการเปลี่ยนแปลง กรุณารีเฟรชแล้วลองอีกครั้ง',409);
      }
      const detail=await repository.getReportDetail(reportId);
      const organization=await platform.getOrganizationForCenter(centerKey);
      if(!organization)throw new DailyCareError('CENTER_TENANT_UNAVAILABLE','ไม่พบ tenant ของศูนย์',409);
      return createCanonicalReport({tenant:{organizationId:organization.organizationId},
        subject:{centerId:centerKey,residentId:detail.resident_id,careProfileId:detail.care_profile_id},
        occurredAt:detail.occurred_at,careDate:detail.care_date,
        shift:detail.shift_code||detail.shift_source_label?{code:detail.shift_code||null,sourceLabel:detail.shift_source_label||null}:null,
        items:(detail.items||[]).map(dailyItemToInput),vitalSigns:linkedVitalsToInput(detail.vital_signs,detail.occurred_at),
        lifecycleStatus:'submitted',reportGroupId:detail.report_group_id,
        versionNo:Number(detail.version_no)+1,supersedesReportId:reportId,
        provenance:{sourceType:'native_phimor',sourceSystem:'phimor_center',
          actorReference:`center_staff:${staff.staff_id}`,
          recorderDisplayName:staff.display_name||staff.full_name||staff.name||null,
          correctionReason:cleanReason}});
    });
  }

  async function voidReport({lineUserId,centerId,dailyReportId,reason}) {
    const centerKey=requiredId(centerId,'Center ID');const reportId=requiredId(dailyReportId,'Daily Report ID');
    const cleanReason=optionalText(reason,500);
    if(!cleanReason)throw new DailyCareError('VOID_REASON_REQUIRED','กรุณาระบุเหตุผล',400);
    const staff=await requireStaff({lineUserId,centerId:centerKey,roles:['owner','manager']});
    return transact(`notification-resource:daily_care:${reportId}`,async()=>{
      const current=await repository.findReportForUpdate(reportId);
      if(!current||current.center_id!==centerKey)throw new DailyCareError('DAILY_REPORT_NOT_FOUND','ไม่พบรายการ',404);
      if(current.source_type==='external_integration') {
        throw new DailyCareError('EXTERNAL_RECORD_LOCAL_MUTATION_DENIED','รายการจากระบบภายนอกต้องแก้ไขที่ระบบต้นทาง',409);
      }
      if(current.status==='voided')return projectReport(await repository.getReportDetail(reportId));
      if(current.status==='finalized'&&!await repository.findAuthoritativeFinalized(reportId)) {
        throw new DailyCareError('VERSION_CONFLICT','ข้อมูลรายการนี้มีการเปลี่ยนแปลง กรุณารีเฟรชแล้วลองอีกครั้ง',409);
      }
      const actor=`center_staff:${staff.staff_id}`;
      const updated=await repository.voidReport({dailyReportId:reportId,actorReference:actor,reason:cleanReason});
      await repository.insertEvent({dailyEventId:idFactory('DCE'),dailyReportId:reportId,eventType:'voided',
        actorType:'center_staff',actorReference:actor,metadata:{reasonCode:'human_void'}});
      if(current.status==='finalized'&&typeof familyNotifications.suppressFinalized==='function') {
        await familyNotifications.suppressFinalized({kind:'daily_care',resourceId:reportId});
      }
      return projectReport(updated,await repository.listItems(reportId),[]);
    });
  }

  return {recordCanonical,recordNative,listHistory,listCenterWorkflow,returnForCorrection,
    resubmitReport,finalizeReport,createCorrectionVersion,enqueueFinalizedNotificationByReport,voidReport,repository};
}

const dailyCareService=createDailyCareService();
module.exports={createDailyCareService,dailyCareService,projectItem,projectReport,dailyItemToInput,linkedVitalsToInput,decodeCursor,notificationState};
