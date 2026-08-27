function createDailyCareMemoryRepository(){
  const state={reports:[],items:[],links:[],events:[]};let tick=0;
  const stamp=()=>new Date(Date.UTC(2026,7,27,2,0,tick++)).toISOString();const clone=(row)=>row?{...row}:null;
  return {state,
    async insertReport(r){const row={daily_report_id:r.dailyReportId,organization_id:r.organizationId,center_id:r.centerId,resident_id:r.residentId,
      care_profile_id:r.careProfileId,status:'recorded',occurred_at:r.occurredAt,recorded_at:stamp(),recorded_by_actor_type:r.actorType,
      recorded_by_actor_reference:r.actorReference,source_type:r.sourceType,source_system:r.sourceSystem,integration_client_id:r.integrationClientId,
      integration_event_id:r.integrationEventId,external_record_id:r.externalRecordId,external_staff_id:r.externalStaffId,
      external_staff_display_name:r.externalStaffDisplayName,voided_at:null,void_reason:null};state.reports.push(row);return clone(row);},
    async insertItem(r){const row={daily_item_id:r.dailyItemId,daily_report_id:r.dailyReportId,source_ordinal:r.sourceOrdinal,item_type:r.itemType,
      value_type:r.valueType,source_value_text:r.sourceValueText,text_value:r.textValue,numeric_value:r.numericValue,boolean_value:r.booleanValue,source_unit:r.sourceUnit};state.items.push(row);return clone(row);},
    async linkVital(dailyReportId,vitalSetId){if(state.links.some((x)=>x.daily_report_id===dailyReportId&&x.vital_set_id===vitalSetId))return null;const row={daily_report_id:dailyReportId,vital_set_id:vitalSetId};state.links.push(row);return clone(row);},
    async insertEvent(r){const row={daily_event_id:r.dailyEventId,daily_report_id:r.dailyReportId,event_type:r.eventType,actor_type:r.actorType,actor_reference:r.actorReference,metadata:{...(r.metadata||{})},occurred_at:stamp()};state.events.push(row);return clone(row);},
    async findReport(id){return clone(state.reports.find((r)=>r.daily_report_id===id));},
    async findByExternalRecord(clientId,externalId){return clone(state.reports.find((r)=>r.integration_client_id===clientId&&r.external_record_id===externalId));},
    async listItems(id){return state.items.filter((r)=>r.daily_report_id===id).sort((a,b)=>a.source_ordinal-b.source_ordinal).map(clone);},
    async listVitalLinks(id){return state.links.filter((r)=>r.daily_report_id===id).map(clone);},
    async voidReport({dailyReportId,actorReference,reason}){const row=state.reports.find((r)=>r.daily_report_id===dailyReportId&&r.status==='recorded');if(!row)return null;Object.assign(row,{status:'voided',voided_at:stamp(),voided_by_actor_reference:actorReference,void_reason:reason});return clone(row);},
    async listHistory({careProfileId,centerId,from,to,cursor,limit}){return state.reports.filter((r)=>r.status==='recorded'&&r.care_profile_id===careProfileId&&(!centerId||r.center_id===centerId)&&(!from||r.occurred_at>=from)&&(!to||r.occurred_at<=to)&&(!cursor||r.occurred_at<cursor.occurredAt||(r.occurred_at===cursor.occurredAt&&r.daily_report_id<cursor.dailyReportId))).sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at)||b.daily_report_id.localeCompare(a.daily_report_id)).slice(0,limit+1).map((r)=>({...clone(r),items:state.items.filter((i)=>i.daily_report_id===r.daily_report_id).sort((a,b)=>a.source_ordinal-b.source_ordinal).map(clone),vital_signs:[]}));},
  };
}
module.exports={createDailyCareMemoryRepository};
