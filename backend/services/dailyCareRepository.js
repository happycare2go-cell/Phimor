const { databaseQuery } = require('../db');

const DETAIL_SELECT = `d.*,
  COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.source_ordinal,i.daily_item_id)
    FROM daily_care_items i WHERE i.daily_report_id=d.daily_report_id),'[]'::jsonb) items,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'vital_set_id',v.vital_set_id,'status',v.status,'occurred_at',v.occurred_at,
    'recorded_at',v.recorded_at,'source_type',v.source_type,
    'observations',COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.source_ordinal,o.vital_observation_id)
      FROM vital_sign_observations o WHERE o.vital_set_id=v.vital_set_id),'[]'::jsonb)
  ) ORDER BY v.occurred_at,v.vital_set_id)
    FROM daily_care_vital_links l JOIN vital_sign_sets v ON v.vital_set_id=l.vital_set_id
    WHERE l.daily_report_id=d.daily_report_id),'[]'::jsonb) vital_signs`;

function createDailyCareRepository({ queryFn = databaseQuery } = {}) {
  const one = async (sql, params=[]) => (await queryFn(sql, params)).rows[0] || null;
  const many = async (sql, params=[]) => (await queryFn(sql, params)).rows;
  return {
    insertReport(record) {
      return one(`INSERT INTO daily_care_reports (
        daily_report_id,report_group_id,version_no,supersedes_report_id,
        organization_id,center_id,resident_id,care_profile_id,status,occurred_at,
        care_date,shift_code,shift_source_label,source_recorded_at,
        recorded_by_actor_type,recorded_by_actor_reference,recorder_display_name,
        submitted_at,submitted_by_actor_reference,
        finalized_at,finalized_by_actor_type,finalized_by_actor_reference,finalizer_display_name,
        source_type,source_system,integration_client_id,integration_event_id,
        external_record_id,external_staff_id,external_staff_display_name
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30
      ) RETURNING *`, [
        record.dailyReportId,record.reportGroupId,record.versionNo,record.supersedesReportId,
        record.organizationId,record.centerId,record.residentId,record.careProfileId,
        record.status,record.occurredAt,record.careDate,record.shiftCode,record.shiftSourceLabel,
        record.sourceRecordedAt,record.actorType,record.actorReference,record.recorderDisplayName,
        record.submittedAt,record.submittedByActorReference,record.finalizedAt,
        record.finalizedByActorType,record.finalizedByActorReference,record.finalizerDisplayName,
        record.sourceType,record.sourceSystem,record.integrationClientId,record.integrationEventId,
        record.externalRecordId,record.externalStaffId,record.externalStaffDisplayName,
      ]);
    },

    insertItem(record) {
      return one(`INSERT INTO daily_care_items (
        daily_item_id,daily_report_id,source_ordinal,item_type,value_type,source_value_text,
        text_value,numeric_value,boolean_value,source_unit
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [
        record.dailyItemId,record.dailyReportId,record.sourceOrdinal,record.itemType,record.valueType,
        record.sourceValueText,record.textValue,record.numericValue,record.booleanValue,record.sourceUnit,
      ]);
    },

    linkVital(dailyReportId, vitalSetId) {
      return one(`INSERT INTO daily_care_vital_links (daily_report_id,vital_set_id)
        VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING *`, [dailyReportId,vitalSetId]);
    },

    insertEvent(record) {
      return one(`INSERT INTO daily_care_events
        (daily_event_id,daily_report_id,event_type,actor_type,actor_reference,metadata)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`, [record.dailyEventId,record.dailyReportId,
        record.eventType,record.actorType,record.actorReference,JSON.stringify(record.metadata||{})]);
    },

    findReport(id) { return one('SELECT * FROM daily_care_reports WHERE daily_report_id=$1', [id]); },
    findReportForUpdate(id) { return one('SELECT * FROM daily_care_reports WHERE daily_report_id=$1 FOR UPDATE', [id]); },
    findByExternalRecord(clientId, externalId) {
      return one(`SELECT * FROM daily_care_reports
        WHERE integration_client_id=$1 AND external_record_id=$2`, [clientId,externalId]);
    },
    listItems(id) {
      return many('SELECT * FROM daily_care_items WHERE daily_report_id=$1 ORDER BY source_ordinal,daily_item_id', [id]);
    },
    listVitalLinks(id) {
      return many('SELECT vital_set_id FROM daily_care_vital_links WHERE daily_report_id=$1 ORDER BY vital_set_id', [id]);
    },
    getReportDetail(id) {
      return one(`SELECT ${DETAIL_SELECT} FROM daily_care_reports d WHERE d.daily_report_id=$1`, [id]);
    },
    nextVersion(reportGroupId) {
      return one(`SELECT COALESCE(MAX(version_no),0)+1 AS next_version
        FROM daily_care_reports WHERE report_group_id=$1`, [reportGroupId]);
    },
    findSupersedingReport(reportId) {
      return one(`SELECT * FROM daily_care_reports
        WHERE supersedes_report_id=$1 ORDER BY version_no DESC,daily_report_id DESC LIMIT 1`, [reportId]);
    },

    markReturned({ dailyReportId, actorReference, reason }) {
      return one(`UPDATE daily_care_reports SET status='changes_requested',
        returned_at=CURRENT_TIMESTAMP,returned_by_actor_reference=$2,return_reason=$3,
        updated_at=CURRENT_TIMESTAMP
        WHERE daily_report_id=$1 AND status='submitted' RETURNING *`,
      [dailyReportId,actorReference,reason]);
    },

    markFinalized({ dailyReportId, actorType, actorReference, finalizerDisplayName }) {
      return one(`UPDATE daily_care_reports SET status='finalized',
        finalized_at=CURRENT_TIMESTAMP,finalized_by_actor_type=$2,
        finalized_by_actor_reference=$3,finalizer_display_name=$4,
        updated_at=CURRENT_TIMESTAMP
        WHERE daily_report_id=$1 AND status='submitted' RETURNING *`,
      [dailyReportId,actorType,actorReference,finalizerDisplayName]);
    },

    voidReport({dailyReportId,actorReference,reason}) {
      return one(`UPDATE daily_care_reports SET status='voided',voided_at=CURRENT_TIMESTAMP,
        voided_by_actor_reference=$2,void_reason=$3,updated_at=CURRENT_TIMESTAMP
        WHERE daily_report_id=$1 AND status IN ('recorded','submitted','changes_requested','finalized')
        RETURNING *`, [dailyReportId,actorReference,reason]);
    },

    async listCenterWorkflow({ centerId, statuses, actorReference = null, limit = 50 }) {
      const params = [centerId, statuses];
      const where = ['d.center_id=$1', 'd.status=ANY($2::varchar[])'];
      if (actorReference) { params.push(actorReference); where.push(`d.recorded_by_actor_reference=$${params.length}`); }
      params.push(limit);
      return many(`SELECT ${DETAIL_SELECT} FROM daily_care_reports d
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(d.submitted_at,d.recorded_at) ASC,d.daily_report_id ASC
        LIMIT $${params.length}`, params);
    },

    async listHistory({careProfileId,centerId,from,to,cursor,limit}) {
      const params=[careProfileId]; const where=["d.status='finalized'",'d.care_profile_id=$1'];
      if(centerId){params.push(centerId);where.push(`d.center_id=$${params.length}`);}
      if(from){params.push(from);where.push(`d.occurred_at >= $${params.length}`);}
      if(to){params.push(to);where.push(`d.occurred_at <= $${params.length}`);}
      if(cursor){params.push(cursor.occurredAt,cursor.dailyReportId);where.push(`(d.occurred_at,d.daily_report_id) < ($${params.length-1}::timestamptz,$${params.length})`);}
      params.push(limit+1);
      return many(`SELECT ${DETAIL_SELECT} FROM daily_care_reports d
        WHERE ${where.join(' AND ')}
        ORDER BY d.occurred_at DESC,d.daily_report_id DESC LIMIT $${params.length}`,params);
    },
  };
}

module.exports = { createDailyCareRepository };
