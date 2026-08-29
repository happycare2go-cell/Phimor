const { Centers, Residents } = require('../db');
const { PlatformError, assertEventType, requiredText } = require('../domain/platform');
const { platformService } = require('./platformService');

function createTenantResolver(overrides = {}) {
  const service = overrides.platformService || platformService;
  const repository = overrides.repository || service.repository;
  const centers = overrides.Centers || Centers;
  const residents = overrides.Residents || Residents;

  async function resolveCenterTenant(centerId) {
    const organization = await service.getOrganizationForCenter(centerId);
    if (!organization || organization.status !== 'active') {
      throw new PlatformError('CENTER_TENANT_UNAVAILABLE', 'ไม่พบ tenant ที่ใช้งานได้สำหรับศูนย์', 403);
    }
    return { organizationId: organization.organizationId, centerId };
  }

  async function resolveIntegrationCredential(token) {
    return service.authenticateCredential(token);
  }

  async function authorizeIntegrationTarget({ token, eventType, externalCenterId }) {
    assertEventType(eventType);
    const identity = await resolveIntegrationCredential(token);
    return authorizeResolvedIntegrationTarget({ identity, eventType, externalCenterId });
  }

  async function authorizeResolvedIntegrationTarget({ identity, eventType, externalCenterId }) {
    assertEventType(eventType);
    if (!identity?.integrationClientId || !identity?.organizationId || !identity?.sourceSystem) {
      throw new PlatformError('INVALID_INTEGRATION_IDENTITY', 'Integration identity ไม่ถูกต้อง', 401);
    }
    if (typeof service.assertIntegrationIdentityActive === 'function') {
      await service.assertIntegrationIdentityActive(identity);
    }
    if (!(await repository.hasClientEventScope(identity.integrationClientId, eventType))) {
      throw new PlatformError('EVENT_SCOPE_DENIED', 'Integration Client ไม่มีสิทธิ์สำหรับ event type นี้', 403);
    }
    const externalId = requiredText(externalCenterId, {
      code: 'EXTERNAL_CENTER_REQUIRED', label: 'external Center ID', max: 160,
    });
    const mapping = await repository.findExternalCenterMapping(identity.integrationClientId, externalId);
    if (!mapping || mapping.status !== 'active') {
      throw new PlatformError('EXTERNAL_CENTER_MAPPING_NOT_FOUND', 'ไม่พบ external Center mapping', 422);
    }
    if (mapping.organization_id !== identity.organizationId) {
      throw new PlatformError('CROSS_TENANT_CENTER_MAPPING', 'mapping ข้ามองค์กรไม่ได้', 403);
    }
    if (!(await repository.hasClientCenterScope(identity.integrationClientId, mapping.center_id))) {
      throw new PlatformError('CENTER_SCOPE_DENIED', 'Integration Client ไม่มีสิทธิ์ใช้ศูนย์นี้', 403);
    }
    const center = await centers.findOne((row) => row.center_id === mapping.center_id && row.status === 'active');
    if (!center) throw new PlatformError('CENTER_INACTIVE', 'ศูนย์ไม่พร้อมรับข้อมูล Integration', 403);
    return {
      organizationId: identity.organizationId,
      integrationClientId: identity.integrationClientId,
      credentialId: identity.credentialId,
      sourceSystem: identity.sourceSystem,
      eventType,
      externalCenterId: externalId,
      centerId: mapping.center_id,
    };
  }

  async function resolveExternalSubject({ tenant, externalResidentId, display = {} }) {
    const externalId = requiredText(externalResidentId, {
      code: 'EXTERNAL_RESIDENT_REQUIRED', label: 'external Resident ID', max: 160,
    });
    const mapping = await repository.findExternalSubjectMapping(
      tenant.integrationClientId, tenant.externalCenterId, externalId
    );
    if (!mapping || mapping.mapping_status !== 'mapped') {
      return {
        status: 'pending_subject_mapping', externalResidentId: externalId,
        display: {
          firstName: display.firstName || null, lastName: display.lastName || null,
          displayName: display.displayName || null, room: display.room || null,
        },
      };
    }
    if (mapping.organization_id !== tenant.organizationId || mapping.center_id !== tenant.centerId) {
      throw new PlatformError('CROSS_TENANT_SUBJECT_MAPPING', 'subject mapping ข้าม tenant ไม่ได้', 403);
    }
    const resident = await residents.findOne((row) => row.resident_id === mapping.resident_id
      && row.center_id === tenant.centerId && row.status === 'active');
    if (!resident) {
      return { status: 'pending_subject_mapping', externalResidentId: externalId, reason: 'resident_relationship_changed' };
    }
    return {
      status: 'mapped', externalResidentId: externalId,
      residentId: resident.resident_id, careProfileId: resident.care_profile_id || null,
    };
  }

  return { resolveCenterTenant, resolveIntegrationCredential, authorizeIntegrationTarget,
    authorizeResolvedIntegrationTarget, resolveExternalSubject };
}

const tenantResolver = createTenantResolver();

module.exports = { createTenantResolver, tenantResolver };
