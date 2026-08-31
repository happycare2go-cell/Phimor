module.exports={
  version:'0017',
  name:'create_integration_field_picker_adapters',
  async up(client){
    const required=await client.query(`SELECT to_regclass('public.integration_clients') AS integration_clients,
      to_regclass('public.integration_adapter_profiles') AS adapter_profiles,
      to_regclass('public.integration_adapter_samples') AS adapter_samples`);
    if(!required.rows[0]?.integration_clients)throw new Error('INTEGRATION_CLIENTS_TABLE_REQUIRED');
    if(required.rows[0]?.adapter_profiles||required.rows[0]?.adapter_samples)throw new Error('INTEGRATION_ADAPTER_PARTIAL_SCHEMA_REVIEW_REQUIRED');
    await client.query(`CREATE TABLE IF NOT EXISTS integration_adapter_profiles (
      adapter_profile_id VARCHAR(80) PRIMARY KEY,
      integration_client_id VARCHAR(80) NOT NULL REFERENCES integration_clients(integration_client_id),
      target_event_type VARCHAR(120) NOT NULL CHECK (target_event_type='care.daily_report.finalized'),
      version INTEGER NOT NULL CHECK (version>0),
      status VARCHAR(24) NOT NULL CHECK (status IN ('draft','active','superseded')),
      mapping_rules JSONB NOT NULL CHECK (jsonb_typeof(mapping_rules)='array'),
      source_structural_fingerprint CHAR(64) NOT NULL,
      created_by VARCHAR(128) NOT NULL,
      activated_by VARCHAR(128),
      activated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (integration_client_id,target_event_type,version),
      CHECK ((status='active')=(activated_at IS NOT NULL AND activated_by IS NOT NULL)
        OR status IN ('draft','superseded'))
    )`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_adapter_active
      ON integration_adapter_profiles(integration_client_id,target_event_type)
      WHERE status='active'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_integration_adapter_client_target
      ON integration_adapter_profiles(integration_client_id,target_event_type,version DESC)`);
    await client.query(`CREATE TABLE IF NOT EXISTS integration_adapter_samples (
      adapter_sample_id VARCHAR(80) PRIMARY KEY,
      integration_client_id VARCHAR(80) NOT NULL REFERENCES integration_clients(integration_client_id),
      target_event_type VARCHAR(120) NOT NULL CHECK (target_event_type='care.daily_report.finalized'),
      status VARCHAR(24) NOT NULL CHECK (status IN ('waiting','captured','consumed','expired','cancelled')),
      capture_expires_at TIMESTAMPTZ NOT NULL,
      sample_expires_at TIMESTAMPTZ,
      sample_payload JSONB,
      source_structural_fingerprint CHAR(64),
      sample_size_bytes INTEGER CHECK (sample_size_bytes IS NULL OR sample_size_bytes BETWEEN 0 AND 262144),
      discovered_field_count INTEGER CHECK (discovered_field_count IS NULL OR discovered_field_count BETWEEN 0 AND 250),
      captured_at TIMESTAMPTZ,
      created_by VARCHAR(128) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (sample_payload IS NULL OR jsonb_typeof(sample_payload) IN ('object','array')),
      CHECK (status<>'captured' OR (sample_payload IS NOT NULL AND sample_expires_at IS NOT NULL
        AND source_structural_fingerprint IS NOT NULL AND captured_at IS NOT NULL))
    )`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_adapter_waiting_capture
      ON integration_adapter_samples(integration_client_id,target_event_type)
      WHERE status='waiting'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_integration_adapter_sample_expiry
      ON integration_adapter_samples(status,capture_expires_at,sample_expires_at)`);
  },
  async down(client){
    await client.query('DROP TABLE IF EXISTS integration_adapter_samples');
    await client.query('DROP TABLE IF EXISTS integration_adapter_profiles');
  },
};
