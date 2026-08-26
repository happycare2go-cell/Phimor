const { databaseQuery } = require('../db');

function createLabRepository({ queryFn = databaseQuery } = {}) {
  const repository = {
    async createReport(record) {
      const result = await queryFn(
        `INSERT INTO lab_reports (
          report_id, report_group_id, version_no, care_profile_id, appointment_id,
          status, laboratory_name, hospital_name, specimen_collected_at, reported_at,
          supersedes_report_id, correction_reason, created_by_actor_type,
          created_by_actor_id, created_source, retention_until
        ) VALUES (
          $1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
        ) RETURNING *, CURRENT_TIMESTAMP AS database_now`,
        [
          record.report_id, record.report_group_id, record.version_no,
          record.care_profile_id, record.appointment_id, record.laboratory_name,
          record.hospital_name, record.specimen_collected_at, record.reported_at,
          record.supersedes_report_id, record.correction_reason,
          record.created_by_actor_type, record.created_by_actor_id,
          record.created_source, record.retention_until,
        ]
      );
      return result.rows[0];
    },

    async insertObservations(reportId, observations, idFactory) {
      const rows = [];
      for (const observation of observations) {
        const result = await queryFn(
          `INSERT INTO lab_observations (
            observation_id, report_id, source_ordinal, analyte_name_source,
            source_value_text, value_type, numeric_value, text_value, source_unit,
            reference_range_text, reference_low, reference_high, abnormal_flag_source,
            specimen_source, method_source, loinc_code, loinc_verification_source,
            loinc_verified_by, loinc_verified_at, ucum_unit, normalized_numeric_value,
            unit_normalization_source, comparison_key, source_page, source_region,
            extraction_confidence
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26
          ) RETURNING *`,
          [
            idFactory(), reportId, observation.sourceOrdinal,
            observation.analyteNameSource, observation.sourceValueText,
            observation.valueType, observation.numericValue, observation.textValue,
            observation.sourceUnit, observation.referenceRangeText,
            observation.referenceLow, observation.referenceHigh,
            observation.abnormalFlagSource, observation.specimenSource,
            observation.methodSource, observation.loincCode,
            observation.loincVerificationSource, observation.loincVerifiedBy,
            observation.loincVerifiedAt, observation.ucumUnit,
            observation.normalizedNumericValue, observation.unitNormalizationSource,
            observation.comparisonKey, observation.sourcePage,
            observation.sourceRegion ? JSON.stringify(observation.sourceRegion) : null,
            observation.extractionConfidence,
          ]
        );
        rows.push(result.rows[0]);
      }
      return rows;
    },

    async insertSources(reportId, sources, idFactory) {
      const rows = [];
      for (const source of sources) {
        const result = await queryFn(
          `INSERT INTO lab_report_sources (
            source_id, report_id, source_kind, pending_card_id, source_reference,
            content_sha256, mime_type, byte_size, page_number, storage_status,
            retention_until, purged_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          RETURNING *`,
          [
            idFactory(), reportId, source.sourceKind, source.pendingCardId,
            source.sourceReference, source.contentSha256, source.mimeType,
            source.byteSize, source.pageNumber, source.storageStatus,
            source.retentionUntil, source.purgedAt,
          ]
        );
        rows.push(result.rows[0]);
      }
      return rows;
    },

    async insertEvent(record) {
      const result = await queryFn(
        `INSERT INTO lab_report_events (
          event_id, report_id, event_type, actor_type, actor_id, source,
          idempotency_key, metadata, occurred_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, CURRENT_TIMESTAMP)
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING *`,
        [
          record.event_id, record.report_id, record.event_type, record.actor_type,
          record.actor_id, record.source, record.idempotency_key || null,
          JSON.stringify(record.metadata || {}),
        ]
      );
      return result.rows[0] || null;
    },

    async findReport(reportId) {
      const result = await queryFn(
        'SELECT *, CURRENT_TIMESTAMP AS database_now FROM lab_reports WHERE report_id = $1',
        [reportId]
      );
      return result.rows[0] || null;
    },

    async findReportForUpdate(reportId) {
      const result = await queryFn(
        'SELECT *, CURRENT_TIMESTAMP AS database_now FROM lab_reports WHERE report_id = $1 FOR UPDATE',
        [reportId]
      );
      return result.rows[0] || null;
    },

    async findLatestVersionForUpdate(reportGroupId) {
      const result = await queryFn(
        `SELECT *, CURRENT_TIMESTAMP AS database_now FROM lab_reports
         WHERE report_group_id = $1
         ORDER BY version_no DESC
         LIMIT 1 FOR UPDATE`,
        [reportGroupId]
      );
      return result.rows[0] || null;
    },

    async listObservations(reportId) {
      const result = await queryFn(
        `SELECT * FROM lab_observations WHERE report_id = $1
         ORDER BY source_ordinal ASC, observation_id ASC`,
        [reportId]
      );
      return result.rows;
    },

    async listSources(reportId) {
      const result = await queryFn(
        'SELECT * FROM lab_report_sources WHERE report_id = $1 ORDER BY created_at ASC, source_id ASC',
        [reportId]
      );
      return result.rows;
    },

    async listEvents(reportId) {
      const result = await queryFn(
        `SELECT event_id, report_id, event_type, actor_type, source, metadata, occurred_at
         FROM lab_report_events WHERE report_id = $1
         ORDER BY occurred_at DESC, event_id DESC`,
        [reportId]
      );
      return result.rows;
    },

    async updateDraftReport(record) {
      const result = await queryFn(
        `UPDATE lab_reports SET
          appointment_id = $2, laboratory_name = $3, hospital_name = $4,
          specimen_collected_at = $5, reported_at = $6, retention_until = $7,
          updated_at = CURRENT_TIMESTAMP
         WHERE report_id = $1 AND status = 'draft'
         RETURNING *, CURRENT_TIMESTAMP AS database_now`,
        [
          record.report_id, record.appointment_id, record.laboratory_name,
          record.hospital_name, record.specimen_collected_at, record.reported_at,
          record.retention_until,
        ]
      );
      return result.rows[0] || null;
    },

    async replaceObservations(reportId, observations, idFactory) {
      await queryFn('DELETE FROM lab_observations WHERE report_id = $1', [reportId]);
      return this.insertObservations(reportId, observations, idFactory);
    },

    async replaceSources(reportId, sources, idFactory) {
      await queryFn('DELETE FROM lab_report_sources WHERE report_id = $1', [reportId]);
      return this.insertSources(reportId, sources, idFactory);
    },

    async confirmReport(reportId, actor) {
      const result = await queryFn(
        `UPDATE lab_reports SET
          status = 'confirmed', confirmed_by_actor_type = $2,
          confirmed_by_actor_id = $3, confirmed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
         WHERE report_id = $1 AND status = 'draft'
         RETURNING *, CURRENT_TIMESTAMP AS database_now`,
        [reportId, actor.actorType, actor.actorId]
      );
      return result.rows[0] || null;
    },

    async voidReport(reportId, reason) {
      const result = await queryFn(
        `UPDATE lab_reports SET
          status = 'voided', voided_at = CURRENT_TIMESTAMP, void_reason = $2,
          updated_at = CURRENT_TIMESTAMP
         WHERE report_id = $1 AND status = 'confirmed'
         RETURNING *, CURRENT_TIMESTAMP AS database_now`,
        [reportId, reason]
      );
      return result.rows[0] || null;
    },

    async listReports({ careProfileId, includeDrafts, includeHistory, cursor, limit }) {
      const params = [careProfileId, Boolean(includeDrafts), Boolean(includeHistory)];
      const cursorClause = cursor
        ? (() => {
          params.push(cursor.sortTime, cursor.reportId);
          return `AND (sort_time, report_id) < ($${params.length - 1}::timestamptz, $${params.length})`;
        })()
        : '';
      params.push(limit + 1);
      const result = await queryFn(
        `WITH ranked AS (
          SELECT *,
            COALESCE(specimen_collected_at, reported_at, created_at) AS sort_time,
            MAX(version_no) FILTER (WHERE status = 'confirmed')
              OVER (PARTITION BY report_group_id) AS latest_confirmed_version
          FROM lab_reports
          WHERE care_profile_id = $1
        ), visible AS (
          SELECT * FROM ranked
          WHERE
            ($3::boolean = TRUE AND status IN ('confirmed', 'voided'))
            OR ($3::boolean = FALSE AND status = 'confirmed' AND version_no = latest_confirmed_version)
            OR ($2::boolean = TRUE AND status = 'draft')
        )
        SELECT *, CURRENT_TIMESTAMP AS database_now FROM visible
        WHERE TRUE
        ${cursorClause}
        ORDER BY sort_time DESC, report_id DESC
        LIMIT $${params.length}`,
        params
      );
      return result.rows;
    },
  };
  return repository;
}

module.exports = { createLabRepository };
