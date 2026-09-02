const { Centers, Residents, CareProfiles, GroupBindings } = require('../db');
const { platformService } = require('./platformService');
const { integrationIdentityPolicyService } = require('./integrationIdentityPolicyService');
const { PlatformError, assertEventType } = require('../domain/platform');
const { normalizedSubjectName, normalizeIdentityName, ignoredProjection } = require('../domain/integrationIdentity');
const { isActiveGroupBinding } = require('./groupBindingRepository');

const CAPABILITY_FOR_EVENT = Object.freeze({
  'care.vitals.recorded':'vital_signs_v1',
  'care.daily_report.finalized':'daily_care_v1',
});

function createIntegrationIdentityResolutionService(overrides = {}) {
  const platform = overrides.platformService || platformService;
  const repository = overrides.repository || platform.repository;
  const policies = overrides.integrationIdentityPolicyService || integrationIdentityPolicyService;
  const centers = overrides.Centers || Centers;
  const residents = overrides.Residents || Residents;
  const profiles = overrides.CareProfiles || CareProfiles;
  const bindings = overrides.GroupBindings || GroupBindings;

  async function ignore(identity, status, extra = {}) {
    await policies.incrementMetric(identity.integrationClientId, status);
    return { action:'ignored', policy:extra.policy || null, result:ignoredProjection(status) };
  }

  async function groupReady(careProfileId) {
    return Boolean(await bindings.findOne((row) => isActiveGroupBinding(row, 'family')
      && row.care_profile_id === careProfileId && String(row.line_group_id || '').trim()));
  }

  async function centerCommissioned(centerId, eventType) {
    const capability = CAPABILITY_FOR_EVENT[eventType];
    return !capability || platform.isCenterCapabilityEnabled(centerId, capability);
  }

  async function validateMapped({ identity, eventType, externalCenterId, externalResidentId, policy,
    centerMapping, subjectMapping }) {
    if (!centerMapping || centerMapping.status !== 'active') return ignore(identity, 'ignored_mapping_conflict', { policy });
    if (centerMapping.organization_id !== identity.organizationId) return ignore(identity, 'ignored_client_scope_mismatch', { policy });
    if (!(await repository.hasClientCenterScope(identity.integrationClientId, centerMapping.center_id))) {
      return ignore(identity, 'ignored_client_scope_mismatch', { policy });
    }
    const center = await centers.findOne((row) => row.center_id === centerMapping.center_id);
    if (!center || center.status !== 'active' || !(await centerCommissioned(centerMapping.center_id, eventType))) {
      return ignore(identity, 'ignored_center_not_commissioned', { policy });
    }
    if (!subjectMapping || subjectMapping.mapping_status !== 'mapped') return null;
    if (subjectMapping.organization_id !== identity.organizationId
      || subjectMapping.center_id !== centerMapping.center_id
      || subjectMapping.external_center_id !== externalCenterId
      || subjectMapping.external_resident_id !== externalResidentId) {
      return ignore(identity, 'ignored_mapping_conflict', { policy });
    }
    const resident = await residents.findOne((row) => row.resident_id === subjectMapping.resident_id
      && row.center_id === centerMapping.center_id);
    if (!resident || resident.status !== 'active') return ignore(identity, 'ignored_resident_inactive', { policy });
    if (!resident.care_profile_id || resident.care_profile_id !== subjectMapping.care_profile_id) {
      return ignore(identity, 'ignored_care_profile_not_ready', { policy });
    }
    const profile = await profiles.findOne((row) => row.care_profile_id === resident.care_profile_id);
    if (!profile) return ignore(identity, 'ignored_care_profile_not_ready', { policy });
    if (policy.familyGroupRequirement === 'required_before_ingest'
      && !(await groupReady(resident.care_profile_id))) {
      return ignore(identity, 'ignored_family_group_not_bound', { policy });
    }
    await policies.touchMappingOrigin({ integrationClientId:identity.integrationClientId, externalCenterId });
    await policies.touchMappingOrigin({ integrationClientId:identity.integrationClientId, externalCenterId,
      externalResidentId });
    return { action:'process', policy,
      tenant:{ organizationId:identity.organizationId, integrationClientId:identity.integrationClientId,
        credentialId:identity.credentialId, sourceSystem:identity.sourceSystem, eventType,
        externalCenterId, centerId:centerMapping.center_id },
      subject:{ status:'mapped', externalResidentId, residentId:resident.resident_id,
        careProfileId:resident.care_profile_id }, learned:false };
  }

  async function candidateCenters(identity, centerMapping) {
    const scopes = await repository.listClientCenterScopes(identity.integrationClientId);
    const allowed = [];
    for (const scope of scopes) {
      if (scope.organization_id !== identity.organizationId) continue;
      if (centerMapping && scope.center_id !== centerMapping.center_id) continue;
      const [center, organization] = await Promise.all([
        centers.findOne((row) => row.center_id === scope.center_id),
        repository.findOrganizationForCenter(scope.center_id),
      ]);
      if (center?.status === 'active' && organization?.organization_id === identity.organizationId) {
        allowed.push(center);
      }
    }
    return allowed.sort((a, b) => String(a.center_id).localeCompare(String(b.center_id)));
  }

  async function exactCandidates(identity, eventType, centerMapping, comparisonKey, policy) {
    const allowedCenters = await candidateCenters(identity, centerMapping);
    const exact = [];
    for (const center of allowedCenters) {
      const centerResidents = await residents.findWhereByField('center_id', center.center_id);
      for (const resident of centerResidents) {
        if (!resident.care_profile_id) continue;
        const profile = await profiles.findOne((row) => row.care_profile_id === resident.care_profile_id);
        if (!profile || normalizeIdentityName(resident.full_name) !== comparisonKey) continue;
        const active = resident.status === 'active';
        const commissioned = active && await centerCommissioned(center.center_id, eventType);
        const group = commissioned && (policy.familyGroupRequirement !== 'required_before_ingest'
          || await groupReady(profile.care_profile_id));
        exact.push({ center, resident, profile, active, commissioned, group });
      }
    }
    return { allowedCenters, exact,
      eligible:exact.filter((item) => item.active && item.commissioned && item.group) };
  }

  async function resolve({ identity, eventType, subject }) {
    assertEventType(eventType);
    await platform.assertIntegrationIdentityActive(identity);
    if (!(await repository.hasClientEventScope(identity.integrationClientId, eventType))) {
      throw new PlatformError('EVENT_SCOPE_DENIED', 'Integration Client ไม่มีสิทธิ์สำหรับ event type นี้', 403);
    }
    const policy = await policies.getPolicy(identity.integrationClientId);
    const externalCenterId = String(subject.externalCenterId || '').trim();
    const externalResidentId = String(subject.externalResidentId || '').trim();
    const centerMapping = await repository.findExternalCenterMapping(identity.integrationClientId, externalCenterId);
    const subjectMapping = await repository.findExternalSubjectMapping(identity.integrationClientId,
      externalCenterId, externalResidentId);

    if (subjectMapping?.mapping_status === 'mapped') {
      return validateMapped({ identity, eventType, externalCenterId, externalResidentId, policy,
        centerMapping, subjectMapping });
    }
    if (subjectMapping?.mapping_status === 'inactive' || (centerMapping && centerMapping.status !== 'active')) {
      return ignore(identity, 'ignored_mapping_conflict', { policy });
    }
    if (policy.identityResolutionMode !== 'exact_name_learning') {
      if (policy.unresolvedEventPolicy === 'ignore') {
        return ignore(identity, centerMapping ? 'ignored_subject_unresolved' : 'ignored_center_not_commissioned', { policy });
      }
      return { action:'legacy', policy };
    }

    const normalized = normalizedSubjectName(subject);
    if (!normalized.comparisonKey) return ignore(identity, 'ignored_subject_name_missing', { policy });
    if (centerMapping?.organization_id !== undefined && centerMapping.organization_id !== identity.organizationId) {
      return ignore(identity, 'ignored_client_scope_mismatch', { policy });
    }
    if (centerMapping?.status === 'active'
      && !(await repository.hasClientCenterScope(identity.integrationClientId, centerMapping.center_id))) {
      return ignore(identity, 'ignored_client_scope_mismatch', { policy });
    }
    const matches = await exactCandidates(identity, eventType,
      centerMapping?.status === 'active' ? centerMapping : null, normalized.comparisonKey, policy);
    if (!matches.allowedCenters.length) return ignore(identity, 'ignored_client_scope_mismatch', { policy });
    if (!matches.eligible.length) {
      if (matches.exact.some((item) => !item.active)) return ignore(identity, 'ignored_resident_inactive', { policy });
      if (matches.exact.some((item) => item.active && !item.commissioned)) {
        return ignore(identity, 'ignored_center_not_commissioned', { policy });
      }
      if (matches.exact.some((item) => item.active && item.commissioned && !item.group)) {
        return ignore(identity, 'ignored_family_group_not_bound', { policy });
      }
      if (policy.unresolvedEventPolicy === 'pending_subject_mapping' && centerMapping?.status === 'active') {
        return { action:'legacy', policy };
      }
      return ignore(identity, 'ignored_subject_unresolved', { policy });
    }
    if (matches.eligible.length > 1) {
      await policies.recordAmbiguity({ integrationClientId:identity.integrationClientId,
        sourceSystemDisplayName:identity.sourceSystem, externalCenterId, externalResidentId,
        normalizedDisplayName:normalized.displayName,
        candidateCenterNames:matches.eligible.map((item) => item.center.name || 'ไม่ระบุชื่อศูนย์'),
        candidateCount:matches.eligible.length });
      return ignore(identity, 'ignored_subject_ambiguous', { policy });
    }
    const candidate = matches.eligible[0];
    try {
      await platform.learnExternalIdentity({ integrationClientId:identity.integrationClientId,
        externalCenterId, externalResidentId, centerId:candidate.center.center_id,
        residentId:candidate.resident.resident_id, careProfileId:candidate.profile.care_profile_id,
        firstName:subject.firstName, lastName:subject.lastName,
        displayName:normalized.displayName, room:subject.room, eventType,
        expectedNameKey:normalized.comparisonKey });
    } catch (error) {
      if (['EXTERNAL_CENTER_MAPPING_CONFLICT', 'EXTERNAL_SUBJECT_MAPPING_CONFLICT',
        'RESIDENT_CARE_PROFILE_NOT_READY'].includes(error?.code)) {
        return ignore(identity, 'ignored_mapping_conflict', { policy });
      }
      if (error?.code === 'CENTER_INACTIVE') {
        return ignore(identity, 'ignored_center_not_commissioned', { policy });
      }
      if (['CENTER_SCOPE_DENIED', 'CROSS_TENANT_CENTER_MAPPING'].includes(error?.code)) {
        return ignore(identity, 'ignored_client_scope_mismatch', { policy });
      }
      throw error;
    }
    const freshCenter = await repository.findExternalCenterMapping(identity.integrationClientId, externalCenterId);
    const freshSubject = await repository.findExternalSubjectMapping(identity.integrationClientId,
      externalCenterId, externalResidentId);
    const result = await validateMapped({ identity, eventType, externalCenterId, externalResidentId,
      policy, centerMapping:freshCenter, subjectMapping:freshSubject });
    if (result?.action === 'process') result.learned = true;
    return result;
  }

  return { resolve, groupReady, exactCandidates };
}

const integrationIdentityResolutionService = createIntegrationIdentityResolutionService();
module.exports = { createIntegrationIdentityResolutionService, integrationIdentityResolutionService,
  CAPABILITY_FOR_EVENT };
