const CAPABILITIES = "'vital_signs_v1', 'daily_care_v1'";
const EVENT_TYPES = "'care.vitals.recorded', 'care.daily_report.recorded'";

module.exports = {
  version: '0008',
  name: 'create_platform_organizations_and_integrations',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        organization_id VARCHAR(80) PRIMARY KEY,
        organization_code VARCHAR(100) NOT NULL UNIQUE,
        display_name TEXT NOT NULL CHECK (NULLIF(BTRIM(display_name), '') IS NOT NULL),
        organization_type VARCHAR(32) NOT NULL
          CHECK (organization_type IN ('external_care_center', 'platform_internal')),
        status VARCHAR(16) NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'suspended', 'archived')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // The legacy Centers table stores the canonical center_id inside JSONB, so
    // a direct FK is not possible without a destructive legacy-table rewrite.
    // This relational registry gives all new platform tables one exact center
    // identity and is maintained by the Center creation service.
    await client.query(`
      CREATE TABLE IF NOT EXISTS organization_centers (
        center_id VARCHAR(80) PRIMARY KEY,
        organization_id VARCHAR(80) NOT NULL
          REFERENCES organizations(organization_id) ON DELETE RESTRICT,
        linked_by_admin_id VARCHAR(128),
        linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (center_id, organization_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS center_capabilities (
        center_id VARCHAR(80) NOT NULL
          REFERENCES organization_centers(center_id) ON DELETE RESTRICT,
        capability_key VARCHAR(48) NOT NULL CHECK (capability_key IN (${CAPABILITIES})),
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        enabled_by_admin_id VARCHAR(128),
        enabled_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (center_id, capability_key),
        CHECK ((enabled = FALSE) OR (enabled_by_admin_id IS NOT NULL AND enabled_at IS NOT NULL))
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS integration_clients (
        integration_client_id VARCHAR(80) PRIMARY KEY,
        organization_id VARCHAR(80) NOT NULL
          REFERENCES organizations(organization_id) ON DELETE RESTRICT,
        client_code VARCHAR(100) NOT NULL UNIQUE,
        display_name TEXT NOT NULL CHECK (NULLIF(BTRIM(display_name), '') IS NOT NULL),
        source_system VARCHAR(100) NOT NULL CHECK (NULLIF(BTRIM(source_system), '') IS NOT NULL),
        status VARCHAR(16) NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'suspended', 'revoked')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TIMESTAMPTZ,
        UNIQUE (integration_client_id, organization_id),
        CHECK ((status = 'revoked' AND revoked_at IS NOT NULL) OR status <> 'revoked')
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS integration_credentials (
        credential_id VARCHAR(80) PRIMARY KEY,
        integration_client_id VARCHAR(80) NOT NULL
          REFERENCES integration_clients(integration_client_id) ON DELETE RESTRICT,
        public_prefix VARCHAR(32) NOT NULL UNIQUE,
        secret_salt BYTEA NOT NULL,
        secret_hash BYTEA NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'revoked')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        rotated_from_credential_id VARCHAR(80)
          REFERENCES integration_credentials(credential_id) ON DELETE RESTRICT,
        last_used_at TIMESTAMPTZ,
        CHECK (octet_length(secret_salt) >= 16),
        CHECK (octet_length(secret_hash) >= 32),
        CHECK ((status = 'revoked' AND revoked_at IS NOT NULL) OR status <> 'revoked')
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS integration_client_centers (
        integration_client_id VARCHAR(80) NOT NULL,
        organization_id VARCHAR(80) NOT NULL,
        center_id VARCHAR(80) NOT NULL,
        granted_by_admin_id VARCHAR(128) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (integration_client_id, center_id),
        FOREIGN KEY (integration_client_id, organization_id)
          REFERENCES integration_clients(integration_client_id, organization_id) ON DELETE RESTRICT,
        FOREIGN KEY (center_id, organization_id)
          REFERENCES organization_centers(center_id, organization_id) ON DELETE RESTRICT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS integration_client_event_scopes (
        integration_client_id VARCHAR(80) NOT NULL
          REFERENCES integration_clients(integration_client_id) ON DELETE RESTRICT,
        event_type VARCHAR(80) NOT NULL CHECK (event_type IN (${EVENT_TYPES})),
        granted_by_admin_id VARCHAR(128) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (integration_client_id, event_type)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS external_center_mappings (
        external_center_mapping_id VARCHAR(80) PRIMARY KEY,
        integration_client_id VARCHAR(80) NOT NULL,
        organization_id VARCHAR(80) NOT NULL,
        external_center_id VARCHAR(160) NOT NULL,
        center_id VARCHAR(80) NOT NULL,
        display_name TEXT,
        status VARCHAR(16) NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'inactive')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deactivated_at TIMESTAMPTZ,
        UNIQUE (integration_client_id, external_center_id),
        UNIQUE (integration_client_id, external_center_id, organization_id, center_id),
        FOREIGN KEY (integration_client_id, organization_id)
          REFERENCES integration_clients(integration_client_id, organization_id) ON DELETE RESTRICT,
        FOREIGN KEY (integration_client_id, center_id)
          REFERENCES integration_client_centers(integration_client_id, center_id) ON DELETE RESTRICT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS external_subject_mappings (
        external_subject_mapping_id VARCHAR(80) PRIMARY KEY,
        integration_client_id VARCHAR(80) NOT NULL,
        organization_id VARCHAR(80) NOT NULL,
        external_center_id VARCHAR(160) NOT NULL,
        external_resident_id VARCHAR(160) NOT NULL,
        center_id VARCHAR(80) NOT NULL,
        resident_id VARCHAR(80),
        care_profile_id VARCHAR(80),
        mapping_status VARCHAR(32) NOT NULL DEFAULT 'pending_subject_mapping'
          CHECK (mapping_status IN ('pending_subject_mapping', 'mapped', 'inactive')),
        first_name TEXT,
        last_name TEXT,
        display_name TEXT,
        room TEXT,
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deactivated_at TIMESTAMPTZ,
        UNIQUE (integration_client_id, external_center_id, external_resident_id),
        FOREIGN KEY (integration_client_id, external_center_id, organization_id, center_id)
          REFERENCES external_center_mappings(
            integration_client_id, external_center_id, organization_id, center_id
          ) ON DELETE RESTRICT,
        CHECK (
          (mapping_status = 'mapped' AND resident_id IS NOT NULL)
          OR (mapping_status = 'pending_subject_mapping' AND resident_id IS NULL AND care_profile_id IS NULL)
          OR mapping_status = 'inactive'
        )
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_audit_events (
        platform_audit_event_id VARCHAR(80) PRIMARY KEY,
        event_type VARCHAR(80) NOT NULL,
        actor_type VARCHAR(32) NOT NULL CHECK (actor_type IN ('system_admin', 'system')),
        actor_reference VARCHAR(128) NOT NULL,
        organization_id VARCHAR(80),
        center_id VARCHAR(80),
        integration_client_id VARCHAR(80),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(organization_id) ON DELETE RESTRICT,
        FOREIGN KEY (integration_client_id) REFERENCES integration_clients(integration_client_id) ON DELETE RESTRICT
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_organization_centers_organization
        ON organization_centers (organization_id, center_id);
      CREATE INDEX IF NOT EXISTS idx_center_capabilities_enabled
        ON center_capabilities (capability_key, center_id) WHERE enabled = TRUE;
      CREATE INDEX IF NOT EXISTS idx_integration_credentials_client_status
        ON integration_credentials (integration_client_id, status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_external_subject_mapping_status
        ON external_subject_mappings (integration_client_id, center_id, mapping_status);
      CREATE INDEX IF NOT EXISTS idx_platform_audit_scope_time
        ON platform_audit_events (organization_id, occurred_at DESC, platform_audit_event_id DESC);
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION guard_append_only_platform_audit()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'platform audit events are append-only';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_guard_append_only_platform_audit ON platform_audit_events;
      CREATE TRIGGER trg_guard_append_only_platform_audit
        BEFORE UPDATE OR DELETE ON platform_audit_events
        FOR EACH ROW EXECUTE FUNCTION guard_append_only_platform_audit();
    `);

    // Additive, deterministic one-Center-to-one-Organization backfill. No
    // names, owners, phones or addresses are used to merge organizations.
    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.centers') IS NOT NULL THEN
          INSERT INTO organizations (
            organization_id, organization_code, display_name, organization_type, status
          )
          SELECT
            'ORG-BACKFILL-' || SUBSTR(MD5(data->>'center_id'), 1, 24),
            'center-' || SUBSTR(MD5(data->>'center_id'), 1, 24),
            COALESCE(NULLIF(BTRIM(data->>'name'), ''), 'Existing Center'),
            'external_care_center',
            'active'
          FROM "centers"
          WHERE NULLIF(BTRIM(data->>'center_id'), '') IS NOT NULL
          ON CONFLICT (organization_code) DO NOTHING;

          WITH existing_centers AS (
            SELECT DISTINCT data->>'center_id' AS center_id,
              COALESCE(NULLIF(BTRIM(data->>'name'), ''), 'Existing Center') AS display_name
            FROM "centers"
            WHERE NULLIF(BTRIM(data->>'center_id'), '') IS NOT NULL
          )
          INSERT INTO organization_centers (center_id, organization_id, linked_by_admin_id)
          SELECT
            center_id,
            'ORG-BACKFILL-' || SUBSTR(MD5(center_id), 1, 24),
            'migration:0008'
          FROM existing_centers
          ON CONFLICT (center_id) DO NOTHING;

          INSERT INTO platform_audit_events (
            platform_audit_event_id, event_type, actor_type, actor_reference,
            organization_id, center_id, metadata
          )
          SELECT
            'PAE-BACKFILL-' || SUBSTR(MD5(oc.center_id), 1, 24),
            'organization.center_backfilled', 'system', 'migration:0008',
            oc.organization_id, oc.center_id, '{"backfill":true}'::jsonb
          FROM organization_centers oc
          WHERE oc.linked_by_admin_id = 'migration:0008'
          ON CONFLICT (platform_audit_event_id) DO NOTHING;
        END IF;
      END;
      $$
    `);
  },

  async down(client) {
    await client.query(`
      DROP TRIGGER IF EXISTS trg_guard_append_only_platform_audit ON platform_audit_events;
      DROP FUNCTION IF EXISTS guard_append_only_platform_audit();
      DROP TABLE IF EXISTS platform_audit_events;
      DROP TABLE IF EXISTS external_subject_mappings;
      DROP TABLE IF EXISTS external_center_mappings;
      DROP TABLE IF EXISTS integration_client_event_scopes;
      DROP TABLE IF EXISTS integration_client_centers;
      DROP TABLE IF EXISTS integration_credentials;
      DROP TABLE IF EXISTS integration_clients;
      DROP TABLE IF EXISTS center_capabilities;
      DROP TABLE IF EXISTS organization_centers;
      DROP TABLE IF EXISTS organizations;
    `);
  },
};
