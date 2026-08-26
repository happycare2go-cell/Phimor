const LAB_ACTOR_TYPES = "'family_owner', 'family_caregiver', 'center_staff', 'center_owner', 'center_manager'";
const LAB_SOURCES = "'family_liff', 'center_liff', 'api'";

module.exports = {
  version: '0006',
  name: 'create_structured_lab_results',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS lab_reports (
        report_id VARCHAR(80) PRIMARY KEY,
        report_group_id VARCHAR(80) NOT NULL,
        version_no INTEGER NOT NULL CHECK (version_no > 0),
        care_profile_id VARCHAR(80) NOT NULL,
        appointment_id VARCHAR(80),
        status VARCHAR(16) NOT NULL
          CHECK (status IN ('draft', 'confirmed', 'voided')),
        laboratory_name TEXT,
        hospital_name TEXT,
        specimen_collected_at TIMESTAMPTZ,
        reported_at TIMESTAMPTZ,
        supersedes_report_id VARCHAR(80)
          REFERENCES lab_reports(report_id) ON DELETE RESTRICT,
        correction_reason TEXT,
        created_by_actor_type VARCHAR(32) NOT NULL
          CHECK (created_by_actor_type IN (${LAB_ACTOR_TYPES})),
        created_by_actor_id VARCHAR(128) NOT NULL,
        created_source VARCHAR(32) NOT NULL
          CHECK (created_source IN (${LAB_SOURCES})),
        confirmed_by_actor_type VARCHAR(32)
          CHECK (confirmed_by_actor_type IS NULL OR confirmed_by_actor_type IN (${LAB_ACTOR_TYPES})),
        confirmed_by_actor_id VARCHAR(128),
        confirmed_at TIMESTAMPTZ,
        voided_at TIMESTAMPTZ,
        void_reason TEXT,
        retention_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (report_group_id, version_no),
        CHECK (report_id <> supersedes_report_id),
        CHECK (
          (supersedes_report_id IS NULL AND correction_reason IS NULL)
          OR
          (supersedes_report_id IS NOT NULL AND NULLIF(BTRIM(correction_reason), '') IS NOT NULL)
        ),
        CHECK (
          (status = 'draft'
            AND confirmed_by_actor_type IS NULL
            AND confirmed_by_actor_id IS NULL
            AND confirmed_at IS NULL
            AND voided_at IS NULL
            AND void_reason IS NULL)
          OR
          (status = 'confirmed'
            AND confirmed_by_actor_type IS NOT NULL
            AND confirmed_by_actor_id IS NOT NULL
            AND confirmed_at IS NOT NULL
            AND voided_at IS NULL
            AND void_reason IS NULL)
          OR
          (status = 'voided'
            AND confirmed_by_actor_type IS NOT NULL
            AND confirmed_by_actor_id IS NOT NULL
            AND confirmed_at IS NOT NULL
            AND voided_at IS NOT NULL
            AND NULLIF(BTRIM(void_reason), '') IS NOT NULL)
        )
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS lab_report_sources (
        source_id VARCHAR(80) PRIMARY KEY,
        report_id VARCHAR(80) NOT NULL
          REFERENCES lab_reports(report_id) ON DELETE RESTRICT,
        source_kind VARCHAR(32) NOT NULL
          CHECK (source_kind IN ('pending_card', 'family_upload', 'center_upload', 'api', 'manual')),
        pending_card_id VARCHAR(80),
        source_reference TEXT,
        content_sha256 VARCHAR(64)
          CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
        mime_type VARCHAR(160),
        byte_size BIGINT CHECK (byte_size IS NULL OR byte_size >= 0),
        page_number INTEGER CHECK (page_number IS NULL OR page_number > 0),
        storage_status VARCHAR(24) NOT NULL DEFAULT 'not_retained'
          CHECK (storage_status IN ('available', 'purged', 'not_retained')),
        retention_until TIMESTAMPTZ,
        purged_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (source_kind <> 'pending_card' OR pending_card_id IS NOT NULL),
        CHECK (
          (storage_status = 'purged' AND purged_at IS NOT NULL)
          OR
          (storage_status <> 'purged' AND purged_at IS NULL)
        )
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS lab_observations (
        observation_id VARCHAR(80) PRIMARY KEY,
        report_id VARCHAR(80) NOT NULL
          REFERENCES lab_reports(report_id) ON DELETE RESTRICT,
        source_ordinal INTEGER NOT NULL CHECK (source_ordinal > 0),
        analyte_name_source TEXT NOT NULL CHECK (NULLIF(BTRIM(analyte_name_source), '') IS NOT NULL),
        source_value_text TEXT NOT NULL CHECK (NULLIF(BTRIM(source_value_text), '') IS NOT NULL),
        value_type VARCHAR(16) NOT NULL CHECK (value_type IN ('numeric', 'text')),
        numeric_value NUMERIC,
        text_value TEXT,
        source_unit TEXT,
        reference_range_text TEXT,
        reference_low NUMERIC,
        reference_high NUMERIC,
        abnormal_flag_source TEXT,
        specimen_source TEXT,
        method_source TEXT,
        loinc_code VARCHAR(64),
        loinc_verification_source VARCHAR(80),
        loinc_verified_by VARCHAR(128),
        loinc_verified_at TIMESTAMPTZ,
        ucum_unit VARCHAR(80),
        normalized_numeric_value NUMERIC,
        unit_normalization_source VARCHAR(80),
        comparison_key VARCHAR(160),
        source_page INTEGER CHECK (source_page IS NULL OR source_page > 0),
        source_region JSONB CHECK (source_region IS NULL OR jsonb_typeof(source_region) = 'object'),
        extraction_confidence NUMERIC
          CHECK (extraction_confidence IS NULL OR extraction_confidence BETWEEN 0 AND 1),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (report_id, source_ordinal),
        CHECK (
          (value_type = 'numeric' AND numeric_value IS NOT NULL AND text_value IS NULL)
          OR
          (value_type = 'text' AND numeric_value IS NULL AND NULLIF(BTRIM(text_value), '') IS NOT NULL)
        ),
        CHECK (reference_low IS NULL OR reference_high IS NULL OR reference_low <= reference_high),
        CHECK (
          (loinc_code IS NULL
            AND loinc_verification_source IS NULL
            AND loinc_verified_by IS NULL
            AND loinc_verified_at IS NULL)
          OR
          (loinc_code IS NOT NULL
            AND loinc_verification_source IS NOT NULL
            AND loinc_verified_by IS NOT NULL
            AND loinc_verified_at IS NOT NULL)
        ),
        CHECK (
          (normalized_numeric_value IS NULL AND ucum_unit IS NULL AND unit_normalization_source IS NULL)
          OR
          (value_type = 'numeric'
            AND normalized_numeric_value IS NOT NULL
            AND ucum_unit IS NOT NULL
            AND unit_normalization_source IS NOT NULL)
        )
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS lab_report_events (
        event_id VARCHAR(80) PRIMARY KEY,
        report_id VARCHAR(80) NOT NULL
          REFERENCES lab_reports(report_id) ON DELETE RESTRICT,
        event_type VARCHAR(40) NOT NULL
          CHECK (event_type IN (
            'draft_created', 'draft_updated', 'confirmed',
            'correction_draft_created', 'voided'
          )),
        actor_type VARCHAR(32) NOT NULL CHECK (actor_type IN (${LAB_ACTOR_TYPES})),
        actor_id VARCHAR(128) NOT NULL,
        source VARCHAR(32) NOT NULL CHECK (source IN (${LAB_SOURCES})),
        idempotency_key VARCHAR(180),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
          CHECK (jsonb_typeof(metadata) = 'object'),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lab_reports_profile_status_time
      ON lab_reports (care_profile_id, status, specimen_collected_at DESC, report_id DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lab_reports_supersedes
      ON lab_reports (supersedes_report_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lab_report_sources_report
      ON lab_report_sources (report_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lab_observations_report
      ON lab_observations (report_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lab_observations_comparison_key
      ON lab_observations (comparison_key)
      WHERE comparison_key IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lab_report_events_report_time
      ON lab_report_events (report_id, occurred_at DESC, event_id DESC)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_lab_report_events_idempotency
      ON lab_report_events (idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION guard_append_only_lab_event()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'lab report events are append-only';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER trg_guard_append_only_lab_event
      BEFORE UPDATE OR DELETE ON lab_report_events
      FOR EACH ROW EXECUTE FUNCTION guard_append_only_lab_event()
    `);

    // Relational guards complement the service-layer state checks. Once a
    // report is confirmed, its clinical content and provenance are versioned
    // through a correction draft instead of being overwritten in place.
    await client.query(`
      CREATE OR REPLACE FUNCTION guard_immutable_lab_report()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND OLD.status IN ('confirmed', 'voided') THEN
          RAISE EXCEPTION 'confirmed lab reports are append-only';
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.status IN ('confirmed', 'voided') THEN
          IF OLD.status = 'confirmed'
             AND NEW.status = 'voided'
             AND (to_jsonb(NEW) - ARRAY['status', 'voided_at', 'void_reason', 'updated_at']::text[])
                 = (to_jsonb(OLD) - ARRAY['status', 'voided_at', 'void_reason', 'updated_at']::text[]) THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'confirmed lab reports must be corrected by versioning';
        END IF;
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER trg_guard_immutable_lab_report
      BEFORE UPDATE OR DELETE ON lab_reports
      FOR EACH ROW EXECUTE FUNCTION guard_immutable_lab_report()
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION guard_immutable_lab_report_child()
      RETURNS TRIGGER AS $$
      DECLARE
        target_report_id VARCHAR(80);
        target_status VARCHAR(16);
      BEGIN
        target_report_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.report_id ELSE NEW.report_id END;
        SELECT status INTO target_status FROM lab_reports WHERE report_id = target_report_id;
        IF target_status IN ('confirmed', 'voided') THEN
          RAISE EXCEPTION 'confirmed lab report content is immutable';
        END IF;
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER trg_guard_immutable_lab_observation
      BEFORE INSERT OR UPDATE OR DELETE ON lab_observations
      FOR EACH ROW EXECUTE FUNCTION guard_immutable_lab_report_child()
    `);
    await client.query(`
      CREATE TRIGGER trg_guard_immutable_lab_source
      BEFORE INSERT OR UPDATE OR DELETE ON lab_report_sources
      FOR EACH ROW EXECUTE FUNCTION guard_immutable_lab_report_child()
    `);
  },

  async down(client) {
    await client.query('DROP TRIGGER IF EXISTS trg_guard_append_only_lab_event ON lab_report_events');
    await client.query('DROP FUNCTION IF EXISTS guard_append_only_lab_event()');
    await client.query('DROP TABLE IF EXISTS lab_report_events');
    await client.query('DROP TRIGGER IF EXISTS trg_guard_immutable_lab_source ON lab_report_sources');
    await client.query('DROP TRIGGER IF EXISTS trg_guard_immutable_lab_observation ON lab_observations');
    await client.query('DROP FUNCTION IF EXISTS guard_immutable_lab_report_child()');
    await client.query('DROP TABLE IF EXISTS lab_observations');
    await client.query('DROP TABLE IF EXISTS lab_report_sources');
    await client.query('DROP TRIGGER IF EXISTS trg_guard_immutable_lab_report ON lab_reports');
    await client.query('DROP FUNCTION IF EXISTS guard_immutable_lab_report()');
    await client.query('DROP TABLE IF EXISTS lab_reports');
  },
};
