const { databaseQuery } = require('../db');

function createPlatformRepository({ queryFn = databaseQuery } = {}) {
  const one = async (sql, params = []) => (await queryFn(sql, params)).rows[0] || null;
  const many = async (sql, params = []) => (await queryFn(sql, params)).rows;

  return {
    createOrganization(record) {
      return one(
        `INSERT INTO organizations (
          organization_id, organization_code, display_name, organization_type, status
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
        [record.organizationId, record.organizationCode, record.displayName, record.organizationType, record.status]
      );
    },

    findOrganization(organizationId) {
      return one('SELECT * FROM organizations WHERE organization_id = $1', [organizationId]);
    },

    findOrganizationByCode(organizationCode) {
      return one('SELECT * FROM organizations WHERE organization_code = $1', [organizationCode]);
    },

    listOrganizations() {
      return many('SELECT * FROM organizations ORDER BY display_name ASC, organization_id ASC');
    },

    listOperationsFoundation({ limit = 200, centerLimit = 500, includeCapabilities = false }) {
      return one(
        `WITH organization_slice AS (
          SELECT * FROM organizations ORDER BY LOWER(display_name), organization_id LIMIT $1
        ), center_rows AS (
          SELECT oc.organization_id, oc.center_id, oc.linked_at,
            c.data->>'name' AS center_name, COALESCE(c.data->>'status','active') AS center_status,
            CASE WHEN $3::boolean THEN COALESCE(jsonb_agg(jsonb_build_object(
              'capability_key',cap.capability_key,'enabled',cap.enabled,
              'enabled_at',cap.enabled_at,'updated_at',cap.updated_at
            ) ORDER BY cap.capability_key) FILTER (WHERE cap.capability_key IS NOT NULL),'[]'::jsonb)
            ELSE '[]'::jsonb END AS capabilities
          FROM organization_centers oc
          INNER JOIN organization_slice o ON o.organization_id=oc.organization_id
          INNER JOIN centers c ON c.data->>'center_id'=oc.center_id
          LEFT JOIN center_capabilities cap ON cap.center_id=oc.center_id
          GROUP BY oc.organization_id,oc.center_id,oc.linked_at,c.data
          ORDER BY LOWER(c.data->>'name'),oc.center_id LIMIT $2
        )
        SELECT jsonb_build_object(
          'organizations',COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY LOWER(o.display_name),o.organization_id) FROM organization_slice o),'[]'::jsonb),
          'centers',COALESCE((SELECT jsonb_agg(to_jsonb(cr) ORDER BY LOWER(cr.center_name),cr.center_id) FROM center_rows cr),'[]'::jsonb),
          'organizationTotal',(SELECT COUNT(*)::int FROM organizations),
          'centerTotal',(SELECT COUNT(*)::int FROM organization_centers)
        ) AS foundation`,
        [limit, centerLimit, includeCapabilities]
      ).then((row) => row?.foundation || { organizations:[], centers:[], organizationTotal:0, centerTotal:0 });
    },

    linkCenter({ organizationId, centerId, actorReference }) {
      return one(
        `INSERT INTO organization_centers (
          center_id, organization_id, linked_by_admin_id
        ) VALUES ($1, $2, $3)
        ON CONFLICT (center_id) DO NOTHING
        RETURNING *`,
        [centerId, organizationId, actorReference]
      );
    },

    relinkCenter({ organizationId, centerId, actorReference }) {
      return one(
        `UPDATE organization_centers SET
          organization_id = $2, linked_by_admin_id = $3, updated_at = CURRENT_TIMESTAMP
         WHERE center_id = $1 RETURNING *`,
        [centerId, organizationId, actorReference]
      );
    },

    findOrganizationForCenter(centerId) {
      return one(
        `SELECT o.*, oc.center_id, oc.linked_at, oc.updated_at AS relationship_updated_at
         FROM organization_centers oc
         INNER JOIN organizations o ON o.organization_id = oc.organization_id
         WHERE oc.center_id = $1`,
        [centerId]
      );
    },

    listOrganizationCenters(organizationId) {
      return many(
        `SELECT center_id, organization_id, linked_at, updated_at
         FROM organization_centers WHERE organization_id = $1 ORDER BY center_id ASC`,
        [organizationId]
      );
    },

    countCenterIntegrationDependencies(centerId) {
      return one(
        `SELECT (
          (SELECT COUNT(*) FROM integration_client_centers WHERE center_id = $1)
          + (SELECT COUNT(*) FROM external_center_mappings WHERE center_id = $1 AND status = 'active')
        )::integer AS dependency_count`,
        [centerId]
      ).then((row) => Number(row?.dependency_count || 0));
    },

    listCapabilities(centerId) {
      return many(
        `SELECT center_id, capability_key, enabled, enabled_at, updated_at
         FROM center_capabilities WHERE center_id = $1 ORDER BY capability_key ASC`,
        [centerId]
      );
    },

    findCapability(centerId, capabilityKey) {
      return one(
        `SELECT center_id, capability_key, enabled, enabled_at, updated_at
         FROM center_capabilities WHERE center_id = $1 AND capability_key = $2`,
        [centerId, capabilityKey]
      );
    },

    upsertCapability({ centerId, capabilityKey, enabled, actorReference }) {
      return one(
        `INSERT INTO center_capabilities (
          center_id, capability_key, enabled, enabled_by_admin_id, enabled_at, updated_at
        ) VALUES ($1, $2, $3, CASE WHEN $3 THEN $4 ELSE NULL END,
          CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
        ON CONFLICT (center_id, capability_key) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          enabled_by_admin_id = EXCLUDED.enabled_by_admin_id,
          enabled_at = EXCLUDED.enabled_at,
          updated_at = CURRENT_TIMESTAMP
        RETURNING center_id, capability_key, enabled, enabled_at, updated_at`,
        [centerId, capabilityKey, enabled, actorReference]
      );
    },

    async lockIdentityLearningCandidate({ centerId, residentId, careProfileId }) {
      const locks = [
        ['centers', 'center_id', centerId],
        ['careProfiles', 'care_profile_id', careProfileId],
        ['residents', 'resident_id', residentId],
      ];
      for (const [table, field, value] of locks) {
        const row = await one(
          `SELECT id FROM "${table}" WHERE data->>'${field}' = $1 FOR UPDATE`,
          [value]
        );
        if (!row) return false;
      }
      return true;
    },

    createIntegrationClient(record) {
      return one(
        `INSERT INTO integration_clients (
          integration_client_id, organization_id, client_code,
          display_name, source_system, status
        ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [record.integrationClientId, record.organizationId, record.clientCode,
          record.displayName, record.sourceSystem, record.status || 'active']
      );
    },

    findIntegrationClient(integrationClientId) {
      return one('SELECT * FROM integration_clients WHERE integration_client_id = $1', [integrationClientId]);
    },

    listIntegrationClients(organizationId) {
      return many(
        `SELECT * FROM integration_clients WHERE organization_id = $1
         ORDER BY created_at DESC, integration_client_id DESC`,
        [organizationId]
      );
    },

    listIntegrationClientDirectory({ search = '', status = null, limit = 20, offset = 0 }) {
      return many(
        `WITH center_counts AS (
          SELECT integration_client_id, COUNT(*)::int AS allowed_center_count
          FROM integration_client_centers GROUP BY integration_client_id
        ), event_counts AS (
          SELECT integration_client_id, COUNT(*)::int AS allowed_event_count
          FROM integration_client_event_scopes GROUP BY integration_client_id
        ), credential_counts AS (
          SELECT integration_client_id,
            COUNT(*) FILTER (WHERE status='active' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP))::int AS active_credential_count,
            MAX(last_used_at) AS last_used_at
          FROM integration_credentials GROUP BY integration_client_id
        ), center_mapping_counts AS (
          SELECT integration_client_id, COUNT(*) FILTER (WHERE status='active')::int AS active_center_mapping_count
          FROM external_center_mappings GROUP BY integration_client_id
        ), subject_mapping_counts AS (
          SELECT integration_client_id, COUNT(*) FILTER (WHERE mapping_status='mapped')::int AS mapped_subject_count
          FROM external_subject_mappings GROUP BY integration_client_id
        ), warning_counts AS (
          SELECT integration_client_id,
            COUNT(*) FILTER (WHERE status IN ('retrying','dead','rejected','pending'))::int AS warning_count
          FROM integration_event_inbox GROUP BY integration_client_id
        ), directory AS (
          SELECT c.integration_client_id, c.organization_id, c.client_code, c.display_name,
            c.source_system, c.status, c.created_at, c.updated_at, o.display_name AS organization_name,
            o.status AS organization_status,
            COALESCE(cc.allowed_center_count,0) AS allowed_center_count,
            COALESCE(ec.allowed_event_count,0) AS allowed_event_count,
            COALESCE(cr.active_credential_count,0) AS active_credential_count,
            cr.last_used_at,
            COALESCE(cm.active_center_mapping_count,0) AS active_center_mapping_count,
            COALESCE(sm.mapped_subject_count,0) AS mapped_subject_count,
            COALESCE(w.warning_count,0) AS warning_count,
            COALESCE((SELECT al.data->'policy'->>'identityResolutionMode'
              FROM "auditLog" al
              WHERE al.data->>'log_id' = 'integration-policy:' || c.integration_client_id
              ORDER BY al.created_at DESC LIMIT 1), 'manual_mapping_only') AS identity_resolution_mode
          FROM integration_clients c
          INNER JOIN organizations o ON o.organization_id = c.organization_id
          LEFT JOIN center_counts cc ON cc.integration_client_id = c.integration_client_id
          LEFT JOIN event_counts ec ON ec.integration_client_id = c.integration_client_id
          LEFT JOIN credential_counts cr ON cr.integration_client_id = c.integration_client_id
          LEFT JOIN center_mapping_counts cm ON cm.integration_client_id = c.integration_client_id
          LEFT JOIN subject_mapping_counts sm ON sm.integration_client_id = c.integration_client_id
          LEFT JOIN warning_counts w ON w.integration_client_id = c.integration_client_id
          WHERE ($1::text = '' OR POSITION(LOWER($1) IN LOWER(c.display_name)) > 0
            OR POSITION(LOWER($1) IN LOWER(c.client_code)) > 0
            OR POSITION(LOWER($1) IN LOWER(c.source_system)) > 0)
            AND ($2::text IS NULL OR c.status = $2)
        )
        SELECT *, COUNT(*) OVER()::int AS total_count
        FROM directory ORDER BY LOWER(display_name), integration_client_id
        LIMIT $3 OFFSET $4`,
        [search, status, limit, offset]
      );
    },

    countIntegrationClientDirectory({ search = '', status = null }) {
      return one(
        `SELECT COUNT(*)::int AS total
         FROM integration_clients c
         WHERE ($1::text = '' OR POSITION(LOWER($1) IN LOWER(c.display_name)) > 0
           OR POSITION(LOWER($1) IN LOWER(c.client_code)) > 0
           OR POSITION(LOWER($1) IN LOWER(c.source_system)) > 0)
           AND ($2::text IS NULL OR c.status = $2)`,
        [search, status]
      ).then((row) => Number(row?.total) || 0);
    },

    updateIntegrationClientStatus(integrationClientId, status) {
      return one(
        `UPDATE integration_clients SET status = $2,
          revoked_at = CASE WHEN $2 = 'revoked' THEN CURRENT_TIMESTAMP ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP
         WHERE integration_client_id = $1 RETURNING *`,
        [integrationClientId, status]
      );
    },

    addClientCenterScope(record) {
      return one(
        `INSERT INTO integration_client_centers (
          integration_client_id, organization_id, center_id, granted_by_admin_id
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (integration_client_id, center_id) DO NOTHING RETURNING *`,
        [record.integrationClientId, record.organizationId, record.centerId, record.actorReference]
      );
    },

    removeClientCenterScope(integrationClientId, centerId) {
      return one(
        `DELETE FROM integration_client_centers
         WHERE integration_client_id = $1 AND center_id = $2 RETURNING *`,
        [integrationClientId, centerId]
      );
    },

    listClientCenterScopes(integrationClientId) {
      return many(
        `SELECT integration_client_id, organization_id, center_id, created_at
         FROM integration_client_centers WHERE integration_client_id = $1 ORDER BY center_id ASC`,
        [integrationClientId]
      );
    },

    hasClientCenterScope(integrationClientId, centerId) {
      return one(
        `SELECT 1 AS allowed FROM integration_client_centers
         WHERE integration_client_id = $1 AND center_id = $2`,
        [integrationClientId, centerId]
      ).then(Boolean);
    },

    addClientEventScope(record) {
      return one(
        `INSERT INTO integration_client_event_scopes (
          integration_client_id, event_type, granted_by_admin_id
        ) VALUES ($1, $2, $3)
        ON CONFLICT (integration_client_id, event_type) DO NOTHING RETURNING *`,
        [record.integrationClientId, record.eventType, record.actorReference]
      );
    },

    removeClientEventScope(integrationClientId, eventType) {
      return one(
        `DELETE FROM integration_client_event_scopes
         WHERE integration_client_id = $1 AND event_type = $2 RETURNING *`,
        [integrationClientId, eventType]
      );
    },

    listClientEventScopes(integrationClientId) {
      return many(
        `SELECT integration_client_id, event_type, created_at
         FROM integration_client_event_scopes WHERE integration_client_id = $1 ORDER BY event_type ASC`,
        [integrationClientId]
      );
    },

    hasClientEventScope(integrationClientId, eventType) {
      return one(
        `SELECT 1 AS allowed FROM integration_client_event_scopes
         WHERE integration_client_id = $1 AND event_type = $2`,
        [integrationClientId, eventType]
      ).then(Boolean);
    },

    createCredential(record) {
      return one(
        `INSERT INTO integration_credentials (
          credential_id, integration_client_id, public_prefix,
          secret_salt, secret_hash, status, expires_at, rotated_from_credential_id
        ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7) RETURNING *`,
        [record.credentialId, record.integrationClientId, record.publicPrefix,
          record.secretSalt, record.secretHash, record.expiresAt, record.rotatedFromCredentialId]
      );
    },

    findCredential(credentialId) {
      return one('SELECT * FROM integration_credentials WHERE credential_id = $1', [credentialId]);
    },

    findCredentialByPrefix(publicPrefix) {
      return one(
        `SELECT c.*, ic.organization_id, ic.client_code, ic.display_name AS client_display_name,
          ic.source_system, ic.status AS client_status, ic.revoked_at AS client_revoked_at,
          o.status AS organization_status
         FROM integration_credentials c
         INNER JOIN integration_clients ic ON ic.integration_client_id = c.integration_client_id
         INNER JOIN organizations o ON o.organization_id = ic.organization_id
         WHERE c.public_prefix = $1`,
        [publicPrefix]
      );
    },

    listActiveCredentials(integrationClientId) {
      return many(
        `SELECT * FROM integration_credentials
         WHERE integration_client_id = $1 AND status = 'active'
           AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
         ORDER BY created_at DESC`,
        [integrationClientId]
      );
    },

    listCredentials(integrationClientId) {
      return many(
        `SELECT * FROM integration_credentials
         WHERE integration_client_id = $1
         ORDER BY created_at DESC, credential_id DESC`,
        [integrationClientId]
      );
    },

    revokeCredential(credentialId) {
      return one(
        `UPDATE integration_credentials SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
         WHERE credential_id = $1 AND status = 'active' RETURNING *`,
        [credentialId]
      );
    },

    expireCredentialAt(credentialId, expiresAt) {
      return one(
        `UPDATE integration_credentials SET expires_at = $2
         WHERE credential_id = $1 AND status = 'active' RETURNING *`,
        [credentialId, expiresAt]
      );
    },

    touchCredential(credentialId) {
      return queryFn(
        `UPDATE integration_credentials SET last_used_at = CURRENT_TIMESTAMP
         WHERE credential_id = $1`,
        [credentialId]
      );
    },

    findExternalCenterMapping(integrationClientId, externalCenterId) {
      return one(
        `SELECT * FROM external_center_mappings
         WHERE integration_client_id = $1 AND external_center_id = $2`,
        [integrationClientId, externalCenterId]
      );
    },

    findActiveExternalCenterMappingByCenter(integrationClientId, centerId) {
      return one(
        `SELECT * FROM external_center_mappings
         WHERE integration_client_id = $1 AND center_id = $2 AND status = 'active'
         LIMIT 1`,
        [integrationClientId, centerId]
      );
    },

    listExternalCenterMappings({ integrationClientId, status = null, search = null, limit = 50, offset = 0 }) {
      return many(
        `SELECT external_center_mapping_id, integration_client_id, organization_id,
          external_center_id, center_id, display_name, status, created_at,
          updated_at, deactivated_at
         FROM external_center_mappings
         WHERE integration_client_id = $1
           AND ($2::text IS NULL OR status = $2)
           AND ($3::text IS NULL OR external_center_id ILIKE ('%' || $3 || '%'))
         ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
           updated_at DESC, external_center_id ASC
         LIMIT $4 OFFSET $5`,
        [integrationClientId, status, search, limit, offset]
      );
    },

    countExternalCenterMappings({ integrationClientId, status = null, search = null }) {
      return one(
        `SELECT COUNT(*)::integer AS total
         FROM external_center_mappings
         WHERE integration_client_id = $1
           AND ($2::text IS NULL OR status = $2)
           AND ($3::text IS NULL OR external_center_id ILIKE ('%' || $3 || '%'))`,
        [integrationClientId, status, search]
      ).then((row) => Number(row?.total || 0));
    },

    upsertExternalCenterMapping(record) {
      return one(
        `INSERT INTO external_center_mappings (
          external_center_mapping_id, integration_client_id, organization_id,
          external_center_id, center_id, display_name, status
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active')
        ON CONFLICT (integration_client_id, external_center_id) DO UPDATE SET
          organization_id = EXCLUDED.organization_id,
          center_id = EXCLUDED.center_id,
          display_name = EXCLUDED.display_name,
          status = 'active', deactivated_at = NULL, updated_at = CURRENT_TIMESTAMP
        RETURNING *`,
        [record.mappingId, record.integrationClientId, record.organizationId,
          record.externalCenterId, record.centerId, record.displayName]
      );
    },

    deactivateExternalCenterMapping(integrationClientId, externalCenterId) {
      return one(
        `UPDATE external_center_mappings SET status = 'inactive',
          deactivated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE integration_client_id = $1 AND external_center_id = $2 AND status = 'active'
         RETURNING *`,
        [integrationClientId, externalCenterId]
      );
    },

    findExternalSubjectMapping(integrationClientId, externalCenterId, externalResidentId) {
      return one(
        `SELECT * FROM external_subject_mappings
         WHERE integration_client_id = $1 AND external_center_id = $2
           AND external_resident_id = $3`,
        [integrationClientId, externalCenterId, externalResidentId]
      );
    },

    listExternalSubjectMappings({ integrationClientId, status = null, search = null, limit = 50, offset = 0 }) {
      return many(
        `SELECT external_subject_mapping_id, integration_client_id, organization_id,
          external_center_id, external_resident_id, center_id, resident_id,
          care_profile_id, mapping_status, room, last_seen_at, created_at, updated_at,
          deactivated_at
         FROM external_subject_mappings
         WHERE integration_client_id = $1
           AND ($2::text IS NULL OR mapping_status = $2)
           AND ($3::text IS NULL OR external_resident_id ILIKE ('%' || $3 || '%'))
         ORDER BY CASE mapping_status WHEN 'mapped' THEN 0
           WHEN 'pending_subject_mapping' THEN 1 ELSE 2 END,
           updated_at DESC, external_center_id ASC, external_resident_id ASC
         LIMIT $4 OFFSET $5`,
        [integrationClientId, status, search, limit, offset]
      );
    },

    countExternalSubjectMappings({ integrationClientId, status = null, search = null }) {
      return one(
        `SELECT COUNT(*)::integer AS total
         FROM external_subject_mappings
         WHERE integration_client_id = $1
           AND ($2::text IS NULL OR mapping_status = $2)
           AND ($3::text IS NULL OR external_resident_id ILIKE ('%' || $3 || '%'))`,
        [integrationClientId, status, search]
      ).then((row) => Number(row?.total || 0));
    },

    upsertExternalSubjectMapping(record) {
      return one(
        `INSERT INTO external_subject_mappings (
          external_subject_mapping_id, integration_client_id, organization_id,
          external_center_id, external_resident_id, center_id, resident_id,
          care_profile_id, mapping_status, first_name, last_name, display_name,
          room, last_seen_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (integration_client_id, external_center_id, external_resident_id)
        DO UPDATE SET
          center_id = EXCLUDED.center_id, resident_id = EXCLUDED.resident_id,
          care_profile_id = EXCLUDED.care_profile_id,
          mapping_status = EXCLUDED.mapping_status,
          first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
          display_name = EXCLUDED.display_name, room = EXCLUDED.room,
          last_seen_at = EXCLUDED.last_seen_at, deactivated_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *`,
        [record.mappingId, record.integrationClientId, record.organizationId,
          record.externalCenterId, record.externalResidentId, record.centerId,
          record.residentId, record.careProfileId, record.mappingStatus,
          record.firstName, record.lastName, record.displayName, record.room,
          record.lastSeenAt]
      );
    },

    deactivateExternalSubjectMapping(integrationClientId, externalCenterId, externalResidentId) {
      return one(
        `UPDATE external_subject_mappings SET mapping_status = 'inactive',
          deactivated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE integration_client_id = $1 AND external_center_id = $2
           AND external_resident_id = $3 AND mapping_status <> 'inactive'
         RETURNING *`,
        [integrationClientId, externalCenterId, externalResidentId]
      );
    },

    insertAuditEvent(record) {
      return one(
        `INSERT INTO platform_audit_events (
          platform_audit_event_id, event_type, actor_type, actor_reference,
          organization_id, center_id, integration_client_id, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
        [record.eventId, record.eventType, record.actorType, record.actorReference,
          record.organizationId, record.centerId, record.integrationClientId,
          JSON.stringify(record.metadata || {})]
      );
    },
  };
}

module.exports = { createPlatformRepository };
