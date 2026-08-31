module.exports={
  version:'0017',
  name:'create_integration_field_picker_adapters',
  async up(client){
    const required=await client.query(`SELECT to_regclass('public.integration_clients') AS integration_clients,
      to_regclass('public.integration_adapter_profiles') AS legacy_adapter_profiles,
      to_regclass('public.integration_adapter_templates') AS adapter_templates,
      to_regclass('public.integration_adapter_versions') AS adapter_versions,
      to_regclass('public.integration_adapter_bindings') AS adapter_bindings,
      to_regclass('public.integration_adapter_samples') AS adapter_samples,
      to_regclass('public.integration_adapter_source_notices') AS adapter_notices`);
    const row=required.rows[0]||{};
    if(!row.integration_clients)throw new Error('INTEGRATION_CLIENTS_TABLE_REQUIRED');
    if([row.legacy_adapter_profiles,row.adapter_templates,row.adapter_versions,row.adapter_bindings,row.adapter_samples,row.adapter_notices].some(Boolean))throw new Error('INTEGRATION_ADAPTER_PARTIAL_SCHEMA_REVIEW_REQUIRED');
    await client.query(`CREATE TABLE integration_adapter_templates (
      adapter_template_id VARCHAR(80) PRIMARY KEY,
      source_system_key VARCHAR(120) NOT NULL,
      source_system_label VARCHAR(120) NOT NULL,
      target_event_type VARCHAR(120) NOT NULL CHECK (target_event_type='care.daily_report.finalized'),
      lineage_fingerprint CHAR(64) NOT NULL,
      display_name VARCHAR(240) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      created_by VARCHAR(128) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await client.query(`CREATE INDEX idx_integration_adapter_template_source
      ON integration_adapter_templates(source_system_key,target_event_type,status)`);
    await client.query(`CREATE UNIQUE INDEX uq_integration_adapter_template_lineage
      ON integration_adapter_templates(source_system_key,target_event_type,lineage_fingerprint)`);
    await client.query(`CREATE TABLE integration_adapter_versions (
      adapter_version_id VARCHAR(80) PRIMARY KEY,
      adapter_template_id VARCHAR(80) NOT NULL REFERENCES integration_adapter_templates(adapter_template_id),
      version INTEGER NOT NULL CHECK (version>0),
      status VARCHAR(24) NOT NULL CHECK (status IN ('draft','active','superseded')),
      mapping_rules JSONB NOT NULL CHECK (jsonb_typeof(mapping_rules)='array'),
      source_structural_fingerprint CHAR(64) NOT NULL,
      source_structure JSONB NOT NULL CHECK (jsonb_typeof(source_structure)='array'),
      created_by VARCHAR(128) NOT NULL,
      activated_by VARCHAR(128),
      activated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (adapter_template_id,version),
      CHECK ((status='active')=(activated_at IS NOT NULL AND activated_by IS NOT NULL)
        OR status IN ('draft','superseded'))
    )`);
    await client.query(`CREATE UNIQUE INDEX uq_integration_adapter_template_active
      ON integration_adapter_versions(adapter_template_id) WHERE status='active'`);
    await client.query(`CREATE INDEX idx_integration_adapter_version_fingerprint
      ON integration_adapter_versions(source_structural_fingerprint,status)`);
    await client.query(`CREATE TABLE integration_adapter_bindings (
      adapter_binding_id VARCHAR(80) PRIMARY KEY,
      integration_client_id VARCHAR(80) NOT NULL REFERENCES integration_clients(integration_client_id),
      target_event_type VARCHAR(120) NOT NULL CHECK (target_event_type='care.daily_report.finalized'),
      adapter_template_id VARCHAR(80) NOT NULL REFERENCES integration_adapter_templates(adapter_template_id),
      adapter_version_id VARCHAR(80) NOT NULL REFERENCES integration_adapter_versions(adapter_version_id),
      status VARCHAR(24) NOT NULL CHECK (status IN ('active','inactive')),
      activated_by VARCHAR(128) NOT NULL,
      activated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await client.query(`CREATE UNIQUE INDEX uq_integration_adapter_client_active
      ON integration_adapter_bindings(integration_client_id,target_event_type) WHERE status='active'`);
    await client.query(`CREATE INDEX idx_integration_adapter_template_bindings
      ON integration_adapter_bindings(adapter_template_id,status)`);
    await client.query(`CREATE TABLE integration_adapter_samples (
      adapter_sample_id VARCHAR(80) PRIMARY KEY,
      integration_client_id VARCHAR(80) NOT NULL REFERENCES integration_clients(integration_client_id),
      source_system_key VARCHAR(120) NOT NULL,
      target_event_type VARCHAR(120) NOT NULL CHECK (target_event_type='care.daily_report.finalized'),
      status VARCHAR(24) NOT NULL CHECK (status IN ('waiting','captured','consumed','expired','cancelled')),
      capture_expires_at TIMESTAMPTZ NOT NULL,
      sample_expires_at TIMESTAMPTZ,
      sample_payload JSONB,
      source_structural_fingerprint CHAR(64),
      source_structure JSONB,
      sample_size_bytes INTEGER CHECK (sample_size_bytes IS NULL OR sample_size_bytes BETWEEN 0 AND 262144),
      discovered_field_count INTEGER CHECK (discovered_field_count IS NULL OR discovered_field_count BETWEEN 0 AND 250),
      captured_at TIMESTAMPTZ,
      created_by VARCHAR(128) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (sample_payload IS NULL OR jsonb_typeof(sample_payload) IN ('object','array')),
      CHECK (source_structure IS NULL OR jsonb_typeof(source_structure)='array'),
      CHECK (status<>'captured' OR (sample_payload IS NOT NULL AND sample_expires_at IS NOT NULL
        AND source_structural_fingerprint IS NOT NULL AND source_structure IS NOT NULL AND captured_at IS NOT NULL))
    )`);
    await client.query(`CREATE UNIQUE INDEX uq_integration_adapter_waiting_capture
      ON integration_adapter_samples(integration_client_id,target_event_type) WHERE status='waiting'`);
    await client.query(`CREATE INDEX idx_integration_adapter_sample_expiry
      ON integration_adapter_samples(status,capture_expires_at,sample_expires_at)`);
    await client.query(`CREATE TABLE integration_adapter_source_notices (
      adapter_notice_id VARCHAR(80) PRIMARY KEY,
      adapter_template_id VARCHAR(80) NOT NULL REFERENCES integration_adapter_templates(adapter_template_id),
      adapter_version_id VARCHAR(80) NOT NULL REFERENCES integration_adapter_versions(adapter_version_id),
      notice_type VARCHAR(48) NOT NULL CHECK (notice_type IN ('NEW_SOURCE_FIELDS_AVAILABLE','ADAPTER_SOURCE_CHANGED','ADAPTER_TRANSFORM_FAILURE')),
      source_field_key CHAR(64) NOT NULL,
      source_path VARCHAR(600) NOT NULL,
      value_type VARCHAR(24),
      status VARCHAR(24) NOT NULL DEFAULT 'available' CHECK (status IN ('available','ignored','review_later','resolved')),
      occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count>0),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by VARCHAR(128),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(adapter_template_id,notice_type,source_field_key)
    )`);
    await client.query(`CREATE INDEX idx_integration_adapter_notice_queue
      ON integration_adapter_source_notices(adapter_template_id,status,notice_type,last_seen_at DESC)`);
  },
  async down(client){
    await client.query('DROP TABLE IF EXISTS integration_adapter_source_notices');
    await client.query('DROP TABLE IF EXISTS integration_adapter_samples');
    await client.query('DROP TABLE IF EXISTS integration_adapter_bindings');
    await client.query('DROP TABLE IF EXISTS integration_adapter_versions');
    await client.query('DROP TABLE IF EXISTS integration_adapter_templates');
  },
};
