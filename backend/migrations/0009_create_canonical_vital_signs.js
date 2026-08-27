const MEASUREMENT_TYPES = "'temperature', 'blood_pressure_systolic', 'blood_pressure_diastolic', 'pulse', 'spo2', 'respiratory_rate'";

module.exports = {
  version: '0009',
  name: 'create_canonical_vital_signs',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS vital_sign_sets (
        vital_set_id VARCHAR(80) PRIMARY KEY,
        organization_id VARCHAR(80) NOT NULL,
        center_id VARCHAR(80) NOT NULL,
        resident_id VARCHAR(80) NOT NULL,
        care_profile_id VARCHAR(80) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'recorded'
          CHECK (status IN ('recorded', 'voided')),
        occurred_at TIMESTAMPTZ NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        recorded_by_actor_type VARCHAR(32) NOT NULL
          CHECK (recorded_by_actor_type IN ('center_staff', 'integration_client', 'system')),
        recorded_by_actor_reference VARCHAR(128) NOT NULL,
        source_type VARCHAR(32) NOT NULL
          CHECK (source_type IN ('native_phimor', 'external_integration')),
        source_system VARCHAR(100) NOT NULL CHECK (NULLIF(BTRIM(source_system), '') IS NOT NULL),
        integration_client_id VARCHAR(80),
        integration_event_id VARCHAR(80),
        external_record_id VARCHAR(160),
        external_staff_id VARCHAR(160),
        external_staff_display_name VARCHAR(160),
        voided_at TIMESTAMPTZ,
        voided_by_actor_reference VARCHAR(128),
        void_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (center_id, organization_id)
          REFERENCES organization_centers(center_id, organization_id) ON DELETE RESTRICT,
        FOREIGN KEY (integration_client_id, organization_id)
          REFERENCES integration_clients(integration_client_id, organization_id) ON DELETE RESTRICT,
        CHECK (
          (source_type = 'native_phimor' AND integration_client_id IS NULL
            AND integration_event_id IS NULL AND external_record_id IS NULL)
          OR
          (source_type = 'external_integration' AND integration_client_id IS NOT NULL
            AND external_record_id IS NOT NULL)
        ),
        CHECK (
          (status = 'recorded' AND voided_at IS NULL AND void_reason IS NULL)
          OR
          (status = 'voided' AND voided_at IS NOT NULL
            AND voided_by_actor_reference IS NOT NULL
            AND NULLIF(BTRIM(void_reason), '') IS NOT NULL)
        )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_vital_external_record
        ON vital_sign_sets (integration_client_id, external_record_id)
        WHERE source_type = 'external_integration';
      CREATE INDEX IF NOT EXISTS idx_vital_care_profile_occurred
        ON vital_sign_sets (care_profile_id, occurred_at DESC, vital_set_id DESC);
      CREATE INDEX IF NOT EXISTS idx_vital_center_occurred
        ON vital_sign_sets (center_id, occurred_at DESC, vital_set_id DESC);
      CREATE INDEX IF NOT EXISTS idx_vital_resident_occurred
        ON vital_sign_sets (resident_id, occurred_at DESC, vital_set_id DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vital_sign_observations (
        vital_observation_id VARCHAR(80) PRIMARY KEY,
        vital_set_id VARCHAR(80) NOT NULL
          REFERENCES vital_sign_sets(vital_set_id) ON DELETE RESTRICT,
        source_ordinal INTEGER NOT NULL CHECK (source_ordinal > 0),
        measurement_type VARCHAR(48) NOT NULL CHECK (measurement_type IN (${MEASUREMENT_TYPES})),
        source_value_text VARCHAR(80) NOT NULL,
        numeric_value NUMERIC(18,6) NOT NULL
          CHECK (numeric_value BETWEEN -1000000 AND 1000000),
        source_unit VARCHAR(32) NOT NULL,
        canonical_unit VARCHAR(32) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (vital_set_id, measurement_type),
        UNIQUE (vital_set_id, source_ordinal)
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_vital_observations_set ON vital_sign_observations (vital_set_id, source_ordinal)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS vital_sign_events (
        vital_event_id VARCHAR(80) PRIMARY KEY,
        vital_set_id VARCHAR(80) NOT NULL
          REFERENCES vital_sign_sets(vital_set_id) ON DELETE RESTRICT,
        event_type VARCHAR(32) NOT NULL CHECK (event_type IN ('recorded', 'voided')),
        actor_type VARCHAR(32) NOT NULL CHECK (actor_type IN ('center_staff', 'integration_client', 'system')),
        actor_reference VARCHAR(128) NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_vital_events_set_time ON vital_sign_events (vital_set_id, occurred_at, vital_event_id)');

    await client.query(`
      CREATE OR REPLACE FUNCTION guard_immutable_vital_observation()
      RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'vital observations are immutable'; END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_guard_immutable_vital_observation ON vital_sign_observations;
      CREATE TRIGGER trg_guard_immutable_vital_observation
        BEFORE UPDATE OR DELETE ON vital_sign_observations
        FOR EACH ROW EXECUTE FUNCTION guard_immutable_vital_observation();

      CREATE OR REPLACE FUNCTION guard_append_only_vital_event()
      RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'vital events are append-only'; END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_guard_append_only_vital_event ON vital_sign_events;
      CREATE TRIGGER trg_guard_append_only_vital_event
        BEFORE UPDATE OR DELETE ON vital_sign_events
        FOR EACH ROW EXECUTE FUNCTION guard_append_only_vital_event();
    `);
  },

  async down(client) {
    await client.query(`
      DROP TRIGGER IF EXISTS trg_guard_append_only_vital_event ON vital_sign_events;
      DROP FUNCTION IF EXISTS guard_append_only_vital_event();
      DROP TRIGGER IF EXISTS trg_guard_immutable_vital_observation ON vital_sign_observations;
      DROP FUNCTION IF EXISTS guard_immutable_vital_observation();
      DROP TABLE IF EXISTS vital_sign_events;
      DROP TABLE IF EXISTS vital_sign_observations;
      DROP TABLE IF EXISTS vital_sign_sets;
    `);
  },
};
