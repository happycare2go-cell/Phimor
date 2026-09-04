const { databaseQuery } = require('../db');
const { loadFeatureFlags } = require('../config/featureFlags');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { logOperationalError } = require('../utils/safeOperationalError');

const PLUS_FEATURES = Object.freeze([
  'care_profile_summary', 'medication_summary', 'appointment_summary', 'doctor_visit_preparation',
  'ai_explanation', 'medication_diff', 'pharmacist_escalation',
]);

const FEATURE_FLAG_KEYS = Object.freeze({
  ai_explanation: 'aiExplanation',
  medication_diff: 'medicationDiff',
  pharmacist_escalation: 'pharmacistEscalation',
});

const PLUS_CAPABILITY_REGISTRY = Object.freeze({
  ai_lab_explanation: Object.freeze({ status: 'LIVE', feature: 'ai_explanation', flag: 'aiExplanation' }),
  doctor_question_prep: Object.freeze({ status: 'LIVE', feature: 'ai_explanation', flag: 'aiExplanation' }),
  doctor_visit_organization: Object.freeze({ status: 'LIVE', feature: 'ai_explanation', flag: 'aiExplanation' }),
  care_profile_ai_assistant: Object.freeze({ status: 'LIVE', feature: 'ai_explanation', flag: 'aiExplanation' }),
  care_change_summary: Object.freeze({ status: 'LIVE', feature: 'medication_diff', flag: 'medicationDiff' }),
  monthly_health_summary: Object.freeze({ status: 'FUTURE', feature: null, flag: null }),
  smart_reminders: Object.freeze({ status: 'FUTURE', feature: null, flag: null }),
});

class PlusEntitlementError extends Error {
  constructor(code) {
    super('ไม่สามารถใช้คุณสมบัติ Phimor Plus นี้ได้');
    this.name = 'PlusEntitlementError';
    this.code = code;
    this.status = code === 'UNAUTHENTICATED' ? 401 : 403;
  }
}

function basicResult(reasonCode) {
  return Object.freeze({ planCode: 'family_basic', plus: false, allowed: false, reasonCode, features: [] });
}

function normalizeFeatures(value) {
  if (Array.isArray(value)) return [...new Set(value.filter((item) => typeof item === 'string' && item.length <= 64))];
  return [];
}

function evaluateRecord(record, { at, internalOnly }) {
  if (!record) return { allowed: false, reasonCode: 'ENTITLEMENT_INACTIVE' };
  if (record.status === 'expired') return { allowed: false, reasonCode: 'ENTITLEMENT_EXPIRED' };
  if (record.status === 'suspended') return { allowed: false, reasonCode: 'ENTITLEMENT_SUSPENDED' };
  if (!['active', 'trial'].includes(record.status)) return { allowed: false, reasonCode: 'ENTITLEMENT_INACTIVE' };
  if (internalOnly && record.source !== 'internal') return { allowed: false, reasonCode: 'INTERNAL_ENTITLEMENT_REQUIRED' };
  const startsAt = new Date(record.starts_at);
  const expiresAt = new Date(record.expires_at);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(expiresAt.getTime())) return { allowed: false, reasonCode: 'ENTITLEMENT_INVALID' };
  if (startsAt.getTime() > at.getTime()) return { allowed: false, reasonCode: 'ENTITLEMENT_NOT_STARTED' };
  if (expiresAt.getTime() <= at.getTime()) return { allowed: false, reasonCode: 'ENTITLEMENT_EXPIRED' };
  return { allowed: true, reasonCode: null };
}

async function getPlusEntitlement({
  lineUserId, at = new Date(), flags = loadFeatureFlags(), queryFn = databaseQuery,
  operationalLogger = console.error,
} = {}) {
  if (!lineUserId || typeof lineUserId !== 'string') return basicResult('UNAUTHENTICATED');
  if (!flags.plus.enabled) return basicResult('PLUS_DISABLED');
  const instant = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(instant.getTime())) return basicResult('INVALID_TIME');
  let result;
  try {
    result = await queryFn(
      `SELECT entitlement_id, subject_type, subject_id, plan_code, status, starts_at, expires_at, source, features
       FROM plus_entitlements
       WHERE subject_type = 'line_user' AND subject_id = $1 AND plan_code = 'family_plus'
       ORDER BY expires_at DESC`,
      [lineUserId]
    );
  } catch (_) {
    logOperationalError(operationalLogger, {
      event:'plus_entitlement_lookup_failed', errorCode:'PLUS_ENTITLEMENT_LOOKUP_FAILED',
      routeCategory:'plus_entitlement',
    });
    return basicResult('ENTITLEMENT_UNAVAILABLE');
  }
  const records = Array.isArray(result?.rows) ? result.rows : [];
  if (records.length === 0) return basicResult('NO_PLUS_ENTITLEMENT');

  let firstDenied = null;
  for (const record of records) {
    const decision = evaluateRecord(record, { at: instant, internalOnly: flags.plus.internalEntitlementOnly });
    if (!decision.allowed) { firstDenied ||= decision; continue; }
    return Object.freeze({
      entitlementId: record.entitlement_id,
      planCode: 'family_plus', plus: true, allowed: true, reasonCode: null,
      status: record.status, source: record.source,
      startsAt: new Date(record.starts_at).toISOString(), expiresAt: new Date(record.expires_at).toISOString(),
      features: normalizeFeatures(record.features),
    });
  }
  return basicResult(firstDenied?.reasonCode || 'ENTITLEMENT_INACTIVE');
}

async function requirePlusFeature({
  lineUserId, feature, capability = null, at, flags = loadFeatureFlags(), queryFn = databaseQuery,
  operationalLogger = console.error,
} = {}) {
  const definition = capability ? PLUS_CAPABILITY_REGISTRY[capability] : null;
  if (capability && (!definition || definition.status !== 'LIVE')) {
    throw new PlusEntitlementError('PLUS_CAPABILITY_NOT_AVAILABLE');
  }
  feature = definition?.feature || feature;
  if (!PLUS_FEATURES.includes(feature)) throw new PlusEntitlementError('PLUS_FEATURE_NOT_SUPPORTED');
  const featureFlag = FEATURE_FLAG_KEYS[feature];
  if (featureFlag && !flags.plus[featureFlag]) throw new PlusEntitlementError('PLUS_FEATURE_DISABLED');
  const entitlement = await getPlusEntitlement({ lineUserId, at, flags, queryFn, operationalLogger });
  if (!entitlement.allowed) throw new PlusEntitlementError(entitlement.reasonCode);
  if (!entitlement.features.includes('*') && !entitlement.features.includes(feature)) {
    throw new PlusEntitlementError('PLUS_FEATURE_NOT_INCLUDED');
  }
  return entitlement;
}

async function canUseCapability({
  lineUserId, careProfileId = null, capability, at,
  flags = loadFeatureFlags(), queryFn = databaseQuery,
  authorize = authorizeCareProfileAccess,
  operationalLogger = console.error,
} = {}) {
  const definition = PLUS_CAPABILITY_REGISTRY[capability];
  if (!definition || definition.status !== 'LIVE') {
    return Object.freeze({ allowed: false, capability, reasonCode: 'PLUS_CAPABILITY_NOT_AVAILABLE' });
  }
  if (careProfileId) {
    try {
      await authorize({ lineUserId, careProfileId, permission: 'view', requireActiveCenter: true });
    } catch (_) {
      return Object.freeze({ allowed: false, capability, reasonCode: 'ACCESS_DENIED' });
    }
  }
  try {
    const entitlement = await requirePlusFeature({
      lineUserId, capability, at, flags, queryFn, operationalLogger,
    });
    return Object.freeze({ allowed: true, capability, entitlement });
  } catch (error) {
    return Object.freeze({ allowed: false, capability, reasonCode: error?.code || 'ENTITLEMENT_UNAVAILABLE' });
  }
}

async function requirePlusCapability(input = {}) {
  const decision = await canUseCapability(input);
  if (!decision.allowed) throw new PlusEntitlementError(decision.reasonCode);
  return decision.entitlement;
}

module.exports = {
  PLUS_FEATURES, FEATURE_FLAG_KEYS, PLUS_CAPABILITY_REGISTRY, PlusEntitlementError,
  normalizeFeatures, evaluateRecord, getPlusEntitlement, requirePlusFeature,
  canUseCapability, requirePlusCapability,
};
