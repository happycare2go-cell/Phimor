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
          care_profile_id, mapping_status, room, created_at, updated_at,
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
