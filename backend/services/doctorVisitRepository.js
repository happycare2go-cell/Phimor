const { databaseQuery } = require('../db');

function createDoctorVisitRepository({ queryFn = databaseQuery } = {}) {
  return {
    async createRecord(record) {
      const result = await queryFn(
        `INSERT INTO doctor_visit_records (
          visit_record_id, record_group_id, version_no, care_profile_id,
          appointment_id, status, visit_at, hospital_name, department, doctor_name,
          source_text, structured_summary, supersedes_visit_record_id,
          correction_reason, created_by_actor_type, created_by_actor_id, created_source
        ) VALUES (
          $1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16
        ) RETURNING *, CURRENT_TIMESTAMP AS database_now`,
        [
          record.visit_record_id, record.record_group_id, record.version_no,
          record.care_profile_id, record.appointment_id, record.visit_at,
          record.hospital_name, record.department, record.doctor_name,
          record.source_text, record.structured_summary,
          record.supersedes_visit_record_id, record.correction_reason,
          record.created_by_actor_type, record.created_by_actor_id, record.created_source,
        ]
      );
      return result.rows[0];
    },

    async insertItems(visitRecordId, items, idFactory) {
      const rows = [];
      for (const item of items) {
        const result = await queryFn(
          `INSERT INTO doctor_visit_guidance_items (
            guidance_item_id, visit_record_id, source_ordinal, kind,
            source_support, normalized_summary, due_at, uncertainty
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *`,
          [
            idFactory(), visitRecordId, item.sourceOrdinal, item.kind,
            item.sourceSupport, item.summary, item.dueAt, item.uncertainty,
          ]
        );
        rows.push(result.rows[0]);
      }
      return rows;
    },

    async replaceItems(visitRecordId, items, idFactory) {
      await queryFn('DELETE FROM doctor_visit_guidance_items WHERE visit_record_id = $1', [visitRecordId]);
      return this.insertItems(visitRecordId, items, idFactory);
    },

    async insertEvent(record) {
      const result = await queryFn(
        `INSERT INTO doctor_visit_events (
          event_id, visit_record_id, event_type, actor_type, actor_id, source,
          idempotency_key, metadata, occurred_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, CURRENT_TIMESTAMP)
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING *`,
        [
          record.event_id, record.visit_record_id, record.event_type,
          record.actor_type, record.actor_id, record.source,
          record.idempotency_key || null, JSON.stringify(record.metadata || {}),
        ]
      );
      return result.rows[0] || null;
    },

    async findRecord(visitRecordId) {
      const result = await queryFn(
        'SELECT *, CURRENT_TIMESTAMP AS database_now FROM doctor_visit_records WHERE visit_record_id = $1',
        [visitRecordId]
      );
      return result.rows[0] || null;
    },

    async findRecordForUpdate(visitRecordId) {
      const result = await queryFn(
        `SELECT *, CURRENT_TIMESTAMP AS database_now FROM doctor_visit_records
         WHERE visit_record_id = $1 FOR UPDATE`,
        [visitRecordId]
      );
      return result.rows[0] || null;
    },

    async findLatestVersionForUpdate(recordGroupId) {
      const result = await queryFn(
        `SELECT *, CURRENT_TIMESTAMP AS database_now FROM doctor_visit_records
         WHERE record_group_id = $1 ORDER BY version_no DESC LIMIT 1 FOR UPDATE`,
        [recordGroupId]
      );
      return result.rows[0] || null;
    },

    async findLatestVersion(recordGroupId) {
      const result = await queryFn(
        `SELECT *, CURRENT_TIMESTAMP AS database_now
         FROM doctor_visit_records
         WHERE record_group_id = $1
         ORDER BY version_no DESC, visit_record_id DESC
         LIMIT 1`,
        [recordGroupId]
      );
      return result.rows[0] || null;
    },

    async listItems(visitRecordId) {
      const result = await queryFn(
        `SELECT * FROM doctor_visit_guidance_items WHERE visit_record_id = $1
         ORDER BY source_ordinal ASC, guidance_item_id ASC`,
        [visitRecordId]
      );
      return result.rows;
    },

    async listEvents(visitRecordId) {
      const result = await queryFn(
        `SELECT event_id, visit_record_id, event_type, actor_type, source, metadata, occurred_at
         FROM doctor_visit_events WHERE visit_record_id = $1
         ORDER BY occurred_at DESC, event_id DESC`,
        [visitRecordId]
      );
      return result.rows;
    },

    async updateDraftRecord(record) {
      const result = await queryFn(
        `UPDATE doctor_visit_records SET
          appointment_id = $2, visit_at = $3, hospital_name = $4,
          department = $5, doctor_name = $6, source_text = $7,
          structured_summary = $8, updated_at = CURRENT_TIMESTAMP
         WHERE visit_record_id = $1 AND status = 'draft'
         RETURNING *, CURRENT_TIMESTAMP AS database_now`,
        [
          record.visit_record_id, record.appointment_id, record.visit_at,
          record.hospital_name, record.department, record.doctor_name,
          record.source_text, record.structured_summary,
        ]
      );
      return result.rows[0] || null;
    },

    async confirmRecord(visitRecordId, actor) {
      const result = await queryFn(
        `UPDATE doctor_visit_records SET
          status = 'confirmed', confirmed_by_actor_type = $2,
          confirmed_by_actor_id = $3, confirmed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
         WHERE visit_record_id = $1 AND status = 'draft'
         RETURNING *, CURRENT_TIMESTAMP AS database_now`,
        [visitRecordId, actor.actorType, actor.actorId]
      );
      return result.rows[0] || null;
    },

    async voidRecord(visitRecordId, reason) {
      const result = await queryFn(
        `UPDATE doctor_visit_records SET
          status = 'voided', voided_at = CURRENT_TIMESTAMP, void_reason = $2,
          updated_at = CURRENT_TIMESTAMP
         WHERE visit_record_id = $1 AND status = 'confirmed'
         RETURNING *, CURRENT_TIMESTAMP AS database_now`,
        [visitRecordId, reason]
      );
      return result.rows[0] || null;
    },

    async listRecords({ careProfileId, includeDrafts, includeHistory, cursor, limit }) {
      const params = [careProfileId, Boolean(includeDrafts), Boolean(includeHistory)];
      const cursorClause = cursor ? (() => {
        params.push(cursor.sortTime, cursor.visitRecordId);
        return `AND (sort_time, visit_record_id) < ($${params.length - 1}::timestamptz, $${params.length})`;
      })() : '';
      params.push(limit + 1);
      const result = await queryFn(
        `WITH ranked AS (
          SELECT *, COALESCE(visit_at, created_at) AS sort_time,
            MAX(version_no) FILTER (WHERE status IN ('confirmed', 'voided'))
              OVER (PARTITION BY record_group_id) AS latest_authoritative_version
          FROM doctor_visit_records WHERE care_profile_id = $1
        ), visible AS (
          SELECT * FROM ranked WHERE
            ($3::boolean = TRUE AND status IN ('confirmed', 'voided'))
            OR ($3::boolean = FALSE AND status = 'confirmed' AND version_no = latest_authoritative_version)
            OR ($2::boolean = TRUE AND status = 'draft')
        )
        SELECT *,
          (status = 'confirmed' AND version_no = latest_authoritative_version) AS is_authoritative,
          CURRENT_TIMESTAMP AS database_now
        FROM visible
        WHERE TRUE ${cursorClause}
        ORDER BY sort_time DESC, visit_record_id DESC
        LIMIT $${params.length}`,
        params
      );
      return result.rows;
    },
  };
}

module.exports = { createDoctorVisitRepository };
