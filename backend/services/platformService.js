const crypto = require('node:crypto');
const {
  Centers, Residents, id, withTransaction,
} = require('../db');
const { createPlatformRepository } = require('./platformRepository');
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

function createPlatformService(overrides = {}) {
  const repository = overrides.repository || createPlatformRepository();
  const centers = overrides.Centers || Centers;
  const residents = overrides.Residents || Residents;
  const idFactory = overrides.idFactory || id;
  const randomBytes = overrides.randomBytes || crypto.randomBytes;
  const runTransaction = overrides.withTransaction || withTransaction;
  const now = overrides.now || (() => new Date());

  async function audit(eventType, actorReference, scope = {}, metadata = {}) {
    const safeMetadata = {};
    for (const key of ['capabilityKey', 'enabled', 'clientCode', 'eventType', 'externalCenterId',
      'externalResidentId', 'mappingStatus', 'previousOrganizationId', 'credentialId', 'overlapSeconds']) {
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

  async function isCenterCapabilityEnabled(centerId, capabilityKey) {
    assertCapabilityKey(capabilityKey);
    const row = await repository.findCapability(centerId, capabilityKey);
    return Boolean(row?.enabled);
  }

  async function setCenterCapability({ centerId, capabilityKey, enabled, actorReference }) {
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
  }

  async function createIntegrationClient({ organizationId, clientCode, displayName, sourceSystem, actorReference }) {
    const organization = await requireOrganization(organizationId);
    if (organization.organization_type !== 'external_care_center') {
      throw new PlatformError('INTERNAL_ORGANIZATION_NOT_EXTERNAL_CLIENT', 'องค์กรภายในไม่ใช่ external integration tenant', 409);
    }
    const code = requiredText(clientCode, { code: 'CLIENT_CODE_REQUIRED', label: 'client code', max: 100 }).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{2,99}$/.test(code)) throw new PlatformError('INVALID_CLIENT_CODE', 'client code ไม่ถูกต้อง', 400);
    const client = await repository.createIntegrationClient({
      integrationClientId: idFactory('INTC'), organizationId, clientCode: code,
      displayName: requiredText(displayName, { code: 'CLIENT_NAME_REQUIRED', label: 'ชื่อ Integration Client', max: 240 }),
      sourceSystem: requiredText(sourceSystem, { code: 'SOURCE_SYSTEM_REQUIRED', label: 'source system', max: 100 }),
    });
    await audit('integration.client_created', actorReference, { organizationId, integrationClientId: client.integration_client_id }, { clientCode: code });
    return clientProjection(client);
  }

  async function inspectIntegrationClient(integrationClientId) {
    const client = await requireClient(integrationClientId, { active: false });
    return {
      ...clientProjection(client),
      centers: await repository.listClientCenterScopes(integrationClientId),
      eventScopes: (await repository.listClientEventScopes(integrationClientId)).map((row) => row.event_type),
      credentials: (await repository.listCredentials(integrationClientId)).map(credentialProjection),
    };
  }

  async function listIntegrationClients(organizationId) {
    await requireOrganization(organizationId, { active: false });
    return (await repository.listIntegrationClients(organizationId)).map(clientProjection);
  }

  async function revokeIntegrationClient({ integrationClientId, actorReference }) {
    const client = await requireClient(integrationClientId, { active: false });
    const updated = await repository.updateIntegrationClientStatus(integrationClientId, 'revoked');
    for (const credential of await repository.listCredentials(integrationClientId)) {
      if (credential.status === 'active') await repository.revokeCredential(credential.credential_id);
    }
    await audit('integration.client_revoked', actorReference, {
      organizationId: client.organization_id, integrationClientId,
    });
    return clientProjection(updated);
  }

  async function addClientCenterScope({ integrationClientId, centerId, actorReference }) {
    const client = await requireClient(integrationClientId);
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
  }

  async function removeClientCenterScope({ integrationClientId, centerId, actorReference }) {
    const client = await requireClient(integrationClientId, { active: false });
    const mappingDependencies = await repository.findActiveExternalCenterMappingByCenter(integrationClientId, centerId);
    if (mappingDependencies?.status === 'active') {
      throw new PlatformError('CENTER_SCOPE_HAS_MAPPING', 'ต้องปิด external Center mapping ก่อน', 409);
    }
    await repository.removeClientCenterScope(integrationClientId, centerId);
    await audit('integration.center_scope_removed', actorReference, {
      organizationId: client.organization_id, centerId, integrationClientId,
    });
    return { integrationClientId, centerId, allowed: false };
  }

  async function addClientEventScope({ integrationClientId, eventType, actorReference }) {
    assertEventType(eventType);
    const client = await requireClient(integrationClientId);
    await repository.addClientEventScope({ integrationClientId, eventType, actorReference: safeActorReference(actorReference) });
    await audit('integration.event_scope_added', actorReference, {
      organizationId: client.organization_id, integrationClientId,
    }, { eventType });
    return { integrationClientId, eventType, allowed: true };
  }

  async function removeClientEventScope({ integrationClientId, eventType, actorReference }) {
    assertEventType(eventType);
    const client = await requireClient(integrationClientId, { active: false });
    await repository.removeClientEventScope(integrationClientId, eventType);
    await audit('integration.event_scope_removed', actorReference, {
      organizationId: client.organization_id, integrationClientId,
    }, { eventType });
    return { integrationClientId, eventType, allowed: false };
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
    const client = await requireClient(integrationClientId);
    if ((await repository.listActiveCredentials(integrationClientId)).length) {
      throw new PlatformError('ACTIVE_CREDENTIAL_EXISTS', 'มี credential ที่ใช้งานอยู่แล้ว กรุณาใช้การหมุนกุญแจ', 409);
    }
    return createCredentialRecord({ client, actorReference });
  }

  async function rotateCredential({ integrationClientId, credentialId, overlapSeconds = 0, actorReference }) {
    const client = await requireClient(integrationClientId);
    const current = await repository.findCredential(credentialId);
    if (!current || current.integration_client_id !== integrationClientId || current.status !== 'active') {
      throw new PlatformError('ACTIVE_CREDENTIAL_NOT_FOUND', 'ไม่พบ credential ที่ใช้งานอยู่', 404);
    }
    const overlap = Number(overlapSeconds || 0);
    if (!Number.isInteger(overlap) || overlap < 0 || overlap > MAX_ROTATION_OVERLAP_SECONDS) {
      throw new PlatformError('INVALID_ROTATION_OVERLAP', 'ช่วง overlap ไม่ถูกต้อง', 400);
    }
    return runTransaction(`integration-credential:${integrationClientId}`, async () => {
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
    const client = await requireClient(integrationClientId, { active: false });
    const credential = await repository.findCredential(credentialId);
    if (!credential || credential.integration_client_id !== integrationClientId) {
      throw new PlatformError('CREDENTIAL_NOT_FOUND', 'ไม่พบ credential', 404);
    }
    const revoked = await repository.revokeCredential(credentialId);
    await audit('integration.credential_revoked', actorReference, {
      organizationId: client.organization_id, integrationClientId,
    }, { credentialId });
    return credentialProjection(revoked || credential);
  }

  async function authenticateCredential(token) {
    const match = TOKEN_PATTERN.exec(String(token || ''));
    if (!match) throw new PlatformError('INVALID_INTEGRATION_TOKEN', 'Integration credential ไม่ถูกต้อง', 401);
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
  }

  async function mapExternalCenter({ integrationClientId, externalCenterId, centerId, displayName, actorReference }) {
    const client = await requireClient(integrationClientId);
    await requireCenter(centerId);
    const organization = await repository.findOrganizationForCenter(centerId);
    if (!organization || organization.organization_id !== client.organization_id) {
      throw new PlatformError('CROSS_TENANT_CENTER_MAPPING', 'ไม่สามารถ map ศูนย์ต่างองค์กรได้', 403);
    }
    if (!(await repository.hasClientCenterScope(integrationClientId, centerId))) {
      throw new PlatformError('CENTER_SCOPE_DENIED', 'Integration Client ไม่มีสิทธิ์ใช้ศูนย์นี้', 403);
    }
    const externalId = requiredText(externalCenterId, { code: 'EXTERNAL_CENTER_REQUIRED', label: 'external Center ID', max: 160 });
    const existing = await repository.findExternalCenterMapping(integrationClientId, externalId);
    if (existing?.status === 'active' && existing.center_id !== centerId) {
      throw new PlatformError('EXTERNAL_CENTER_MAPPING_CONFLICT', 'external Center ID ถูก map ไปยังศูนย์อื่นแล้ว', 409);
    }
    const mapping = await repository.upsertExternalCenterMapping({
      mappingId: existing?.external_center_mapping_id || idFactory('ECM'),
      integrationClientId, organizationId: client.organization_id, externalCenterId: externalId,
      centerId, displayName: optionalText(displayName, 240),
    });
    await audit(existing ? 'integration.external_center_mapping_changed' : 'integration.external_center_mapping_created', actorReference, {
      organizationId: client.organization_id, centerId, integrationClientId,
    }, { externalCenterId: externalId });
    return mapping;
  }

  async function deactivateExternalCenterMapping({ integrationClientId, externalCenterId, actorReference }) {
    const client = await requireClient(integrationClientId, { active: false });
    const mapping = await repository.deactivateExternalCenterMapping(integrationClientId, externalCenterId);
    if (!mapping) throw new PlatformError('EXTERNAL_CENTER_MAPPING_NOT_FOUND', 'ไม่พบ external Center mapping', 404);
    await audit('integration.external_center_mapping_deactivated', actorReference, {
      organizationId: client.organization_id, centerId: mapping.center_id, integrationClientId,
    }, { externalCenterId });
    return mapping;
  }

  async function mapExternalSubject({
    integrationClientId, externalCenterId, externalResidentId, residentId = null,
    firstName, lastName, displayName, room, actorReference,
  }) {
    const client = await requireClient(integrationClientId);
    const centerMapping = await repository.findExternalCenterMapping(integrationClientId, requiredText(externalCenterId, {
      code: 'EXTERNAL_CENTER_REQUIRED', label: 'external Center ID', max: 160,
    }));
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
    }
    const extResidentId = requiredText(externalResidentId, { code: 'EXTERNAL_RESIDENT_REQUIRED', label: 'external Resident ID', max: 160 });
    const existing = await repository.findExternalSubjectMapping(integrationClientId, externalCenterId, extResidentId);
    if (existing?.mapping_status === 'mapped' && resident && existing.resident_id !== resident.resident_id) {
      throw new PlatformError('EXTERNAL_SUBJECT_MAPPING_CONFLICT', 'external Resident ID ถูก map ไปยังผู้พักอื่นแล้ว', 409);
    }
    const mappingStatus = resident ? 'mapped' : 'pending_subject_mapping';
    const mapping = await repository.upsertExternalSubjectMapping({
      mappingId: existing?.external_subject_mapping_id || idFactory('ESM'),
      integrationClientId, organizationId: client.organization_id,
      externalCenterId, externalResidentId: extResidentId, centerId: centerMapping.center_id,
      residentId: resident?.resident_id || null, careProfileId: resident?.care_profile_id || null,
      mappingStatus, firstName: optionalText(firstName, 120), lastName: optionalText(lastName, 120),
      displayName: optionalText(displayName, 240), room: optionalText(room, 80),
      lastSeenAt: now().toISOString(),
    });
    await audit(existing ? 'integration.external_subject_mapping_changed' : 'integration.external_subject_mapping_created', actorReference, {
      organizationId: client.organization_id, centerId: centerMapping.center_id, integrationClientId,
    }, { externalCenterId, externalResidentId: extResidentId, mappingStatus });
    return mapping;
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
    const client = await requireClient(integrationClientId, { active: false });
    const mapping = await repository.deactivateExternalSubjectMapping(integrationClientId, externalCenterId, externalResidentId);
    if (!mapping) throw new PlatformError('EXTERNAL_SUBJECT_MAPPING_NOT_FOUND', 'ไม่พบ external subject mapping', 404);
    await audit('integration.external_subject_mapping_deactivated', actorReference, {
      organizationId: client.organization_id, centerId: mapping.center_id, integrationClientId,
    }, { externalCenterId, externalResidentId, mappingStatus: 'inactive' });
    return mapping;
  }

  return {
    createOrganization, listOrganizations, getOrganizationForCenter,
    ensureOrganizationForCenter, listOrganizationCenters, relinkCenter,
    listCenterCapabilities, isCenterCapabilityEnabled, setCenterCapability,
    createIntegrationClient, inspectIntegrationClient, listIntegrationClients,
    revokeIntegrationClient, addClientCenterScope, removeClientCenterScope,
    addClientEventScope, removeClientEventScope,
    issueCredential, rotateCredential, revokeCredential, authenticateCredential,
    mapExternalCenter, deactivateExternalCenterMapping,
    mapExternalSubject, observeExternalSubject, deactivateExternalSubjectMapping,
    repository,
  };
}

const platformService = createPlatformService();

module.exports = { createPlatformService, platformService, credentialProjection, clientProjection, organizationProjection };
