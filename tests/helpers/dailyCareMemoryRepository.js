function createDailyCareMemoryRepository() {
  const state={reports:[],items:[],links:[],events:[]}; let tick=0;
  const stamp=()=>new Date(Date.UTC(2026,7,27,2,0,tick++)).toISOString();
  const clone=(row)=>row?JSON.parse(JSON.stringify(row)):null;
  const detail=(row)=>row?{
    ...clone(row),
    items:state.items.filter((item)=>item.daily_report_id===row.daily_report_id)
      .sort((a,b)=>a.source_ordinal-b.source_ordinal).map(clone),
    vital_signs:state.links.filter((link)=>link.daily_report_id===row.daily_report_id)
      .map((link)=>clone(link.snapshot||{vital_set_id:link.vital_set_id,observations:[]})),
  }:null;
  return {state,
    async insertReport(record) {
      const row={
        daily_report_id:record.dailyReportId,report_group_id:record.reportGroupId,
        version_no:record.versionNo,supersedes_report_id:record.supersedesReportId,
        organization_id:record.organizationId,center_id:record.centerId,resident_id:record.residentId,
        care_profile_id:record.careProfileId,status:record.status,occurred_at:record.occurredAt,
        care_date:record.careDate,shift_code:record.shiftCode,shift_source_label:record.shiftSourceLabel,
        source_recorded_at:record.sourceRecordedAt,recorded_at:stamp(),
        recorded_by_actor_type:record.actorType,recorded_by_actor_reference:record.actorReference,
        recorder_display_name:record.recorderDisplayName,submitted_at:record.submittedAt,
        submitted_by_actor_reference:record.submittedByActorReference,returned_at:null,
        returned_by_actor_reference:null,return_reason:null,finalized_at:record.finalizedAt,
        finalized_by_actor_type:record.finalizedByActorType,
        finalized_by_actor_reference:record.finalizedByActorReference,
        finalizer_display_name:record.finalizerDisplayName,source_type:record.sourceType,
        source_system:record.sourceSystem,integration_client_id:record.integrationClientId,
        integration_event_id:record.integrationEventId,external_record_id:record.externalRecordId,
        external_staff_id:record.externalStaffId,
        external_staff_display_name:record.externalStaffDisplayName,
        voided_at:null,voided_by_actor_reference:null,void_reason:null,
      };
      state.reports.push(row); return clone(row);
    },
    async insertItem(record) {
      const row={daily_item_id:record.dailyItemId,daily_report_id:record.dailyReportId,
        source_ordinal:record.sourceOrdinal,item_type:record.itemType,value_type:record.valueType,
        source_value_text:record.sourceValueText,text_value:record.textValue,
        numeric_value:record.numericValue,boolean_value:record.booleanValue,source_unit:record.sourceUnit};
      state.items.push(row);return clone(row);
    },
    async linkVital(dailyReportId,vitalSetId,snapshot=null) {
      if(state.links.some((item)=>item.daily_report_id===dailyReportId&&item.vital_set_id===vitalSetId))return null;
      const normalizedSnapshot=snapshot?{
        vital_set_id:snapshot.vitalSetId,status:snapshot.status,occurred_at:snapshot.occurredAt,
        recorded_at:snapshot.recordedAt,source_type:snapshot.sourceType,
        observations:(snapshot.observations||[]).map((observation,index)=>({
          vital_observation_id:`MEM-${vitalSetId}-${index+1}`,source_ordinal:index+1,
          measurement_type:observation.measurementType,source_value_text:observation.sourceValueText,
          numeric_value:observation.numericValue,source_unit:observation.sourceUnit,
          canonical_unit:observation.canonicalUnit,measurement_context:observation.context||null,
        })),
      }:null;
      const row={daily_report_id:dailyReportId,vital_set_id:vitalSetId,snapshot:normalizedSnapshot};
      state.links.push(row);return clone(row);
    },
    async insertEvent(record) {
      const row={daily_event_id:record.dailyEventId,daily_report_id:record.dailyReportId,
        event_type:record.eventType,actor_type:record.actorType,actor_reference:record.actorReference,
        metadata:{...(record.metadata||{})},occurred_at:stamp()};state.events.push(row);return clone(row);
    },
    async findReport(id){return clone(state.reports.find((row)=>row.daily_report_id===id));},
    async findReportForUpdate(id){return clone(state.reports.find((row)=>row.daily_report_id===id));},
    async findAuthoritativeFinalized(id){
      const row=state.reports.find((item)=>item.daily_report_id===id);
      if(!row||row.status!=='finalized')return null;
      const latest=Math.max(...state.reports.filter((item)=>item.report_group_id===row.report_group_id
        &&(item.status==='finalized'||(item.status==='voided'&&item.finalized_at)))
        .map((item)=>Number(item.version_no)));
      return Number(row.version_no)===latest?clone(row):null;
    },
    async findByExternalRecord(clientId,externalId){return clone(state.reports.find((row)=>row.integration_client_id===clientId&&row.external_record_id===externalId));},
    async listItems(id){return state.items.filter((row)=>row.daily_report_id===id).sort((a,b)=>a.source_ordinal-b.source_ordinal).map(clone);},
    async listVitalLinks(id){return state.links.filter((row)=>row.daily_report_id===id).map(clone);},
    async getReportDetail(id){return detail(state.reports.find((row)=>row.daily_report_id===id));},
    async nextVersion(groupId){return{next_version:Math.max(0,...state.reports.filter((row)=>row.report_group_id===groupId).map((row)=>Number(row.version_no)))+1};},
    async findLatestVersionForUpdate(groupId){return clone(state.reports.filter((row)=>row.report_group_id===groupId).sort((a,b)=>Number(b.version_no)-Number(a.version_no)||String(b.daily_report_id).localeCompare(String(a.daily_report_id)))[0]);},
    async findSupersedingReport(reportId){return clone(state.reports.filter((row)=>row.supersedes_report_id===reportId).sort((a,b)=>Number(b.version_no)-Number(a.version_no))[0]);},
    async markReturned({dailyReportId,actorReference,reason}){
      const row=state.reports.find((item)=>item.daily_report_id===dailyReportId&&item.status==='submitted');
      if(!row)return null;Object.assign(row,{status:'changes_requested',returned_at:stamp(),
        returned_by_actor_reference:actorReference,return_reason:reason});return clone(row);
    },
    async markFinalized({dailyReportId,actorType,actorReference,finalizerDisplayName}){
      const row=state.reports.find((item)=>item.daily_report_id===dailyReportId&&item.status==='submitted');
      if(!row)return null;Object.assign(row,{status:'finalized',finalized_at:stamp(),
        finalized_by_actor_type:actorType,finalized_by_actor_reference:actorReference,
        finalizer_display_name:finalizerDisplayName});return clone(row);
    },
    async voidReport({dailyReportId,actorReference,reason}){
      const row=state.reports.find((item)=>item.daily_report_id===dailyReportId&&item.status!=='voided');
      if(!row)return null;Object.assign(row,{status:'voided',voided_at:stamp(),
        voided_by_actor_reference:actorReference,void_reason:reason});return clone(row);
    },
    async listCenterWorkflow({centerId,statuses,actorReference,limit}){
      return state.reports.filter((row)=>row.center_id===centerId&&statuses.includes(row.status)
        &&(!actorReference||row.recorded_by_actor_reference===actorReference))
        .sort((a,b)=>String(a.submitted_at||a.recorded_at).localeCompare(String(b.submitted_at||b.recorded_at)))
        .slice(0,limit).map((row)=>{const projected=detail(row);const latest=Math.max(...state.reports.filter((item)=>item.report_group_id===row.report_group_id&&(item.status==='finalized'||(item.status==='voided'&&item.finalized_at))).map((item)=>Number(item.version_no)),0);projected.is_authoritative=row.status==='finalized'&&Number(row.version_no)===latest;return projected;});
    },
    async listHistory({careProfileId,centerId,from,to,cursor,limit}){
      return state.reports.filter((row)=>row.status==='finalized'&&row.care_profile_id===careProfileId
        &&Number(row.version_no)===Math.max(...state.reports.filter((item)=>item.report_group_id===row.report_group_id
          &&(item.status==='finalized'||(item.status==='voided'&&item.finalized_at)))
          .map((item)=>Number(item.version_no)))
        &&(!centerId||row.center_id===centerId)&&(!from||row.occurred_at>=from)&&(!to||row.occurred_at<=to)
        &&(!cursor||row.occurred_at<cursor.occurredAt||(row.occurred_at===cursor.occurredAt&&row.daily_report_id<cursor.dailyReportId)))
        .sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at)||b.daily_report_id.localeCompare(a.daily_report_id))
        .slice(0,limit+1).map(detail);
    },
  };
}

module.exports={createDailyCareMemoryRepository};
