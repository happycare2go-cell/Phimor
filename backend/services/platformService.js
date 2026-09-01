const crypto = require('node:crypto');
const {
  Centers, Residents, CareProfiles, id, withTransaction, withTransactionLocks,
} = require('../db');
const { createPlatformRepository } = require('./platformRepository');
const { integrationIdentityPolicyService } = require('./integrationIdentityPolicyService');
const { assertPolicy, normalizeIdentityName } = require('../domain/integrationIdentity');
const {
  ORGANIZATION_STATUSES,
  ORGANIZATION_TYPES,
  CAPABILITY_KEYS,
  INTEGRATION_CLIENT_STATUSES,
  PlatformError,
  assertEnum,
  requiredText,
  optionalText,
  assertCapabilityKey,
  assertEventType,
} = require('../domain/platform');

const INTEGRATION_CAPABILITY_FOR_EVENT = Object.freeze({
  'care.vitals.recorded':'vital_signs_v1',
  'care.daily_report.finalized':'daily_care_v1',
});

const TOKEN_PATTERN = /^pim_int_([a-f0-9]{16})\.([A-Za-z0-9_-]{32,})$/;
const MAX_ROTATION_OVERLAP_SECONDS = 24 * 60 * 60;

function safeActorReference(value) {
  const clean = String(value || '').trim();
  if (!clean || clean.length > 128) throw new PlatformError('ADMIN_ACTOR_REQUIRED', 'ไม่พบตัวตนผู้ดูแลระบบ', 401);
  return clean;
}

function credentialProjection(row) {
  if (!row) return null;
  return {
    credentialId: row.credential_id,
    integrationClientId: row.integration_client_id,
    publicPrefix: row.public_prefix,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at || null,
    revokedAt: row.revoked_at || null,
    rotatedFromCredentialId: row.rotated_from_credential_id || null,
    lastUsedAt: row.last_used_at || null,
  };
}

function clientProjection(row) {
  if (!row) return null;
  return {
    integrationClientId: row.integration_client_id,
    organizationId: row.organization_id,
    clientCode: row.client_code,
    displayName: row.display_name,
    sourceSystem: row.source_system,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at || null,
  };
}

function organizationProjection(row) {
  if (!row) return null;
  return {
    organizationId: row.organization_id,
    organizationCode: row.organization_code,
    displayName: row.display_name,
    organizationType: row.organization_type,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function externalCenterMappingProjection(row, center = null) {
  return {
    externalCenterId: row.external_center_id,
    centerId: row.center_id,
    centerName: center?.name || null,
    centerStatus: center?.status || null,
    displayName: row.display_name || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deactivatedAt: row.deactivated_at || null,
    mappingSource: row.mapping_source || 'configured_manually',
    lastUsedAt: row.last_used_at || row.updated_at || null,
  };
}

function externalSubjectMappingProjection(row, resident = null, center = null) {
  const residentActive = resident?.status === 'active';
  return {
    externalCenterId: row.external_center_id,
    externalResidentId: row.external_resident_id,
    centerId: row.center_id,
    centerName: center?.name || null,
    residentDisplayName: resident?.full_name || null,
    room: resident?.room || row.room || null,
    residentStatus: resident?.status || null,
    mappingStatus: row.mapping_status,
    careProfileReady: Boolean(residentActive && resident?.care_profile_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deactivatedAt: row.deactivated_at || null,
    mappingSource: row.mapping_source || 'configured_manually',
    lastUsedAt: row.last_seen_at || row.updated_at || null,
  };
}

function paginationInput({ page = 1, limit = 50 } = {}) {
  const normalizedPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const normalizedLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));
  return { page: normalizedPage, limit: normalizedLimit, offset: (normalizedPage - 1) * normalizedLimit };
}

function createPlatformService(overrides = {}) {
  const repository = overrides.repository || createPlatformRepository();
  const centers = overrides.Centers || Centers;
  const residents = overrides.Residents || Residents;
  const idFactory = overrides.idFactory || id;
  const randomBytes = overrides.randomBytes || crypto.randomBytes;
  const runTransaction = overrides.withTransaction || withTransaction;
  const runTransactionLocks = overrides.withTransactionLocks || withTransactionLocks;
  const now = overrides.now || (() => new Date());
  const identityPolicies = overrides.integrationIdentityPolicyService || integrationIdentityPolicyService;

  async function audit(eventType, actorReference, scope = {}, metadata = {}) {
    const safeMetadata = {};
    for (const key of ['capabilityKey', 'enabled', 'clientCode', 'clientStatus', 'eventType', 'externalCenterId',
      'externalResidentId', 'mappingStatus', 'mappingSource', 'previousOrganizationId', 'credentialId', 'overlapSeconds',
      'identityResolutionMode', 'unresolvedEventPolicy', 'familyGroupRequirement', 'previousStatus', 'revokedAt']) {
      if (metadata[key] !== undefined && metadata[key] !== null) safeMetadata[key] = metadata[key];
    }
    return repository.insertAuditEvent({
      eventId: idFactory('PAE'), eventType,
      actorType: String(actorReference).startsWith('system:') ? 'system' : 'system_admin',
      actorReference: safeActorReference(actorReference),
      organizationId: scope.organizationId || null,
      centerId: scope.centerId || null,
      integrationClientId: scope.integrationClientId || null,
      metadata: safeMetadata,
    });
  }

  async function requireCenter(centerId) {
    const clean = requiredText(centerId, { code: 'CENTER_REQUIRED', label: 'Center ID', max: 80 });
    const center = await centers.findOne((row) => row.center_id === clean);
    if (!center) throw new PlatformError('CENTER_NOT_FOUND', 'ไม่พบศูนย์', 404);
    return center;
  }

  async function requireOrganization(organizationId, { active = true } = {}) {
    const organization = await repository.findOrganization(requiredText(organizationId, {
      code: 'ORGANIZATION_REQUIRED', label: 'Organization ID', max: 80,
    }));
    if (!organization) throw new PlatformError('ORGANIZATION_NOT_FOUND', 'ไม่พบองค์กร', 404);
    if (active && organization.status !== 'active') {
      throw new PlatformError('ORGANIZATION_INACTIVE', 'องค์กรไม่พร้อมใช้งาน', 403);
    }
    return organization;
  }

  async function requireClient(integrationClientId, { active = true } = {}) {
    const client = await repository.findIntegrationClient(requiredText(integrationClientId, {
      code: 'INTEGRATION_CLIENT_REQUIRED', label: 'Integration Client ID', max: 80,
    }));
    if (!client) throw new PlatformError('INTEGRATION_CLIENT_NOT_FOUND', 'ไม่พบ Integration Client', 404);
    if (active && client.status !== 'active') {
      throw new PlatformError('INTEGRATION_CLIENT_INACTIVE', 'Integration Client ไม่พร้อมใช้งาน', 403);
    }
    await requireOrganization(client.organization_id, { active });
    return client;
  }

  async function requireConfigurableClient(integrationClientId) {
    const client = await requireClient(integrationClientId, { active: false });
    if (client.status === 'revoked') {
      throw new PlatformError('INTEGRATION_CLIENT_REVOKED', 'Integration Client ถูกเพิกถอนแล้ว', 409);
    }
    await requireOrganization(client.organization_id);
    return client;
  }

  async function createOrganization({ organizationCode, displayName, organizationType = 'external_care_center', actorReference }) {
    const code = requiredText(organizationCode, { code: 'ORGANIZATION_CODE_REQUIRED', label: 'รหัสองค์กร', max: 100 }).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{2,99}$/.test(code)) {
      throw new PlatformError('INVALID_ORGANIZATION_CODE', 'รหัสองค์กรไม่ถูกต้อง', 400);
    }
    assertEnum(organizationType, ORGANIZATION_TYPES, 'INVALID_ORGANIZATION_TYPE', 'ประเภทองค์กร');
    const record = await repository.createOrganization({
      organizationId: idFactory('ORG'), organizationCode: code,
      displayName: requiredText(displayName, { code: 'ORGANIZATION_NAME_REQUIRED', label: 'ชื่อองค์กร', max: 240 }),
      organizationType, status: 'active',
    });
    await audit('organization.created', actorReference, { organizationId: record.organization_id });
    return organizationProjection(record);
  }

  async function listOrganizations() {
    return (await repository.listOrganizations()).map(organizationProjection);
  }

  async function getOperationsFoundation(input = {}) {
    const limit = Math.min(200, Math.max(1, Number.parseInt(input.limit, 10) || 200));
    const centerLimit = Math.min(500, Math.max(1, Number.parseInt(input.centerLimit, 10) || 500));
    const includeCapabilities = input.includeCapabilities === true || input.includeCapabilities === '1';
    const result = await repository.listOperationsFoundation({ limit, centerLimit, includeCapabilities });
    const organizations = (result.organizations || []).map(organizationProjection);
    const centers = (result.centers || []).map((row) => {
      const values = new Map((row.capabilities || []).map((item) => [item.capability_key,item]));
      return {
        centerId:row.center_id, organizationId:row.organization_id,
        name:row.center_name || null, status:row.center_status || null, linkedAt:row.linked_at || null,
        ...(includeCapabilities ? { capabilities:CAPABILITY_KEYS.map((key) => ({
          centerId:row.center_id, capabilityKey:key, enabled:Boolean(values.get(key)?.enabled),
          enabledAt:values.get(key)?.enabled_at || null, updatedAt:values.get(key)?.updated_at || null,
        })) } : {}),
      };
    });
    const organizationTotal = Math.max(organizations.length, Number(result.organizationTotal ?? result.organization_total) || 0);
    const centerTotal = Math.max(centers.length, Number(result.centerTotal ?? result.center_total) || 0);
    return { organizations, centers, bounded:{ organizationLimit:limit, centerLimit,
      organizationsTruncated:organizationTotal>organizations.length, centersTruncated:centerTotal>centers.length } };
  }

  async function getOrganizationForCenter(centerId) {
    await requireCenter(centerId);
    return organizationProjection(await repository.findOrganizationForCenter(centerId));
  }

  async function ensureOrganizationForCenter({ centerId, displayName, actorReference = 'system:center-create' }) {
    await requireCenter(centerId);
    return runTransaction(`platform-center:${centerId}`, async () => {
      const existing = await repository.findOrganizationForCenter(centerId);
      if (existing) return organizationProjection(existing);
      const organization = await repository.createOrganization({
        organizationId: idFactory('ORG'),
        organizationCode: `center-${crypto.createHash('sha256').update(centerId).digest('hex').slice(0, 24)}`,
        displayName: requiredText(displayName, { code: 'ORGANIZATION_NAME_REQUIRED', label: 'ชื่อองค์กร', max: 240 }),
        organizationType: 'external_care_center', status: 'active',
      });
      const linked = await repository.linkCenter({ organizationId: organization.organization_id, centerId, actorReference });
      if (!linked) {
        const raced = await repository.findOrganizationForCenter(centerId);
        if (raced) return organizationProjection(raced);
        throw new PlatformError('CENTER_ORGANIZATION_LINK_FAILED', 'เชื่อมศูนย์กับองค์กรไม่สำเร็จ', 409);
      }
      await audit('organization.created', actorReference, { organizationId: organization.organization_id, centerId });
      await audit('organization.center_linked', actorReference, { organizationId: organization.organization_id, centerId });
      return organizationProjection(organization);
    });
  }

  async function listOrganizationCenters(organizationId) {
    await requireOrganization(organizationId, { active: false });
    const links = await repository.listOrganizationCenters(organizationId);
    const rows = [];
    for (const link of links) {
      const center = await centers.findOne((item) => item.center_id === link.center_id);
      rows.push({ centerId: link.center_id, name: center?.name || null, status: center?.status || null, linkedAt: link.linked_at });
    }
    return rows;
  }

  async function relinkCenter({ centerId, organizationId, actorReference }) {
    await requireCenter(centerId);
    await requireOrganization(organizationId);
    return runTransaction(`platform-center:${centerId}`, async () => {
      const current = await repository.findOrganizationForCenter(centerId);
      if (!current) throw new PlatformError('CENTER_ORGANIZATION_NOT_FOUND', 'ศูนย์ยังไม่มีองค์กร', 409);
      if (current.organization_id === organizationId) return organizationProjection(current);
      if (await repository.countCenterIntegrationDependencies(centerId)) {
        throw new PlatformError('CENTER_HAS_INTEGRATION_DEPENDENCIES', 'ต้องถอด integration scope และ mapping ก่อนย้ายองค์กร', 409);
      }
      const updated = await repository.relinkCenter({ organizationId, centerId, actorReference: safeActorReference(actorReference) });
      await audit('organization.center_relinked', actorReference, { organizationId, centerId }, {
        previousOrganizationId: current.organization_id,
      });
      return organizationProjection({ ...updated, ...(await repository.findOrganization(organizationId)) });
    });
  }

  async function listCenterCapabilities(centerId) {
    await requireCenter(centerId);
    const organization = await repository.findOrganizationForCenter(centerId);
    if (!organization) throw new PlatformError('CENTER_ORGANIZATION_NOT_FOUND', 'ศูนย์ยังไม่มีองค์กร', 409);
    const rows = await repository.listCapabilities(centerId);
    const byKey = new Map(rows.map((row) => [row.capability_key, row]));
    return CAPABILITY_KEYS.map((key) => ({
      centerId, capabilityKey: key, enabled: Boolean(byKey.get(key)?.enabled),
      enabledAt: byKey.get(key)?.enabled_at || null,
      updatedAt: byKey.get(key)?.updated_at || null,
    }));
  }

  async function listCenterResidentOptions(centerId, { search = null, limit = 100 } = {}) {
    await requireCenter(centerId);
    const organization = await repository.findOrganizationForCenter(centerId);
    if (!organization) throw new PlatformError('CENTER_ORGANIZATION_NOT_FOUND', 'ศูนย์ยังไม่มีองค์กร', 409);
    const needle = optionalText(search, 120)?.toLocaleLowerCase('th-TH') || '';
    const bounded = Math.min(100, Math.max(1, Number(limit) || 100));
    const rows = await residents.findWhere((row) => row.center_id === centerId && row.status === 'active');
    return rows
      .filter((row) => !needle || [row.full_name, row.room, row.resident_id]
        .some((value) => String(value || '').toLocaleLowerCase('th-TH').includes(needle)))
      .sort((left, right) => String(left.full_name || '').localeCompare(String(right.full_name || ''), 'th'))
      .slice(0, bounded)
      .map((row) => ({
        residentId: row.resident_id,
        displayName: optionalText(row.full_name, 240) || 'ไม่ระบุชื่อ',
        room: optionalText(row.room, 80),
        careProfileLinked: Boolean(row.care_profile_id),
      }));
  }

  async function isCenterCapabilityEnabled(centerId, capabilityKey) {
    assertCapabilityKey(capabilityKey);
    const row = await repository.findCapability(centerId, capabilityKey);
    return Boolean(row?.enabled);
  }

  async function setCenterCapability({ centerId, capabilityKey, enabled, actorReference }) {
    return runTransaction(`platform-center:${centerId}`, async () => {
      assertCapabilityKey(capabilityKey);
      if (typeof enabled !== 'boolean') throw new PlatformError('INVALID_CAPABILITY_STATE', 'enabled ต้องเป็น boolean', 400);
      await requireCenter(centerId);
      const organization = await repository.findOrganizationForCenter(centerId);
      if (!organization) throw new PlatformError('CENTER_ORGANIZATION_NOT_FOUND', 'ศูนย์ยังไม่มีองค์กร', 409);
      const row = await repository.upsertCapability({
        centerId, capabilityKey, enabled, actorReference: safeActorReference(actorReference),
      });
      await audit('center.capability_changed', actorReference, {
        organizationId: organization.organization_id, centerId,
      }, { capabilityKey, enabled });
      return { centerId, capabilityKey, enabled: Boolean(row.enabled), enabledAt: row.enabled_at || null, updatedAt: row.updated_at };
    });
  }

  async function createIntegrationClient({ organizationId, clientCode, displayName, sourceSystem, initialStatus = 'active', actorReference }) {
    const organization = await requireOrganization(organizationId);
    if (organization.organization_type !== 'external_care_center') {
      throw new PlatformError('INTERNAL_ORGANIZATION_NOT_EXTERNAL_CLIENT', 'องค์กรภายในไม่ใช่ external integration tenant', 409);
    }
    const code = requiredText(clientCode, { code: 'CLIENT_CODE_REQUIRED', label: 'client code', max: 100 }).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{2,99}$/.test(code)) throw new PlatformError('INVALID_CLIENT_CODE', 'client code ไม่ถูกต้อง', 400);
    assertEnum(initialStatus, ['active', 'suspended'], 'INVALID_INITIAL_CLIENT_STATUS', 'สถานะเริ่มต้น');
    const name = requiredText(displayName, { code: 'CLIENT_NAME_REQUIRED', label: 'ชื่อ Integration Client', max: 240 });
    const source = requiredText(sourceSystem, { code: 'SOURCE_SYSTEM_REQUIRED', label: 'source system', max: 100 });
    return runTransaction(`integration-client-code:${code}`, async () => {
      try {
        const client = await repository.createIntegrationClient({
          integrationClientId: idFactory('INTC'), organizationId, clientCode: code,
          displayName: name, sourceSystem: source, status: initialStatus,
        });
        await audit('integration.client_created', actorReference, { organizationId, integrationClientId: client.integration_client_id }, { clientCode: code });
        return clientProjection(client);
      } catch (error) {
        if (error?.code === '23505') throw new PlatformError('CLIENT_CODE_EXISTS', 'client code นี้ถูกใช้งานแล้ว', 409);
        throw error;
      }
    });
  }

  async function inspectIntegrationClient(integrationClientId) {
    const client = await requireClient(integrationClientId, { active: false });
    const organization = await requireOrganization(client.organization_id, { active: false });
    const centerScopes = await repository.listClientCenterScopes(integrationClientId);
    const centersWithNames = [];
    for (const scope of centerScopes) {
      const center = await centers.findOne((row) => row.center_id === scope.center_id);
      centersWithNames.push({
        centerId: scope.center_id, name: center?.name || null, status: center?.status || null,
        createdAt: scope.created_at,
      });
    }
    const eventScopes = (await repository.listClientEventScopes(integrationClientId)).map((row) => row.event_type);
    const credentials = (await repository.listCredentials(integrationClientId)).map(credentialProjection);
    const activeCredentials = credentials.filter((item) => item.status === 'active'
      && (!item.expiresAt || new Date(item.expiresAt).getTime() > now().getTime()));
    const [centerMappingCount, activeCenterMappingCount, subjectMappingCount, mappedSubjectCount, identityResolutionPolicy,
      operationalCounts] = await Promise.all([
      repository.countExternalCenterMappings({ integrationClientId }),
      repository.countExternalCenterMappings({ integrationClientId, status:'active' }),
      repository.countExternalSubjectMappings({ integrationClientId }),
      repository.countExternalSubjectMappings({ integrationClientId, status:'mapped' }),
      identityPolicies.getPolicy(integrationClientId),
      identityPolicies.getMetrics(integrationClientId),
    ]);
    const checks = {
      organization: organization.status === 'active', centerScope: centerScopes.length > 0,
      eventScope: eventScopes.length > 0, activeCredential: activeCredentials.length > 0,
      externalCenterMapping: activeCenterMappingCount > 0,
      externalResidentMapping: mappedSubjectCount > 0,
      clientActive: client.status === 'active',
    };
    const mappingBootstrapReady = identityResolutionPolicy.identityResolutionMode === 'exact_name_learning'
      || checks.externalCenterMapping;
    const configurationComplete = checks.organization && checks.centerScope && checks.eventScope
      && checks.activeCredential && mappingBootstrapReady;
    const readinessState = client.status === 'revoked' ? 'revoked'
      : client.status === 'suspended' ? 'suspended'
        : configurationComplete ? 'ready' : 'incomplete';
    return {
      ...clientProjection(client),
      organization: organizationProjection(organization), centers: centersWithNames,
      eventScopes, credentials,
      mappingCounts: {
        centers: centerMappingCount, activeCenters: activeCenterMappingCount,
        residents: subjectMappingCount, mappedResidents: mappedSubjectCount,
      },
      identityResolutionPolicy,
      operationalCounts,
      activeCredentialCount: activeCredentials.length,
      lastUsedAt: credentials.map((item) => item.lastUsedAt).filter(Boolean).sort().at(-1) || null,
      readiness: {
        state: readinessState,
        label: readinessState === 'ready' ? 'พร้อมรับข้อมูล'
          : readinessState === 'suspended' ? 'ระงับการใช้งาน'
            : readinessState === 'revoked' ? 'เพิกถอนแล้ว' : 'ตั้งค่ายังไม่ครบ',
        configurationComplete, checks,
        residentMappingRecommended: identityResolutionPolicy.identityResolutionMode === 'manual_mapping_only'
          && !checks.externalResidentMapping,
      },
    };
  }

  async function setIdentityResolutionPolicy({ integrationClientId, policy, actorReference }) {
    return runTransaction(`integration-client-control:${integrationClientId}`, async () => {
      const client = await requireConfigurableClient(integrationClientId);
      const normalized = assertPolicy(policy);
      const result = await identityPolicies.setPolicy({ integrationClientId, policy:normalized, actorReference });
      await audit('integration.identity_policy_changed', actorReference, {
        organizationId:client.organization_id, integrationClientId,
      }, { identityResolutionMode:normalized.identityResolutionMode,
        unresolvedEventPolicy:normalized.unresolvedEventPolicy,
        familyGroupRequirement:normalized.familyGroupRequirement });
      return result;
    });
  }

  async function listIntegrationClients(organizationId) {
    await requireOrganization(organizationId, { active: false });
    return (await repository.listIntegrationClients(organizationId)).map(clientProjection);
  }

  function normalizeIntegrationDirectoryQuery(input = {}) {
    const search = String(input.search || '').trim().normalize('NFC');
    if (search.length > 120) throw new PlatformError('INVALID_INTEGRATION_SEARCH', 'คำค้นหาต้องไม่เกิน 120 ตัวอักษร', 400);
    const status = String(input.status || '').trim();
    if (status && !INTEGRATION_CLIENT_STATUSES.includes(status)) {
      throw new PlatformError('INVALID_CLIENT_STATUS_FILTER', 'ตัวกรองสถานะ Integration Client ไม่ถูกต้อง', 400);
    }
    const view = String(input.view || '').trim();
    if (view && !['current', 'archived'].includes(view)) {
      throw new PlatformError('INVALID_INTEGRATION_DIRECTORY_VIEW', 'มุมมองรายการระบบเชื่อมต่อไม่ถูกต้อง', 400);
    }
    if (view === 'current' && status === 'revoked') {
      throw new PlatformError('INVALID_INTEGRATION_DIRECTORY_FILTER', 'รายการปัจจุบันไม่รวมระบบเชื่อมต่อที่เพิกถอนแล้ว', 400);
    }
    if (view === 'archived' && status && status !== 'revoked') {
      throw new PlatformError('INVALID_INTEGRATION_DIRECTORY_FILTER', 'ประวัติการเชื่อมต่อแสดงเฉพาะระบบที่เพิกถอนแล้ว', 400);
    }
    const page = Math.max(1, Number(input.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 20));
    return { search, status:status || null, view:view || null, page, limit, offset:(page - 1) * limit };
  }

  function integrationDirectoryProjection(row) {
    const counts = {
      centers:Number(row.allowed_center_count) || 0,
      events:Number(row.allowed_event_count) || 0,
      activeCredentials:Number(row.active_credential_count) || 0,
      activeCenterMappings:Number(row.active_center_mapping_count) || 0,
      mappedSubjects:Number(row.mapped_subject_count) || 0,
      warnings:Number(row.warning_count) || 0,
    };
    const mappingReady = row.identity_resolution_mode === 'exact_name_learning' || counts.activeCenterMappings > 0;
    const configurationComplete = row.organization_status === 'active' && counts.centers > 0
      && counts.events > 0 && counts.activeCredentials > 0 && mappingReady;
    const readinessState = row.status === 'revoked' ? 'revoked' : row.status === 'suspended' ? 'suspended'
      : configurationComplete ? 'ready' : 'incomplete';
    return {
      integrationClientId:row.integration_client_id,
      organizationId:row.organization_id,
      organizationName:row.organization_name,
      displayName:row.display_name,
      clientCode:row.client_code,
      sourceSystem:row.source_system,
      status:row.status,
      allowedCenterCount:counts.centers,
      allowedEventCount:counts.events,
      activeCredentialCount:counts.activeCredentials,
      mappingReadiness:{ activeCenters:counts.activeCenterMappings, mappedResidents:counts.mappedSubjects,
        state:mappingReady ? 'ready' : 'not_ready' },
      lastUsedAt:row.last_used_at || null,
      revokedAt:row.revoked_at || null,
      warningCount:counts.warnings,
      readiness:{ state:readinessState, configurationComplete,
        label:readinessState === 'ready' ? 'พร้อมรับข้อมูล' : readinessState === 'suspended' ? 'ระงับการใช้งาน'
          : readinessState === 'revoked' ? 'เพิกถอนแล้ว' : 'ตั้งค่ายังไม่ครบ' },
    };
  }

  async function listIntegrationClientDirectory(input = {}) {
    const query = normalizeIntegrationDirectoryQuery(input);
    const [rows, total] = await Promise.all([
      repository.listIntegrationClientDirectory(query),
      repository.countIntegrationClientDirectory(query),
    ]);
    return { items:rows.map(integrationDirectoryProjection),
      pagination:{ page:query.page, limit:query.limit, total, totalPages:Math.ceil(total / query.limit) } };
  }

  async function setIntegrationClientStatus({ integrationClientId, status, actorReference }) {
    assertEnum(status, ['active', 'suspended'], 'INVALID_CLIENT_STATUS_TRANSITION', 'สถานะ Integration Client');
    return runTransaction(`integration-client-control:${integrationClientId}`, async () => {
      const client = await requireClient(integrationClientId, { active: false });
      if (client.status === 'revoked') {
        throw new PlatformError('REVOKED_CLIENT_TERMINAL', 'Integration Client ที่เพิกถอนแล้วไม่สามารถเปิดใช้งานใหม่ได้', 409);
      }
      if (status === 'active') {
        await requireOrganization(client.organization_id);
        const readiness = await inspectIntegrationClient(integrationClientId);
        if (!readiness.readiness.configurationComplete) {
          throw new PlatformError('INTEGRATION_CLIENT_NOT_READY', 'ตั้งค่าระบบเชื่อมต่อยังไม่ครบ กรุณาตรวจ Organization, Center scope, Event scope, Credential และการเชื่อมรหัส', 409);
        }
      }
      if (client.status === status) return clientProjection(client);
      const updated = await repository.updateIntegrationClientStatus(integrationClientId, status);
      await audit('integration.client_status_changed', actorReference, {
        organizationId: client.organization_id, integrationClientId,
      }, { clientCode: client.client_code, clientStatus: status });
      return clientProjection(updated);
    });
  }

  async function revokeIntegrationClient({ integrationClientId, actorReference }) {
    return runTransaction(`integration-client-control:${integrationClientId}`, async () => {
      const client = await requireClient(integrationClientId, { active: false });
      if (client.status === 'revoked') return clientProjection(client);
      const updated = await repository.updateIntegrationClientStatus(integrationClientId, 'revoked');
      for (const credential of await repository.listCredentials(integrationClientId)) {
        if (credential.status === 'active') await repository.revokeCredential(credential.credential_id);
      }
      await audit('integration.client_revoked', actorReference, {
        organizationId: client.organization_id, integrationClientId,
      }, { previousStatus:client.status, revokedAt:updated.revoked_at });
      return clientProjection(updated);
    });
  }

  async function addClientCenterScope({ integrationClientId, centerId, actorReference }) {
    return runTransaction(`integration-client-control:${integrationClientId}`, async () => {
      const client = await requireConfigurableClient(integrationClientId);
      await requireCenter(centerId);
      const organization = await repository.findOrganizationForCenter(centerId);
      if (!organization || organization.organization_id !== client.organization_id) {
        throw new PlatformError('CROSS_TENANT_CENTER', 'ไม่สามารถเพิ่มศูนย์ต่างองค์กรได้', 403);
      }
      await repository.addClientCenterScope({ integrationClientId, organizationId: client.organization_id, centerId, actorReference: safeActorReference(actorReference) });
      await audit('integration.center_scope_added', actorReference, {
        organizationId: client.organization_id, centerId, integrationClientId,
      });
      return { integrationClientId, centerId, allowed: true };
    });
  }

  async function removeClientCenterScope({ integrationClientId, centerId, actorReference }) {
    return runTransaction(`integration-client-control:${integrationClientId}`, async () => {
      const client = await requireConfigurableClient(integrationClientId);
      const mappingDependencies = await repository.findActiveExternalCenterMappingByCenter(integrationClientId, centerId);
      if (mappingDependencies?.status === 'active') {
        throw new PlatformError('CENTER_SCOPE_HAS_MAPPING', 'ต้องปิด external Center mapping ก่อน', 409);
      }
      await repository.removeClientCenterScope(integrationClientId, centerId);
      await audit('integration.center_scope_removed', actorReference, {
        organizationId: client.organization_id, centerId, integrationClientId,
      });
      return { integrationClientId, centerId, allowed: false };
    });
  }

  async function addClientEventScope({ integrationClientId, eventType, actorReference }) {
    return runTransaction(`integration-client-control:${integrationClientId}`, async () => {
      assertEventType(eventType);
      const client = await requireConfigurableClient(integrationClientId);
      await repository.addClientEventScope({ integrationClientId, eventType, actorReference: safeActorReference(actorReference) });
      await audit('integration.event_scope_added', actorReference, {
        organizationId: client.organization_id, integrationClientId,
      }, { eventType });
      return { integrationClientId, eventType, allowed: true };
    });
  }

  async function removeClientEventScope({ integrationClientId, eventType, actorReference }) {
    return runTransaction(`integration-client-control:${integrationClientId}`, async () => {
      assertEventType(eventType);
      const client = await requireConfigurableClient(integrationClientId);
      await repository.removeClientEventScope(integrationClientId, eventType);
      await audit('integration.event_scope_removed', actorReference, {
        organizationId: client.organization_id, integrationClientId,
      }, { eventType });
      return { integrationClientId, eventType, allowed: false };
    });
  }

  function buildCredentialSecret() {
    const publicPrefix = randomBytes(8).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const salt = randomBytes(16);
    const hash = crypto.scryptSync(secret, salt, 32);
    return { publicPrefix, secret, salt, hash, token: `pim_int_${publicPrefix}.${secret}` };
  }

  async function createCredentialRecord({ client, actorReference, rotatedFromCredentialId = null, expiresAt = null }) {
    const material = buildCredentialSecret();
    const credential = await repository.createCredential({
      credentialId: idFactory('INTK'), integrationClientId: client.integration_client_id,
      publicPrefix: material.publicPrefix, secretSalt: material.salt,
      secretHash: material.hash, expiresAt, rotatedFromCredentialId,
    });
    await audit(rotatedFromCredentialId ? 'integration.credential_rotated' : 'integration.credential_issued', actorReference, {
      organizationId: client.organization_id, integrationClientId: client.integration_client_id,
    }, { credentialId: credential.credential_id });
    return { credential: credentialProjection(credential), token: material.token };
  }

  async function issueCredential({ integrationClientId, actorReference }) {
    const client = await requireConfigurableClient(integrationClientId);
    return runTransaction(`integration-client-control:${integrationClientId}`, async () => {
      if ((await repository.listActiveCredentials(integrationClientId)).length) {
        throw new PlatformError('ACTIVE_CREDENTIAL_EXISTS', 'มี credential ที่ใช้งานอยู่แล้ว กรุณาใช้การหมุนกุญแจ', 409);
      }
      return createCredentialRecord({ client, actorReference });
    });
  }

  async function rotateCredential({ integrationClientId, credentialId, overlapSeconds = 0, actorReference }) {
    const client = await requireConfigurableClient(integrationClientId);
    const current = await repository.findCredential(credentialId);
    if (!current || current.integration_client_id !== integrationClientId || current.status !== 'active') {
      throw new PlatformError('ACTIVE_CREDENTIAL_NOT_FOUND', 'ไม่พบ credential ที่ใช้งานอยู่', 404);
    }
    const overlap = Number(overlapSeconds || 0);
    if (!Number.isInteger(overlap) || overlap < 0 || overlap > MAX_ROTATION_OVERLAP_SECONDS) {
      throw new PlatformError('INVALID_ROTATION_OVERLAP', 'ช่วง overlap ไม่ถูกต้อง', 400);
    }
    return runTransaction(`integration-client-control:${integrationClientId}`, async () => {
      const active = await repository.listActiveCredentials(integrationClientId);
      if (active.length !== 1 || active[0].credential_id !== credentialId) {
        throw new PlatformError('CREDENTIAL_ROTATION_IN_PROGRESS', 'มี credential overlap อยู่ ต้องสิ้นสุดหรือเพิกถอนก่อนหมุนอีกครั้ง', 409);
      }
      const replacement = await createCredentialRecord({ client, actorReference, rotatedFromCredentialId: credentialId });
      if (overlap > 0) {
        await repository.expireCredentialAt(credentialId, new Date(now().getTime() + overlap * 1000).toISOString());
      } else {
        await repository.revokeCredential(credentialId);
      }
      await audit('integration.credential_rotation_completed', actorReference, {
        organizationId: client.organization_id, integrationClientId,
      }, { credentialId, overlapSeconds: overlap });
      return replacement;
    });
  }

  async function revokeCredential({ integrationClientId, credentialId, actorReference }) {
    const client = await requireConfigurableClient(integrationClientId);
    return runTransaction(`integration-client-control:${integrationClientId}`, async () => {
      const credential = await repository.findCredential(credentialId);
      if (!credential || credential.integration_client_id !== integrationClientId) {
        throw new PlatformError('CREDENTIAL_NOT_FOUND', 'ไม่พบ credential', 404);
      }
      const revoked = await repository.revokeCredential(credentialId);
      if (revoked) {
        await audit('integration.credential_revoked', actorReference, {
          organizationId: client.organization_id, integrationClientId,
        }, { credentialId });
      }
      return credentialProjection(revoked || credential);
    });
  }

  async function authenticateCredential(token) {
    const match = TOKEN_PATTERN.exec(String(token || ''));
    if (!match) throw new PlatformError('INVALID_INTEGRATION_TOKEN', 'Integration credential ไม่ถูกต้อง', 401);
    const candidate = await repository.findCredentialByPrefix(match[1]);
    if (!candidate) throw new PlatformError('INTEGRATION_CREDENTIAL_REVOKED', 'Integration credential ไม่พร้อมใช้งาน', 401);
    return runTransaction(`integration-client-control:${candidate.integration_client_id}`, async () => {
      const row = await repository.findCredentialByPrefix(match[1]);
      if (!row || row.status !== 'active' || row.client_status !== 'active' || row.organization_status !== 'active') {
        throw new PlatformError('INTEGRATION_CREDENTIAL_REVOKED', 'Integration credential ไม่พร้อมใช้งาน', 401);
      }
      if (row.expires_at && new Date(row.expires_at).getTime() <= now().getTime()) {
        throw new PlatformError('INTEGRATION_CREDENTIAL_EXPIRED', 'Integration credential หมดอายุ', 401);
      }
      const actual = crypto.scryptSync(match[2], Buffer.from(row.secret_salt), Buffer.from(row.secret_hash).length);
      const expected = Buffer.from(row.secret_hash);
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        throw new PlatformError('INVALID_INTEGRATION_TOKEN', 'Integration credential ไม่ถูกต้อง', 401);
      }
      await repository.touchCredential(row.credential_id);
      return {
        credentialId: row.credential_id,
        integrationClientId: row.integration_client_id,
        organizationId: row.organization_id,
        clientCode: row.client_code,
        sourceSystem: row.source_system,
      };
    });
  }

  async function assertIntegrationIdentityActive(identity) {
    const client = await requireClient(identity?.integrationClientId);
    if (client.organization_id !== identity?.organizationId) {
      throw new PlatformError('INVALID_INTEGRATION_IDENTITY', 'Integration identity ไม่ถูกต้อง', 401);
    }
    return true;
  }

  async function mapExternalCenter({ integrationClientId, externalCenterId, centerId, displayName, actorReference }) {
    const client = await requireConfigurableClient(integrationClientId);
    await requireCenter(centerId);
    const organization = await repository.findOrganizationForCenter(centerId);
    if (!organization || organization.organization_id !== client.organization_id) {
      throw new PlatformError('CROSS_TENANT_CENTER_MAPPING', 'ไม่สามารถ map ศูนย์ต่างองค์กรได้', 403);
    }
    if (!(await repository.hasClientCenterScope(integrationClientId, centerId))) {
      throw new PlatformError('CENTER_SCOPE_DENIED', 'Integration Client ไม่มีสิทธิ์ใช้ศูนย์นี้', 403);
    }
    const externalId = requiredText(externalCenterId, { code: 'EXTERNAL_CENTER_REQUIRED', label: 'external Center ID', max: 160 });
    return runTransaction(`integration-center-mapping:${integrationClientId}:${externalId}`, async () => {
      const existing = await repository.findExternalCenterMapping(integrationClientId, externalId);
      if (existing?.status === 'active' && existing.center_id !== centerId) {
        throw new PlatformError('EXTERNAL_CENTER_MAPPING_CONFLICT', 'รหัสภายนอกนี้ถูกเชื่อมอยู่แล้ว', 409);
      }
      const mapping = await repository.upsertExternalCenterMapping({
        mappingId: existing?.external_center_mapping_id || idFactory('ECM'),
        integrationClientId, organizationId: client.organization_id, externalCenterId: externalId,
        centerId, displayName: optionalText(displayName, 240),
      });
      if (!existing || existing.status !== 'active') {
        await audit('integration.external_center_mapping_created', actorReference, {
          organizationId: client.organization_id, centerId, integrationClientId,
        }, { externalCenterId: externalId });
      }
      await identityPolicies.recordMappingOrigin({ integrationClientId, externalCenterId:externalId,
        source:'configured_manually' });
      return mapping;
    });
  }

  async function deactivateExternalCenterMapping({ integrationClientId, externalCenterId, actorReference }) {
    const client = await requireConfigurableClient(integrationClientId);
    const externalId = requiredText(externalCenterId, { code:'EXTERNAL_CENTER_REQUIRED', label:'external Center ID', max:160 });
    return runTransaction(`integration-center-mapping:${integrationClientId}:${externalId}`, async () => {
      const mapping = await repository.deactivateExternalCenterMapping(integrationClientId, externalId);
      if (!mapping) throw new PlatformError('EXTERNAL_CENTER_MAPPING_NOT_FOUND', 'ไม่พบ external Center mapping', 404);
      await audit('integration.external_center_mapping_deactivated', actorReference, {
        organizationId: client.organization_id, centerId: mapping.center_id, integrationClientId,
      }, { externalCenterId:externalId });
      return mapping;
    });
  }

  async function listExternalCenterMappings(integrationClientId, { status = null, search = null, page = 1, limit = 50 } = {}) {
    const client = await requireClient(integrationClientId, { active: false });
    if (status !== null && status !== '') assertEnum(status, ['active', 'inactive'], 'INVALID_CENTER_MAPPING_STATUS', 'สถานะการเชื่อมรหัสศูนย์');
    const needle = optionalText(search, 120);
    const paging = paginationInput({ page, limit });
    const query = { integrationClientId, status:status || null, search:needle, limit:paging.limit, offset:paging.offset };
    const [rows, total] = await Promise.all([
      repository.listExternalCenterMappings(query), repository.countExternalCenterMappings(query),
    ]);
    const items = [];
    for (const row of rows) {
      if (row.organization_id !== client.organization_id) continue;
      const center = await centers.findOne((item) => item.center_id === row.center_id);
      row.mapping_source = await identityPolicies.getMappingOrigin({ integrationClientId,
        externalCenterId:row.external_center_id });
      items.push(externalCenterMappingProjection(row, center));
    }
    return { items, pagination:{ page:paging.page, limit:paging.limit, total,
      totalPages:total ? Math.ceil(total / paging.limit) : 0 } };
  }

  async function mapExternalSubject({
    integrationClientId, externalCenterId, externalResidentId, residentId = null,
    firstName, lastName, displayName, room, actorReference,
  }) {
    const client = await requireConfigurableClient(integrationClientId);
    const extCenterId = requiredText(externalCenterId, {
      code: 'EXTERNAL_CENTER_REQUIRED', label: 'external Center ID', max: 160,
    });
    const centerMapping = await repository.findExternalCenterMapping(integrationClientId, extCenterId);
    if (!centerMapping || centerMapping.status !== 'active') {
      throw new PlatformError('EXTERNAL_CENTER_MAPPING_NOT_FOUND', 'ไม่พบ external Center mapping ที่ใช้งานได้', 404);
    }
    if (centerMapping.organization_id !== client.organization_id) {
      throw new PlatformError('CROSS_TENANT_SUBJECT_MAPPING', 'mapping ข้ามองค์กรไม่ได้', 403);
    }
    let resident = null;
    if (residentId) {
      resident = await residents.findOne((row) => row.resident_id === residentId
        && row.center_id === centerMapping.center_id && row.status === 'active');
      if (!resident) throw new PlatformError('RESIDENT_NOT_IN_MAPPED_CENTER', 'ผู้พักไม่ได้อยู่ในศูนย์ที่ map ไว้', 403);
      if (!resident.care_profile_id) {
        throw new PlatformError('RESIDENT_CARE_PROFILE_NOT_READY', 'ผู้พักยังไม่มี Care Profile ที่พร้อมเชื่อม', 409);
      }
    }
    const extResidentId = requiredText(externalResidentId, { code: 'EXTERNAL_RESIDENT_REQUIRED', label: 'external Resident ID', max: 160 });
    return runTransaction(`integration-subject-mapping:${integrationClientId}:${extCenterId}:${extResidentId}`, async () => {
      const existing = await repository.findExternalSubjectMapping(integrationClientId, extCenterId, extResidentId);
      if (existing?.mapping_status === 'mapped' && resident && existing.resident_id !== resident.resident_id) {
        throw new PlatformError('EXTERNAL_SUBJECT_MAPPING_CONFLICT', 'รหัสภายนอกนี้ถูกเชื่อมอยู่แล้ว', 409);
      }
      const mappingStatus = resident ? 'mapped' : 'pending_subject_mapping';
      const mapping = await repository.upsertExternalSubjectMapping({
        mappingId: existing?.external_subject_mapping_id || idFactory('ESM'),
        integrationClientId, organizationId: client.organization_id,
        externalCenterId:extCenterId, externalResidentId: extResidentId, centerId: centerMapping.center_id,
        residentId: resident?.resident_id || null, careProfileId: resident?.care_profile_id || null,
        mappingStatus, firstName: optionalText(firstName, 120), lastName: optionalText(lastName, 120),
        displayName: optionalText(displayName, 240), room: optionalText(room, 80),
        lastSeenAt: now().toISOString(),
      });
      if (!existing || existing.mapping_status !== mappingStatus) {
        await audit('integration.external_subject_mapping_created', actorReference, {
          organizationId: client.organization_id, centerId: centerMapping.center_id, integrationClientId,
        }, { externalCenterId:extCenterId, externalResidentId: extResidentId, mappingStatus });
      }
      if (resident) {
        await identityPolicies.recordMappingOrigin({ integrationClientId, externalCenterId:extCenterId,
          externalResidentId:extResidentId, source:'configured_manually' });
        await identityPolicies.resolveAlertsForIdentity({ integrationClientId, externalCenterId:extCenterId,
          externalResidentId:extResidentId });
      }
      return mapping;
    });
  }

  async function learnExternalIdentity({ integrationClientId, externalCenterId, externalResidentId,
    centerId, residentId, careProfileId, firstName, lastName, displayName, room, eventType,
    expectedNameKey }) {
    const client = await requireClient(integrationClientId);
    const extCenterId = requiredText(externalCenterId, { code:'EXTERNAL_CENTER_REQUIRED', label:'external Center ID', max:160 });
    const extResidentId = requiredText(externalResidentId, { code:'EXTERNAL_RESIDENT_REQUIRED', label:'external Resident ID', max:160 });
    return runTransactionLocks([`platform-center:${centerId}`], async () => {
      if (repository.lockIdentityLearningCandidate
        && !(await repository.lockIdentityLearningCandidate({ centerId, residentId, careProfileId }))) {
        throw new PlatformError('RESIDENT_CARE_PROFILE_NOT_READY', 'ผู้พักและ Care Profile ไม่พร้อมเชื่อม', 409);
      }
      const center = await requireCenter(centerId);
      const capabilityKey = INTEGRATION_CAPABILITY_FOR_EVENT[eventType];
      if (center.status !== 'active' || (capabilityKey && !(await isCenterCapabilityEnabled(centerId, capabilityKey)))) {
        throw new PlatformError('CENTER_INACTIVE', 'ศูนย์ไม่พร้อมรับข้อมูล Integration', 409);
      }
      const organization = await repository.findOrganizationForCenter(centerId);
      if (!organization || organization.organization_id !== client.organization_id
        || !(await repository.hasClientCenterScope(integrationClientId, centerId))) {
        throw new PlatformError('CENTER_SCOPE_DENIED', 'Integration Client ไม่มีสิทธิ์ใช้ศูนย์นี้', 403);
      }
      const resident = await residents.findOne((row) => row.resident_id === residentId
        && row.center_id === centerId && row.status === 'active');
      const profile = await CareProfiles.findOne((row) => row.care_profile_id === careProfileId);
      if (!resident || !resident.care_profile_id || resident.care_profile_id !== careProfileId
        || !profile || normalizeIdentityName(profile.patient_name) !== expectedNameKey) {
        throw new PlatformError('RESIDENT_CARE_PROFILE_NOT_READY', 'ผู้พักและ Care Profile ไม่พร้อมเชื่อม', 409);
      }
      const existingCenter = await repository.findExternalCenterMapping(integrationClientId, extCenterId);
      if (existingCenter && (existingCenter.status !== 'active' || existingCenter.center_id !== centerId)) {
        throw new PlatformError('EXTERNAL_CENTER_MAPPING_CONFLICT', 'รหัสศูนย์ภายนอกขัดแย้งกับการเชื่อมเดิม', 409);
      }
      const centerMapping = existingCenter || await repository.upsertExternalCenterMapping({
        mappingId:idFactory('ECM'), integrationClientId, organizationId:client.organization_id,
        externalCenterId:extCenterId, centerId, displayName:null,
      });
      const existingSubject = await repository.findExternalSubjectMapping(integrationClientId, extCenterId, extResidentId);
      if (existingSubject && (existingSubject.mapping_status === 'inactive'
        || (existingSubject.mapping_status === 'mapped' && (existingSubject.resident_id !== residentId
          || existingSubject.care_profile_id !== careProfileId)))) {
        throw new PlatformError('EXTERNAL_SUBJECT_MAPPING_CONFLICT', 'รหัสผู้พักภายนอกขัดแย้งกับการเชื่อมเดิม', 409);
      }
      const subjectMapping = existingSubject?.mapping_status === 'mapped' ? existingSubject
        : await repository.upsertExternalSubjectMapping({
          mappingId:existingSubject?.external_subject_mapping_id || idFactory('ESM'),
          integrationClientId, organizationId:client.organization_id,
          externalCenterId:extCenterId, externalResidentId:extResidentId, centerId,
          residentId, careProfileId, mappingStatus:'mapped',
          firstName:optionalText(firstName,120), lastName:optionalText(lastName,120),
          displayName:optionalText(displayName,240), room:optionalText(room,80), lastSeenAt:now().toISOString(),
        });
      if (!existingCenter) await identityPolicies.recordMappingOrigin({ integrationClientId,
        externalCenterId:extCenterId, source:'learned_automatically' });
      if (!existingSubject || existingSubject.mapping_status !== 'mapped') await identityPolicies.recordMappingOrigin({
        integrationClientId, externalCenterId:extCenterId, externalResidentId:extResidentId,
        source:'learned_automatically',
      });
      await identityPolicies.touchMappingOrigin({ integrationClientId, externalCenterId:extCenterId });
      await identityPolicies.touchMappingOrigin({ integrationClientId, externalCenterId:extCenterId,
        externalResidentId:extResidentId });
      await identityPolicies.resolveAlertsForIdentity({ integrationClientId, externalCenterId:extCenterId,
        externalResidentId:extResidentId });
      if (!existingSubject || existingSubject.mapping_status !== 'mapped') await audit(
        'integration.external_subject_mapping_learned', 'system:integration_identity_learning', {
          organizationId:client.organization_id, centerId, integrationClientId,
        }, { externalCenterId:extCenterId, externalResidentId:extResidentId,
          mappingStatus:'mapped', mappingSource:'learned_automatically' }
      );
      return { centerMapping, subjectMapping };
    });
  }

  async function observeExternalSubject({
    integrationClientId, externalCenterId, externalResidentId,
    firstName, lastName, displayName, room,
  }) {
    const client = await requireClient(integrationClientId);
    const centerMapping = await repository.findExternalCenterMapping(integrationClientId, requiredText(externalCenterId, {
      code: 'EXTERNAL_CENTER_REQUIRED', label: 'external Center ID', max: 160,
    }));
    if (!centerMapping || centerMapping.status !== 'active' || centerMapping.organization_id !== client.organization_id) {
      throw new PlatformError('EXTERNAL_CENTER_MAPPING_NOT_FOUND', 'ไม่พบ external Center mapping ที่ใช้งานได้', 404);
    }
    const externalId = requiredText(externalResidentId, {
      code: 'EXTERNAL_RESIDENT_REQUIRED', label: 'external Resident ID', max: 160,
    });
    const existing = await repository.findExternalSubjectMapping(integrationClientId, externalCenterId, externalId);
    const mapping = await repository.upsertExternalSubjectMapping({
      mappingId: existing?.external_subject_mapping_id || idFactory('ESM'),
      integrationClientId, organizationId:client.organization_id,
      externalCenterId, externalResidentId:externalId, centerId:centerMapping.center_id,
      residentId:existing?.mapping_status === 'mapped' ? existing.resident_id : null,
      careProfileId:existing?.mapping_status === 'mapped' ? existing.care_profile_id : null,
      mappingStatus:existing?.mapping_status === 'mapped' ? 'mapped' : 'pending_subject_mapping',
      firstName:optionalText(firstName,120) || existing?.first_name || null,
      lastName:optionalText(lastName,120) || existing?.last_name || null,
      displayName:optionalText(displayName,240) || existing?.display_name || null,
      room:optionalText(room,80) || existing?.room || null,
      lastSeenAt:now().toISOString(),
    });
    if (!existing) {
      await audit('integration.external_subject_observed', 'system:integration_ingestion', {
        organizationId:client.organization_id, centerId:centerMapping.center_id, integrationClientId,
      }, { externalCenterId, externalResidentId:externalId, mappingStatus:'pending_subject_mapping' });
    }
    return mapping;
  }

  async function deactivateExternalSubjectMapping({ integrationClientId, externalCenterId, externalResidentId, actorReference }) {
    const client = await requireConfigurableClient(integrationClientId);
    const extCenterId = requiredText(externalCenterId, { code:'EXTERNAL_CENTER_REQUIRED', label:'external Center ID', max:160 });
    const extResidentId = requiredText(externalResidentId, { code:'EXTERNAL_RESIDENT_REQUIRED', label:'external Resident ID', max:160 });
    return runTransaction(`integration-subject-mapping:${integrationClientId}:${extCenterId}:${extResidentId}`, async () => {
      const mapping = await repository.deactivateExternalSubjectMapping(integrationClientId, extCenterId, extResidentId);
      if (!mapping) throw new PlatformError('EXTERNAL_SUBJECT_MAPPING_NOT_FOUND', 'ไม่พบ external subject mapping', 404);
      await audit('integration.external_subject_mapping_deactivated', actorReference, {
        organizationId: client.organization_id, centerId: mapping.center_id, integrationClientId,
      }, { externalCenterId:extCenterId, externalResidentId:extResidentId, mappingStatus: 'inactive' });
      return mapping;
    });
  }

  async function listExternalSubjectMappings(integrationClientId, { status = null, search = null, page = 1, limit = 50 } = {}) {
    const client = await requireClient(integrationClientId, { active: false });
    if (status !== null && status !== '') {
      assertEnum(status, ['mapped', 'pending_subject_mapping', 'inactive'], 'INVALID_SUBJECT_MAPPING_STATUS', 'สถานะการเชื่อมรหัสผู้พัก');
    }
    const needle = optionalText(search, 120);
    const paging = paginationInput({ page, limit });
    const query = { integrationClientId, status:status || null, search:needle, limit:paging.limit, offset:paging.offset };
    const [rows, total] = await Promise.all([
      repository.listExternalSubjectMappings(query), repository.countExternalSubjectMappings(query),
    ]);
    const items = [];
    for (const row of rows) {
      if (row.organization_id !== client.organization_id) continue;
      const [resident, center] = await Promise.all([
        row.resident_id ? residents.findOne((item) => item.resident_id === row.resident_id && item.center_id === row.center_id) : null,
        centers.findOne((item) => item.center_id === row.center_id),
      ]);
      row.mapping_source = await identityPolicies.getMappingOrigin({ integrationClientId,
        externalCenterId:row.external_center_id, externalResidentId:row.external_resident_id });
      items.push(externalSubjectMappingProjection(row, resident, center));
    }
    return { items, pagination:{ page:paging.page, limit:paging.limit, total,
      totalPages:total ? Math.ceil(total / paging.limit) : 0 } };
  }

  async function listIntegrationAlerts(input = {}) {
    if (input.integrationClientId) await requireClient(input.integrationClientId, { active:false });
    return identityPolicies.listAlerts(input);
  }

  async function updateIntegrationAlertStatus({ alertId, status, actorReference }) {
    const alert = await identityPolicies.updateAlertStatus({ alertId, status, actorReference });
    const client = await requireClient(alert.integrationClientId, { active:false });
    await audit('integration.identity_alert_status_changed', actorReference, {
      organizationId:client.organization_id, integrationClientId:client.integration_client_id,
    }, {});
    return alert;
  }

  return {
    createOrganization, listOrganizations, getOperationsFoundation, getOrganizationForCenter,
    ensureOrganizationForCenter, listOrganizationCenters, relinkCenter,
    listCenterCapabilities, listCenterResidentOptions, isCenterCapabilityEnabled, setCenterCapability,
    createIntegrationClient, inspectIntegrationClient, listIntegrationClients, listIntegrationClientDirectory,
    normalizeIntegrationDirectoryQuery, integrationDirectoryProjection, setIdentityResolutionPolicy,
    setIntegrationClientStatus, revokeIntegrationClient, addClientCenterScope, removeClientCenterScope,
    addClientEventScope, removeClientEventScope,
    issueCredential, rotateCredential, revokeCredential, authenticateCredential, assertIntegrationIdentityActive,
    mapExternalCenter, deactivateExternalCenterMapping, listExternalCenterMappings,
    mapExternalSubject, observeExternalSubject, deactivateExternalSubjectMapping, listExternalSubjectMappings,
    learnExternalIdentity,
    listIntegrationAlerts, updateIntegrationAlertStatus,
    identityPolicies,
    repository,
  };
}

const platformService = createPlatformService();

module.exports = { createPlatformService, platformService, credentialProjection, clientProjection,
  organizationProjection, externalCenterMappingProjection, externalSubjectMappingProjection };
