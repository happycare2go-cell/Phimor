const { databaseQuery } = require('../db');

function createVitalSignRepository({ queryFn = databaseQuery } = {}) {
  const one = async (sql, params = []) => (await queryFn(sql, params)).rows[0] || null;
  const many = async (sql, params = []) => (await queryFn(sql, params)).rows;

  return {
    insertSet(record) {
      return one(
        `INSERT INTO vital_sign_sets (
          vital_set_id, organization_id, center_id, resident_id, care_profile_id,
          occurred_at, recorded_by_actor_type, recorded_by_actor_reference,
          source_type, source_system, integration_client_id, integration_event_id,
          external_record_id, external_staff_id, external_staff_display_name
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING *`,
        [record.vitalSetId, record.organizationId, record.centerId, record.residentId,
          record.careProfileId, record.occurredAt, record.actorType, record.actorReference,
          record.sourceType, record.sourceSystem, record.integrationClientId,
          record.integrationEventId, record.externalRecordId, record.externalStaffId,
          record.externalStaffDisplayName]
      );
    },

    insertObservation(record) {
      return one(
        `INSERT INTO vital_sign_observations (
          vital_observation_id, vital_set_id, source_ordinal, measurement_type,
          source_value_text, numeric_value, source_unit, canonical_unit, measurement_context
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [record.vitalObservationId, record.vitalSetId, record.sourceOrdinal,
          record.measurementType, record.sourceValueText, record.numericValue,
          record.sourceUnit, record.canonicalUnit, record.measurementContext]
      );
    },

    insertEvent(record) {
      return one(
        `INSERT INTO vital_sign_events (
          vital_event_id, vital_set_id, event_type, actor_type, actor_reference, metadata
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
        [record.vitalEventId, record.vitalSetId, record.eventType, record.actorType,
          record.actorReference, JSON.stringify(record.metadata || {})]
      );
    },

    findSet(vitalSetId) {
      return one('SELECT * FROM vital_sign_sets WHERE vital_set_id = $1', [vitalSetId]);
    },

    findByExternalRecord(integrationClientId, externalRecordId) {
      return one(
        `SELECT * FROM vital_sign_sets
         WHERE integration_client_id = $1 AND external_record_id = $2`,
        [integrationClientId, externalRecordId]
      );
    },

    listObservations(vitalSetId) {
      return many(
        `SELECT * FROM vital_sign_observations
         WHERE vital_set_id = $1 ORDER BY source_ordinal ASC, vital_observation_id ASC`,
        [vitalSetId]
      );
    },

    voidSet({ vitalSetId, actorReference, reason }) {
      return one(
        `UPDATE vital_sign_sets SET status = 'voided', voided_at = CURRENT_TIMESTAMP,
          voided_by_actor_reference = $2, void_reason = $3, updated_at = CURRENT_TIMESTAMP
         WHERE vital_set_id = $1 AND status = 'recorded' RETURNING *`,
        [vitalSetId, actorReference, reason]
      );
    },

    async listHistory({ careProfileId, centerId = null, from = null, to = null, cursor = null, limit }) {
      const params = [careProfileId];
      const conditions = ["v.status = 'recorded'", 'v.care_profile_id = $1', `(
        NOT EXISTS (
          SELECT 1 FROM daily_care_vital_links link
          WHERE link.vital_set_id = v.vital_set_id
        )
        OR EXISTS (
          SELECT 1
          FROM daily_care_vital_links link
          JOIN daily_care_reports report ON report.daily_report_id = link.daily_report_id
          WHERE link.vital_set_id = v.vital_set_id
            AND report.status = 'finalized'
            AND report.version_no = (
              SELECT MAX(candidate.version_no)
              FROM daily_care_reports candidate
              WHERE candidate.report_group_id = report.report_group_id
                AND (candidate.status = 'finalized'
                  OR (candidate.status = 'voided' AND candidate.finalized_at IS NOT NULL))
            )
        )
      )`];
      if (centerId) { params.push(centerId); conditions.push(`v.center_id = $${params.length}`); }
      if (from) { params.push(from); conditions.push(`v.occurred_at >= $${params.length}`); }
      if (to) { params.push(to); conditions.push(`v.occurred_at <= $${params.length}`); }
      if (cursor) {
        params.push(cursor.occurredAt, cursor.vitalSetId);
        conditions.push(`(v.occurred_at, v.vital_set_id) < ($${params.length - 1}::timestamptz, $${params.length})`);
      }
      params.push(limit + 1);
      return many(
        `SELECT v.*,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'vital_observation_id', o.vital_observation_id,
              'source_ordinal', o.source_ordinal,
              'measurement_type', o.measurement_type,
              'source_value_text', o.source_value_text,
              'numeric_value', o.numeric_value,
              'source_unit', o.source_unit,
              'canonical_unit', o.canonical_unit,
              'measurement_context', o.measurement_context
            ) ORDER BY o.source_ordinal, o.vital_observation_id)
            FROM vital_sign_observations o WHERE o.vital_set_id = v.vital_set_id
          ), '[]'::jsonb) AS observations
         FROM vital_sign_sets v
         WHERE ${conditions.join(' AND ')}
         ORDER BY v.occurred_at DESC, v.vital_set_id DESC
         LIMIT $${params.length}`,
        params
      );
    },
  };
}

module.exports = { createVitalSignRepository };
