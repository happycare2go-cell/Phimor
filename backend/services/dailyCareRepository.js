const { databaseQuery } = require('../db');

function createDailyCareRepository({ queryFn = databaseQuery } = {}) {
  const one = async (sql, params=[]) => (await queryFn(sql, params)).rows[0] || null;
  const many = async (sql, params=[]) => (await queryFn(sql, params)).rows;
  return {
    insertReport(record) { return one(`INSERT INTO daily_care_reports (
      daily_report_id,organization_id,center_id,resident_id,care_profile_id,occurred_at,
      recorded_by_actor_type,recorded_by_actor_reference,source_type,source_system,
      integration_client_id,integration_event_id,external_record_id,external_staff_id,external_staff_display_name
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [record.dailyReportId,record.organizationId,record.centerId,record.residentId,record.careProfileId,
      record.occurredAt,record.actorType,record.actorReference,record.sourceType,record.sourceSystem,
      record.integrationClientId,record.integrationEventId,record.externalRecordId,record.externalStaffId,record.externalStaffDisplayName]); },
    insertItem(record) { return one(`INSERT INTO daily_care_items (
      daily_item_id,daily_report_id,source_ordinal,item_type,value_type,source_value_text,
      text_value,numeric_value,boolean_value,source_unit
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [record.dailyItemId,record.dailyReportId,record.sourceOrdinal,record.itemType,record.valueType,
      record.sourceValueText,record.textValue,record.numericValue,record.booleanValue,record.sourceUnit]); },
    linkVital(dailyReportId, vitalSetId) { return one(`INSERT INTO daily_care_vital_links
      (daily_report_id,vital_set_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING *`, [dailyReportId,vitalSetId]); },
    insertEvent(record) { return one(`INSERT INTO daily_care_events
      (daily_event_id,daily_report_id,event_type,actor_type,actor_reference,metadata)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`, [record.dailyEventId,record.dailyReportId,
      record.eventType,record.actorType,record.actorReference,JSON.stringify(record.metadata||{})]); },
    findReport(id) { return one('SELECT * FROM daily_care_reports WHERE daily_report_id=$1',[id]); },
    findByExternalRecord(clientId,externalId) { return one(`SELECT * FROM daily_care_reports
      WHERE integration_client_id=$1 AND external_record_id=$2`,[clientId,externalId]); },
    listItems(id) { return many('SELECT * FROM daily_care_items WHERE daily_report_id=$1 ORDER BY source_ordinal,daily_item_id',[id]); },
    listVitalLinks(id) { return many('SELECT vital_set_id FROM daily_care_vital_links WHERE daily_report_id=$1 ORDER BY vital_set_id',[id]); },
    voidReport({dailyReportId,actorReference,reason}) { return one(`UPDATE daily_care_reports SET status='voided',voided_at=CURRENT_TIMESTAMP,
      voided_by_actor_reference=$2,void_reason=$3,updated_at=CURRENT_TIMESTAMP
      WHERE daily_report_id=$1 AND status='recorded' RETURNING *`,[dailyReportId,actorReference,reason]); },
    async listHistory({careProfileId,centerId,from,to,cursor,limit}) {
      const params=[careProfileId]; const where=["d.status='recorded'",'d.care_profile_id=$1'];
      if(centerId){params.push(centerId);where.push(`d.center_id=$${params.length}`);}
      if(from){params.push(from);where.push(`d.occurred_at >= $${params.length}`);}
      if(to){params.push(to);where.push(`d.occurred_at <= $${params.length}`);}
      if(cursor){params.push(cursor.occurredAt,cursor.dailyReportId);where.push(`(d.occurred_at,d.daily_report_id) < ($${params.length-1}::timestamptz,$${params.length})`);}
      params.push(limit+1);
      return many(`SELECT d.*,
        COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.source_ordinal,i.daily_item_id)
          FROM daily_care_items i WHERE i.daily_report_id=d.daily_report_id),'[]'::jsonb) items,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'vital_set_id',v.vital_set_id,'status',v.status,'occurred_at',v.occurred_at,
          'recorded_at',v.recorded_at,'source_type',v.source_type,
          'observations',COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.source_ordinal,o.vital_observation_id)
            FROM vital_sign_observations o WHERE o.vital_set_id=v.vital_set_id),'[]'::jsonb)
        ) ORDER BY v.occurred_at,v.vital_set_id)
          FROM daily_care_vital_links l JOIN vital_sign_sets v ON v.vital_set_id=l.vital_set_id
          WHERE l.daily_report_id=d.daily_report_id),'[]'::jsonb) vital_signs
        FROM daily_care_reports d WHERE ${where.join(' AND ')}
        ORDER BY d.occurred_at DESC,d.daily_report_id DESC LIMIT $${params.length}`,params);
    },
  };
}
module.exports = { createDailyCareRepository };
