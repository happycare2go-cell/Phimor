const STATUSES="'received','processing','processed','pending','rejected','retrying','dead'";
module.exports={version:'0011',name:'create_integration_event_inbox',async up(client){
  await client.query(`CREATE TABLE IF NOT EXISTS integration_event_inbox (
    integration_event_id VARCHAR(80) PRIMARY KEY,
    integration_client_id VARCHAR(80) NOT NULL,
    organization_id VARCHAR(80) NOT NULL,
    external_event_id VARCHAR(160) NOT NULL,
    event_type VARCHAR(80) NOT NULL CHECK (event_type IN ('care.vitals.recorded','care.daily_report.recorded')),
    payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
    canonical_payload JSONB NOT NULL CHECK (jsonb_typeof(canonical_payload)='object'),
    status VARCHAR(24) NOT NULL DEFAULT 'received' CHECK (status IN (${STATUSES})),
    external_center_id VARCHAR(160) NOT NULL,
    external_resident_id VARCHAR(160) NOT NULL,
    center_id VARCHAR(80) NOT NULL,
    resident_id VARCHAR(80),
    care_profile_id VARCHAR(80),
    canonical_resource_type VARCHAR(32),
    canonical_resource_id VARCHAR(80),
    pending_reason VARCHAR(80),
    last_error_code VARCHAR(100),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (integration_client_id, external_event_id),
    FOREIGN KEY (integration_client_id,organization_id)
      REFERENCES integration_clients(integration_client_id,organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (center_id,organization_id)
      REFERENCES organization_centers(center_id,organization_id) ON DELETE RESTRICT,
    CHECK ((status='processed' AND processed_at IS NOT NULL AND canonical_resource_id IS NOT NULL) OR status<>'processed'),
    CHECK ((status='pending' AND pending_reason IS NOT NULL) OR status<>'pending')
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_integration_inbox_work
    ON integration_event_inbox (status,next_attempt_at,created_at,integration_event_id);
    CREATE INDEX IF NOT EXISTS idx_integration_inbox_pending_subject
    ON integration_event_inbox (integration_client_id,external_center_id,external_resident_id,created_at)
    WHERE status='pending';`);
  await client.query(`ALTER TABLE vital_sign_sets
    ADD CONSTRAINT fk_vital_integration_event FOREIGN KEY (integration_event_id)
    REFERENCES integration_event_inbox(integration_event_id) ON DELETE RESTRICT`);
  await client.query(`ALTER TABLE daily_care_reports
    ADD CONSTRAINT fk_daily_integration_event FOREIGN KEY (integration_event_id)
    REFERENCES integration_event_inbox(integration_event_id) ON DELETE RESTRICT`);
},async down(client){await client.query(`ALTER TABLE daily_care_reports DROP CONSTRAINT IF EXISTS fk_daily_integration_event;
  ALTER TABLE vital_sign_sets DROP CONSTRAINT IF EXISTS fk_vital_integration_event;
  DROP TABLE IF EXISTS integration_event_inbox;`);}};
