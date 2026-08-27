const ITEM_TYPES = "'shift','nutrition','fluid_intake','sleep_rest','bowel_movement','urination','activity','mood_behavior','general_condition','symptom_note'";

module.exports = {
  version:'0010', name:'create_daily_care_reports',
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_care_reports (
        daily_report_id VARCHAR(80) PRIMARY KEY,
        organization_id VARCHAR(80) NOT NULL,
        center_id VARCHAR(80) NOT NULL,
        resident_id VARCHAR(80) NOT NULL,
        care_profile_id VARCHAR(80) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','voided')),
        occurred_at TIMESTAMPTZ NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        recorded_by_actor_type VARCHAR(32) NOT NULL CHECK (recorded_by_actor_type IN ('center_staff','integration_client','system')),
        recorded_by_actor_reference VARCHAR(128) NOT NULL,
        source_type VARCHAR(32) NOT NULL CHECK (source_type IN ('native_phimor','external_integration')),
        source_system VARCHAR(100) NOT NULL CHECK (NULLIF(BTRIM(source_system),'') IS NOT NULL),
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
          (source_type='native_phimor' AND integration_client_id IS NULL AND integration_event_id IS NULL AND external_record_id IS NULL)
          OR (source_type='external_integration' AND integration_client_id IS NOT NULL AND external_record_id IS NOT NULL)
        ),
        CHECK (
          (status='recorded' AND voided_at IS NULL AND void_reason IS NULL)
          OR (status='voided' AND voided_at IS NOT NULL AND voided_by_actor_reference IS NOT NULL AND NULLIF(BTRIM(void_reason),'') IS NOT NULL)
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_external_record
        ON daily_care_reports (integration_client_id, external_record_id)
        WHERE source_type='external_integration';
      CREATE INDEX IF NOT EXISTS idx_daily_care_profile_occurred
        ON daily_care_reports (care_profile_id, occurred_at DESC, daily_report_id DESC);
      CREATE INDEX IF NOT EXISTS idx_daily_center_occurred
        ON daily_care_reports (center_id, occurred_at DESC, daily_report_id DESC);
      CREATE INDEX IF NOT EXISTS idx_daily_resident_occurred
        ON daily_care_reports (resident_id, occurred_at DESC, daily_report_id DESC);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_care_items (
        daily_item_id VARCHAR(80) PRIMARY KEY,
        daily_report_id VARCHAR(80) NOT NULL REFERENCES daily_care_reports(daily_report_id) ON DELETE RESTRICT,
        source_ordinal INTEGER NOT NULL CHECK (source_ordinal > 0),
        item_type VARCHAR(48) NOT NULL CHECK (item_type IN (${ITEM_TYPES})),
        value_type VARCHAR(16) NOT NULL CHECK (value_type IN ('text','numeric','boolean')),
        source_value_text TEXT,
        text_value TEXT,
        numeric_value NUMERIC(18,6),
        boolean_value BOOLEAN,
        source_unit VARCHAR(40),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (
          (value_type='text' AND NULLIF(BTRIM(text_value),'') IS NOT NULL AND numeric_value IS NULL AND boolean_value IS NULL)
          OR (value_type='numeric' AND numeric_value IS NOT NULL AND text_value IS NULL AND boolean_value IS NULL)
          OR (value_type='boolean' AND boolean_value IS NOT NULL AND text_value IS NULL AND numeric_value IS NULL)
        ),
        CHECK (value_type='numeric' OR source_unit IS NULL),
        UNIQUE (daily_report_id, source_ordinal)
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_daily_items_report ON daily_care_items (daily_report_id, source_ordinal)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_care_vital_links (
        daily_report_id VARCHAR(80) NOT NULL REFERENCES daily_care_reports(daily_report_id) ON DELETE RESTRICT,
        vital_set_id VARCHAR(80) NOT NULL REFERENCES vital_sign_sets(vital_set_id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (daily_report_id, vital_set_id),
        UNIQUE (vital_set_id)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_care_events (
        daily_event_id VARCHAR(80) PRIMARY KEY,
        daily_report_id VARCHAR(80) NOT NULL REFERENCES daily_care_reports(daily_report_id) ON DELETE RESTRICT,
        event_type VARCHAR(32) NOT NULL CHECK (event_type IN ('recorded','voided')),
        actor_type VARCHAR(32) NOT NULL CHECK (actor_type IN ('center_staff','integration_client','system')),
        actor_reference VARCHAR(128) NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_daily_events_report_time ON daily_care_events (daily_report_id, occurred_at, daily_event_id)');
    await client.query(`
      CREATE OR REPLACE FUNCTION guard_immutable_daily_item()
      RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'daily care items are immutable'; END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_guard_immutable_daily_item ON daily_care_items;
      CREATE TRIGGER trg_guard_immutable_daily_item BEFORE UPDATE OR DELETE ON daily_care_items
        FOR EACH ROW EXECUTE FUNCTION guard_immutable_daily_item();
      CREATE OR REPLACE FUNCTION guard_append_only_daily_event()
      RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'daily care events are append-only'; END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_guard_append_only_daily_event ON daily_care_events;
      CREATE TRIGGER trg_guard_append_only_daily_event BEFORE UPDATE OR DELETE ON daily_care_events
        FOR EACH ROW EXECUTE FUNCTION guard_append_only_daily_event();
    `);
  },
  async down(client) {
    await client.query(`
      DROP TRIGGER IF EXISTS trg_guard_append_only_daily_event ON daily_care_events;
      DROP FUNCTION IF EXISTS guard_append_only_daily_event();
      DROP TRIGGER IF EXISTS trg_guard_immutable_daily_item ON daily_care_items;
      DROP FUNCTION IF EXISTS guard_immutable_daily_item();
      DROP TABLE IF EXISTS daily_care_events;
      DROP TABLE IF EXISTS daily_care_vital_links;
      DROP TABLE IF EXISTS daily_care_items;
      DROP TABLE IF EXISTS daily_care_reports;
    `);
  },
};
