const ORGANIZATION_STATUSES = Object.freeze(['active', 'suspended', 'archived']);
const ORGANIZATION_TYPES = Object.freeze(['external_care_center', 'platform_internal']);
const CAPABILITY_KEYS = Object.freeze(['vital_signs_v1', 'daily_care_v1']);
const INTEGRATION_EVENT_TYPES = Object.freeze([
  'care.vitals.recorded',
  'care.daily_report.recorded',
]);
const INTEGRATION_CLIENT_STATUSES = Object.freeze(['active', 'suspended', 'revoked']);
const CREDENTIAL_STATUSES = Object.freeze(['active', 'revoked']);
const SUBJECT_MAPPING_STATUSES = Object.freeze(['pending_subject_mapping', 'mapped', 'inactive']);

class PlatformError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
    this.status = status;
  }
}

function assertEnum(value, allowed, code, label) {
  if (!allowed.includes(value)) throw new PlatformError(code, `${label} ไม่ถูกต้อง`, 400);
  return value;
}

function requiredText(value, { code = 'INVALID_VALUE', label = 'ข้อมูล', max = 160 } = {}) {
  const clean = String(value || '').trim();
  if (!clean || clean.length > max) throw new PlatformError(code, `${label} ไม่ถูกต้อง`, 400);
  return clean;
}

function optionalText(value, max = 160) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim().slice(0, max) || null;
}

function assertCapabilityKey(value) {
  return assertEnum(value, CAPABILITY_KEYS, 'UNKNOWN_CAPABILITY', 'capability');
}

function assertEventType(value) {
  return assertEnum(value, INTEGRATION_EVENT_TYPES, 'UNKNOWN_EVENT_TYPE', 'event type');
}

module.exports = {
  ORGANIZATION_STATUSES,
  ORGANIZATION_TYPES,
  CAPABILITY_KEYS,
  INTEGRATION_EVENT_TYPES,
  INTEGRATION_CLIENT_STATUSES,
  CREDENTIAL_STATUSES,
  SUBJECT_MAPPING_STATUSES,
  PlatformError,
  assertEnum,
  requiredText,
  optionalText,
  assertCapabilityKey,
  assertEventType,
};
