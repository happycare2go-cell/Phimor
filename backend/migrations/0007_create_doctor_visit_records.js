const ACTOR_TYPES = "'family_owner', 'family_caregiver', 'center_staff', 'center_owner', 'center_manager'";
const CREATED_SOURCES = "'family_liff', 'center_liff', 'api'";

module.exports = {
  version: '0007',
  name: 'create_doctor_visit_records',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS doctor_visit_records (
        visit_record_id VARCHAR(80) PRIMARY KEY,
        record_group_id VARCHAR(80) NOT NULL,
        version_no INTEGER NOT NULL CHECK (version_no > 0),
        care_profile_id VARCHAR(80) NOT NULL,
        appointment_id VARCHAR(80),
        status VARCHAR(16) NOT NULL CHECK (status IN ('draft', 'confirmed', 'voided')),
        visit_at TIMESTAMPTZ,
        hospital_name TEXT,
        department TEXT,
        doctor_name TEXT,
        source_text TEXT NOT NULL DEFAULT '',
        structured_summary TEXT,
        supersedes_visit_record_id VARCHAR(80)
          REFERENCES doctor_visit_records(visit_record_id) ON DELETE RESTRICT,
        correction_reason TEXT,
        created_by_actor_type VARCHAR(32) NOT NULL CHECK (created_by_actor_type IN (${ACTOR_TYPES})),
        created_by_actor_id VARCHAR(128) NOT NULL,
        created_source VARCHAR(24) NOT NULL CHECK (created_source IN (${CREATED_SOURCES})),
        confirmed_by_actor_type VARCHAR(32) CHECK (confirmed_by_actor_type IN (${ACTOR_TYPES})),
        confirmed_by_actor_id VARCHAR(128),
        confirmed_at TIMESTAMPTZ,
        voided_at TIMESTAMPTZ,
        void_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (record_group_id, version_no),
        CHECK (visit_record_id <> supersedes_visit_record_id),
        CHECK (
          (version_no = 1 AND supersedes_visit_record_id IS NULL AND correction_reason IS NULL)
          OR (version_no > 1 AND supersedes_visit_record_id IS NOT NULL
              AND NULLIF(BTRIM(correction_reason), '') IS NOT NULL)
        ),
        CHECK (
          (status = 'draft' AND confirmed_by_actor_type IS NULL
            AND confirmed_by_actor_id IS NULL AND confirmed_at IS NULL
            AND voided_at IS NULL AND void_reason IS NULL)
          OR (status = 'confirmed' AND confirmed_by_actor_type IS NOT NULL
            AND confirmed_by_actor_id IS NOT NULL AND confirmed_at IS NOT NULL
            AND voided_at IS NULL AND void_reason IS NULL)
          OR (status = 'voided' AND confirmed_by_actor_type IS NOT NULL
            AND confirmed_by_actor_id IS NOT NULL AND confirmed_at IS NOT NULL
            AND voided_at IS NOT NULL AND NULLIF(BTRIM(void_reason), '') IS NOT NULL)
        )
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS doctor_visit_guidance_items (
        guidance_item_id VARCHAR(80) PRIMARY KEY,
        visit_record_id VARCHAR(80) NOT NULL
          REFERENCES doctor_visit_records(visit_record_id) ON DELETE RESTRICT,
        source_ordinal INTEGER NOT NULL CHECK (source_ordinal > 0),
        kind VARCHAR(48) NOT NULL CHECK (kind IN (
          'doctor_guidance', 'medication_statement', 'lab_follow_up',
          'next_appointment', 'test_or_monitoring',
          'lifestyle_or_care_instruction', 'question_response', 'other'
        )),
        source_support TEXT NOT NULL CHECK (NULLIF(BTRIM(source_support), '') IS NOT NULL),
        normalized_summary TEXT NOT NULL CHECK (NULLIF(BTRIM(normalized_summary), '') IS NOT NULL),
        due_at TIMESTAMPTZ,
        uncertainty TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (visit_record_id, source_ordinal)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS doctor_visit_events (
        event_id VARCHAR(80) PRIMARY KEY,
        visit_record_id VARCHAR(80) NOT NULL
          REFERENCES doctor_visit_records(visit_record_id) ON DELETE RESTRICT,
        event_type VARCHAR(48) NOT NULL CHECK (event_type IN (
          'draft_created', 'draft_updated', 'ai_organized', 'confirmed',
          'correction_draft_created', 'voided'
        )),
        actor_type VARCHAR(32) NOT NULL CHECK (actor_type IN (${ACTOR_TYPES})),
        actor_id VARCHAR(128) NOT NULL,
        source VARCHAR(24) NOT NULL CHECK (source IN (${CREATED_SOURCES})),
        idempotency_key VARCHAR(160),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctor_visit_records_profile_status_time
        ON doctor_visit_records (care_profile_id, status, visit_at DESC, visit_record_id DESC);
      CREATE INDEX IF NOT EXISTS idx_doctor_visit_records_appointment
        ON doctor_visit_records (appointment_id) WHERE appointment_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_doctor_visit_records_supersedes
        ON doctor_visit_records (supersedes_visit_record_id);
      CREATE INDEX IF NOT EXISTS idx_doctor_visit_guidance_record
        ON doctor_visit_guidance_items (visit_record_id, source_ordinal);
      CREATE INDEX IF NOT EXISTS idx_doctor_visit_events_record_time
        ON doctor_visit_events (visit_record_id, occurred_at DESC, event_id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_doctor_visit_events_idempotency
        ON doctor_visit_events (idempotency_key) WHERE idempotency_key IS NOT NULL;
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION guard_immutable_doctor_visit_record()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'draft' THEN
          RETURN NEW;
        END IF;
        IF OLD.status = 'confirmed' AND NEW.status = 'voided'
          AND ROW(NEW.visit_record_id, NEW.record_group_id, NEW.version_no,
            NEW.care_profile_id, NEW.appointment_id, NEW.visit_at, NEW.hospital_name,
            NEW.department, NEW.doctor_name, NEW.source_text, NEW.structured_summary,
            NEW.supersedes_visit_record_id, NEW.correction_reason,
            NEW.created_by_actor_type, NEW.created_by_actor_id, NEW.created_source,
            NEW.confirmed_by_actor_type, NEW.confirmed_by_actor_id, NEW.confirmed_at,
            NEW.created_at)
          IS NOT DISTINCT FROM
          ROW(OLD.visit_record_id, OLD.record_group_id, OLD.version_no,
            OLD.care_profile_id, OLD.appointment_id, OLD.visit_at, OLD.hospital_name,
            OLD.department, OLD.doctor_name, OLD.source_text, OLD.structured_summary,
            OLD.supersedes_visit_record_id, OLD.correction_reason,
            OLD.created_by_actor_type, OLD.created_by_actor_id, OLD.created_source,
            OLD.confirmed_by_actor_type, OLD.confirmed_by_actor_id, OLD.confirmed_at,
            OLD.created_at)
        THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'confirmed doctor visit record content is immutable';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_guard_immutable_doctor_visit_record ON doctor_visit_records;
      CREATE TRIGGER trg_guard_immutable_doctor_visit_record
        BEFORE UPDATE OR DELETE ON doctor_visit_records
        FOR EACH ROW EXECUTE FUNCTION guard_immutable_doctor_visit_record();

      CREATE OR REPLACE FUNCTION guard_immutable_doctor_visit_item()
      RETURNS trigger AS $$
      DECLARE parent_status VARCHAR(16);
      BEGIN
        SELECT status INTO parent_status FROM doctor_visit_records
          WHERE visit_record_id = COALESCE(NEW.visit_record_id, OLD.visit_record_id);
        IF parent_status IS DISTINCT FROM 'draft' THEN
          RAISE EXCEPTION 'confirmed doctor visit guidance is immutable';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_guard_immutable_doctor_visit_item ON doctor_visit_guidance_items;
      CREATE TRIGGER trg_guard_immutable_doctor_visit_item
        BEFORE INSERT OR UPDATE OR DELETE ON doctor_visit_guidance_items
        FOR EACH ROW EXECUTE FUNCTION guard_immutable_doctor_visit_item();

      CREATE OR REPLACE FUNCTION guard_append_only_doctor_visit_event()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'doctor visit events are append-only';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_guard_append_only_doctor_visit_event ON doctor_visit_events;
      CREATE TRIGGER trg_guard_append_only_doctor_visit_event
        BEFORE UPDATE OR DELETE ON doctor_visit_events
        FOR EACH ROW EXECUTE FUNCTION guard_append_only_doctor_visit_event();
    `);
  },

  async down(client) {
    await client.query(`
      DROP TRIGGER IF EXISTS trg_guard_append_only_doctor_visit_event ON doctor_visit_events;
      DROP TRIGGER IF EXISTS trg_guard_immutable_doctor_visit_item ON doctor_visit_guidance_items;
      DROP TRIGGER IF EXISTS trg_guard_immutable_doctor_visit_record ON doctor_visit_records;
      DROP FUNCTION IF EXISTS guard_append_only_doctor_visit_event();
      DROP FUNCTION IF EXISTS guard_immutable_doctor_visit_item();
      DROP FUNCTION IF EXISTS guard_immutable_doctor_visit_record();
      DROP TABLE IF EXISTS doctor_visit_events;
      DROP TABLE IF EXISTS doctor_visit_guidance_items;
      DROP TABLE IF EXISTS doctor_visit_records;
    `);
  },
};
