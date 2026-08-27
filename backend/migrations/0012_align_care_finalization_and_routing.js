const MEASUREMENT_TYPES = "'temperature','blood_pressure_systolic','blood_pressure_diastolic','pulse','spo2','respiratory_rate','blood_glucose','weight'";
const DAILY_STATUSES = "'recorded','submitted','changes_requested','finalized','voided'";
const DAILY_EVENTS = "'recorded','submitted','returned','finalized','correction_submitted','voided'";

module.exports = {
  version:'0012',
  name:'align_care_finalization_and_routing',

  async up(client) {
    await client.query(`
      ALTER TABLE vital_sign_observations
        ADD COLUMN IF NOT EXISTS measurement_context VARCHAR(32);
      ALTER TABLE vital_sign_observations
        DROP CONSTRAINT IF EXISTS vital_sign_observations_measurement_type_check;
      ALTER TABLE vital_sign_observations
        ADD CONSTRAINT vital_sign_observations_measurement_type_check
        CHECK (measurement_type IN (${MEASUREMENT_TYPES}));
      ALTER TABLE vital_sign_observations
        ADD CONSTRAINT vital_sign_observations_context_check CHECK (
          (measurement_type = 'blood_glucose'
            AND measurement_context IN ('fasting','before_meal','after_meal','random','unspecified'))
          OR (measurement_type <> 'blood_glucose' AND measurement_context IS NULL)
        );
    `);

    await client.query(`
      ALTER TABLE daily_care_reports
        ADD COLUMN IF NOT EXISTS report_group_id VARCHAR(80),
        ADD COLUMN IF NOT EXISTS version_no INTEGER,
        ADD COLUMN IF NOT EXISTS supersedes_report_id VARCHAR(80),
        ADD COLUMN IF NOT EXISTS care_date DATE,
        ADD COLUMN IF NOT EXISTS shift_code VARCHAR(40),
        ADD COLUMN IF NOT EXISTS shift_source_label VARCHAR(120),
        ADD COLUMN IF NOT EXISTS source_recorded_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS recorder_display_name VARCHAR(160),
        ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS submitted_by_actor_reference VARCHAR(128),
        ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS returned_by_actor_reference VARCHAR(128),
        ADD COLUMN IF NOT EXISTS return_reason TEXT,
        ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS finalized_by_actor_type VARCHAR(32),
        ADD COLUMN IF NOT EXISTS finalized_by_actor_reference VARCHAR(128),
        ADD COLUMN IF NOT EXISTS finalizer_display_name VARCHAR(160);

      UPDATE daily_care_reports
      SET report_group_id = daily_report_id, version_no = 1
      WHERE report_group_id IS NULL OR version_no IS NULL;

      ALTER TABLE daily_care_reports
        ALTER COLUMN report_group_id SET NOT NULL,
        ALTER COLUMN version_no SET NOT NULL,
        ALTER COLUMN version_no SET DEFAULT 1;
      ALTER TABLE daily_care_reports
        ADD CONSTRAINT daily_care_reports_version_positive CHECK (version_no > 0),
        ADD CONSTRAINT daily_care_reports_group_version_unique UNIQUE (report_group_id, version_no),
        ADD CONSTRAINT daily_care_reports_supersedes_not_self CHECK (
          supersedes_report_id IS NULL OR supersedes_report_id <> daily_report_id
        ),
        ADD CONSTRAINT daily_care_reports_supersedes_fk FOREIGN KEY (supersedes_report_id)
          REFERENCES daily_care_reports(daily_report_id) ON DELETE RESTRICT;
    `);

    await client.query(`
      DO $$ DECLARE constraint_row RECORD;
      BEGIN
        FOR constraint_row IN
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'daily_care_reports'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) ILIKE '%status%recorded%voided_at%'
        LOOP
          EXECUTE format('ALTER TABLE daily_care_reports DROP CONSTRAINT %I', constraint_row.conname);
        END LOOP;
      END $$;
      ALTER TABLE daily_care_reports
        DROP CONSTRAINT IF EXISTS daily_care_reports_status_check;
      ALTER TABLE daily_care_reports
        ADD CONSTRAINT daily_care_reports_status_check CHECK (status IN (${DAILY_STATUSES})),
        ADD CONSTRAINT daily_care_reports_lifecycle_check CHECK (
          (status = 'recorded' AND submitted_at IS NULL AND returned_at IS NULL
            AND finalized_at IS NULL AND voided_at IS NULL)
          OR (status = 'submitted' AND submitted_at IS NOT NULL
            AND submitted_by_actor_reference IS NOT NULL AND returned_at IS NULL
            AND finalized_at IS NULL AND voided_at IS NULL)
          OR (status = 'changes_requested' AND submitted_at IS NOT NULL
            AND submitted_by_actor_reference IS NOT NULL AND returned_at IS NOT NULL
            AND returned_by_actor_reference IS NOT NULL
            AND NULLIF(BTRIM(return_reason), '') IS NOT NULL
            AND finalized_at IS NULL AND voided_at IS NULL)
          OR (status = 'finalized' AND finalized_at IS NOT NULL
            AND finalized_by_actor_type IN ('center_staff','integration_client','system')
            AND finalized_by_actor_reference IS NOT NULL AND voided_at IS NULL)
          OR (status = 'voided' AND voided_at IS NOT NULL
            AND voided_by_actor_reference IS NOT NULL
            AND NULLIF(BTRIM(void_reason), '') IS NOT NULL)
        );

      ALTER TABLE daily_care_events
        DROP CONSTRAINT IF EXISTS daily_care_events_event_type_check;
      ALTER TABLE daily_care_events
        ADD CONSTRAINT daily_care_events_event_type_check
        CHECK (event_type IN (${DAILY_EVENTS}));

      CREATE INDEX IF NOT EXISTS idx_daily_center_review_queue
        ON daily_care_reports (center_id, status, submitted_at, daily_report_id)
        WHERE status IN ('submitted','changes_requested');
      CREATE INDEX IF NOT EXISTS idx_daily_report_group_version
        ON daily_care_reports (report_group_id, version_no DESC);
    `);

    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM integration_event_inbox
          WHERE event_type = 'care.daily_report.recorded'
        ) THEN
          RAISE EXCEPTION 'legacy care.daily_report.recorded inbox rows require explicit operational review';
        END IF;
      END $$;

      ALTER TABLE integration_event_inbox
        DROP CONSTRAINT IF EXISTS integration_event_inbox_event_type_check;
      ALTER TABLE integration_event_inbox
        ADD CONSTRAINT integration_event_inbox_event_type_check
        CHECK (event_type IN ('care.vitals.recorded','care.daily_report.finalized'));

      ALTER TABLE integration_client_event_scopes
        DROP CONSTRAINT IF EXISTS integration_client_event_scopes_event_type_check;
      UPDATE integration_client_event_scopes
      SET event_type = 'care.daily_report.finalized'
      WHERE event_type = 'care.daily_report.recorded';
      ALTER TABLE integration_client_event_scopes
        ADD CONSTRAINT integration_client_event_scopes_event_type_check
        CHECK (event_type IN ('care.vitals.recorded','care.daily_report.finalized'));

      ALTER TABLE integration_event_inbox
        ADD COLUMN IF NOT EXISTS expected_line_group_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS verified_line_group_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS group_reconciliation_status VARCHAR(40),
        ADD COLUMN IF NOT EXISTS notification_intent_status VARCHAR(40);
      ALTER TABLE integration_event_inbox
        ADD CONSTRAINT integration_event_group_reconciliation_check CHECK (
          group_reconciliation_status IS NULL OR group_reconciliation_status IN (
            'no_expected_group','verified_match','group_binding_missing','group_binding_mismatch'
          )
        ),
        ADD CONSTRAINT integration_event_notification_intent_check CHECK (
          notification_intent_status IS NULL OR notification_intent_status IN (
            'not_applicable','queued','duplicate','recipient_missing','held_group_missing',
            'held_group_mismatch','enqueue_failed'
          )
        );
      CREATE INDEX IF NOT EXISTS idx_integration_inbox_group_reconciliation
        ON integration_event_inbox (
          group_reconciliation_status, organization_id, center_id, integration_client_id, updated_at DESC
        ) WHERE group_reconciliation_status IS NOT NULL;
    `);
  },

  async down(client) {
    await client.query(`
      ALTER TABLE integration_event_inbox
        DROP CONSTRAINT IF EXISTS integration_event_notification_intent_check,
        DROP CONSTRAINT IF EXISTS integration_event_group_reconciliation_check;
      DROP INDEX IF EXISTS idx_integration_inbox_group_reconciliation;
      ALTER TABLE integration_event_inbox
        DROP COLUMN IF EXISTS notification_intent_status,
        DROP COLUMN IF EXISTS group_reconciliation_status,
        DROP COLUMN IF EXISTS verified_line_group_id,
        DROP COLUMN IF EXISTS expected_line_group_id;
    `);
  },
};
