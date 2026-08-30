const crypto = require('node:crypto');
const { PlatformError } = require('./platform');

const IDENTITY_RESOLUTION_MODES = Object.freeze(['exact_name_learning', 'manual_mapping_only']);
const UNRESOLVED_EVENT_POLICIES = Object.freeze(['ignore', 'pending_subject_mapping']);
const FAMILY_GROUP_REQUIREMENTS = Object.freeze(['required_before_ingest', 'optional_for_ingest']);
const DEFAULT_INTEGRATION_IDENTITY_POLICY = Object.freeze({
  identityResolutionMode:'manual_mapping_only',
  unresolvedEventPolicy:'pending_subject_mapping',
  familyGroupRequirement:'optional_for_ingest',
});
const IGNORED_INTEGRATION_STATUSES = Object.freeze([
  'ignored_center_not_commissioned',
  'ignored_subject_name_missing',
  'ignored_subject_unresolved',
  'ignored_subject_ambiguous',
  'ignored_resident_inactive',
  'ignored_care_profile_not_ready',
  'ignored_family_group_not_bound',
  'ignored_mapping_conflict',
  'ignored_client_scope_mismatch',
]);

function assertPolicy(input = {}) {
  const policy = {
    identityResolutionMode:String(input.identityResolutionMode || '').trim(),
    unresolvedEventPolicy:String(input.unresolvedEventPolicy || '').trim(),
    familyGroupRequirement:String(input.familyGroupRequirement || '').trim(),
  };
  if (!IDENTITY_RESOLUTION_MODES.includes(policy.identityResolutionMode)
    || !UNRESOLVED_EVENT_POLICIES.includes(policy.unresolvedEventPolicy)
    || !FAMILY_GROUP_REQUIREMENTS.includes(policy.familyGroupRequirement)) {
    throw new PlatformError('INVALID_IDENTITY_RESOLUTION_POLICY', 'นโยบายการระบุตัวตนไม่ถูกต้อง', 400);
  }
  return policy;
}

function normalizeIdentityName(value) {
  const normalized = String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return normalized.toLocaleLowerCase('en-US');
}

function normalizedSubjectName(subject = {}) {
  const first = String(subject.firstName || '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const last = String(subject.lastName || '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const display = [first, last].filter(Boolean).join(' ');
  return { displayName:display || null, comparisonKey:normalizeIdentityName(display) || null };
}

function ignoredProjection(status) {
  if (!IGNORED_INTEGRATION_STATUSES.includes(status)) throw new TypeError('INVALID_IGNORED_INTEGRATION_STATUS');
  return { status, accepted:false, stored:false };
}

function safeIdentityKey(parts) {
  return crypto.createHash('sha256').update(parts.map((part) => String(part || '')).join('\u001f')).digest('hex');
}

module.exports = {
  IDENTITY_RESOLUTION_MODES,
  UNRESOLVED_EVENT_POLICIES,
  FAMILY_GROUP_REQUIREMENTS,
  DEFAULT_INTEGRATION_IDENTITY_POLICY,
  IGNORED_INTEGRATION_STATUSES,
  assertPolicy,
  normalizeIdentityName,
  normalizedSubjectName,
  ignoredProjection,
  safeIdentityKey,
};
