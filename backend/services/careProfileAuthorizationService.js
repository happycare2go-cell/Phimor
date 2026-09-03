const { CareProfiles, CareProfileMembers, Residents, CenterStaff, Centers } = require('../db');
const subscriptionService = require('./subscriptionService');

const FAMILY_PERMISSIONS = Object.freeze([
  'view', 'edit_profile', 'manage_appointments', 'manage_medications', 'decide_transport',
]);

const CENTER_ROLE_PERMISSIONS = Object.freeze({
  owner: FAMILY_PERMISSIONS,
  manager: FAMILY_PERMISSIONS,
  staff: Object.freeze(['view']),
});

const ERROR_DEFINITIONS = Object.freeze({
  UNAUTHENTICATED: { status: 401, message: 'กรุณาเข้าสู่ระบบใหม่อีกครั้ง' },
  CARE_PROFILE_NOT_FOUND: { status: 404, message: 'ไม่พบข้อมูลหรือคุณไม่มีสิทธิ์เข้าถึง' },
  ACCESS_DENIED: { status: 403, message: 'ไม่พบข้อมูลหรือคุณไม่มีสิทธิ์เข้าถึง' },
  MEMBERSHIP_REVOKED: { status: 403, message: 'สิทธิ์เข้าถึงข้อมูลนี้ไม่พร้อมใช้งาน' },
  CENTER_ACCESS_REVOKED: { status: 403, message: 'สิทธิ์เข้าถึงข้อมูลนี้ไม่พร้อมใช้งาน' },
  CENTER_SUBSCRIPTION_INACTIVE: { status: 402, message: 'สิทธิ์การใช้งานของศูนย์ไม่พร้อมใช้งาน' },
});

class CareProfileAuthorizationError extends Error {
  constructor(code, details = {}) {
    const definition = ERROR_DEFINITIONS[code] || ERROR_DEFINITIONS.ACCESS_DENIED;
    super(definition.message);
    this.name = 'CareProfileAuthorizationError';
    this.code = code;
    this.status = definition.status;
    // Internal details are intentionally non-enumerable so they cannot be
    // accidentally serialized into an API response.
    Object.defineProperty(this, 'details', { value: details, enumerable: false });
  }
}

function deny(code, details) {
  throw new CareProfileAuthorizationError(code, details);
}

function isUsableProfile(profile) {
  return profile && !['inactive', 'revoked', 'deleted'].includes(profile.status);
}

function normalizePermission(permission) {
  if (!FAMILY_PERMISSIONS.includes(permission)) deny('ACCESS_DENIED', { reason: 'unsupported_permission' });
  return permission;
}

function activeStatus(record) {
  return record && (!record.status || record.status === 'active');
}

const CENTER_ROLE_RANK = Object.freeze({ owner:3, manager:2, staff:1 });

function selectEffectiveCenterStaff(rows = []) {
  return rows.filter(activeStatus).sort((left, right) => (
    (CENTER_ROLE_RANK[right.role] || 0) - (CENTER_ROLE_RANK[left.role] || 0)
    || String(left.staff_id || '').localeCompare(String(right.staff_id || ''))
  ))[0] || null;
}

async function authorizeFamily({ lineUserId, careProfile, permission }) {
  if (careProfile.owner_line_id === lineUserId) {
    return {
      principalType: 'family_owner', role: 'owner', permissions: ['*'],
      careProfile, resident: null, center: null,
    };
  }

  const membership = await CareProfileMembers.findOne(
    (member) => member.care_profile_id === careProfile.care_profile_id && member.line_user_id === lineUserId
  );
  if (!membership) return null;
  if (membership.status !== 'active') deny('MEMBERSHIP_REVOKED', { membershipStatus: membership.status });

  const permissions = membership.permissions || ['view','edit_profile','manage_appointments','decide_transport'];
  if (!permissions.includes(permission)) {
    deny('ACCESS_DENIED', { reason: 'missing_family_permission', permission });
  }
  return {
    principalType: 'family_caregiver', role: membership.role || 'caregiver',
    permissions: [...permissions], careProfile, resident: null, center: null,
  };
}

async function authorizeCenter({ lineUserId, careProfile, permission, centerId, requireActiveCenter }) {
  const linkedResidents = await Residents.findWhere((resident) =>
    resident.care_profile_id === careProfile.care_profile_id && resident.status === 'active' && (!centerId || resident.center_id === centerId)
  );
  if (linkedResidents.length === 0) {
    const revokedRelationship = await Residents.findOne((resident) =>
      resident.care_profile_id === careProfile.care_profile_id && (!centerId || resident.center_id === centerId)
    );
    if (revokedRelationship) deny('CENTER_ACCESS_REVOKED', { reason: 'resident_inactive' });
    return null;
  }

  const candidates = [];
  let sawRevokedStaff = false;
  let sawInactiveSubscription = false;
  for (const resident of linkedResidents) {
    const staffRows = await CenterStaff.findWhere((member) =>
      member.center_id === resident.center_id && member.line_user_id === lineUserId
    );
    if (!staffRows.length) continue;
    const staff = selectEffectiveCenterStaff(staffRows);
    if (!staff) { sawRevokedStaff = true; continue; }
    const allowedPermissions = CENTER_ROLE_PERMISSIONS[staff.role] || [];
    if (!allowedPermissions.includes(permission)) continue;
    const center = await Centers.findOne((item) => item.center_id === resident.center_id);
    if (!center) continue;
    const entitlement = subscriptionService.entitlement(center);
    if (requireActiveCenter && !entitlement.allowed) { sawInactiveSubscription = true; continue; }
    candidates.push({ resident, staff, center, entitlement, allowedPermissions });
  }

  if (candidates.length > 1 && !centerId) deny('ACCESS_DENIED', { reason: 'ambiguous_center_context' });
  if (candidates.length === 0) {
    if (sawInactiveSubscription) deny('CENTER_SUBSCRIPTION_INACTIVE');
    if (sawRevokedStaff) deny('CENTER_ACCESS_REVOKED', { reason: 'staff_inactive' });
    return null;
  }

  const selected = candidates[0];
  return {
    principalType: 'center_staff', role: selected.staff.role,
    permissions: [...selected.allowedPermissions], careProfile,
    resident: selected.resident, center: selected.center,
  };
}

async function authorizeCareProfileAccess({
  lineUserId, careProfileId, permission, centerId = null, requireActiveCenter = true,
} = {}) {
  if (!lineUserId || typeof lineUserId !== 'string') deny('UNAUTHENTICATED');
  if (!careProfileId || typeof careProfileId !== 'string') deny('CARE_PROFILE_NOT_FOUND', { reason: 'invalid_identifier' });
  const requiredPermission = normalizePermission(permission);
  const careProfile = await CareProfiles.findOne((profile) => profile.care_profile_id === careProfileId);
  if (!isUsableProfile(careProfile)) deny('CARE_PROFILE_NOT_FOUND');

  const familyContext = await authorizeFamily({ lineUserId, careProfile, permission: requiredPermission });
  if (familyContext) return familyContext;

  const centerContext = await authorizeCenter({
    lineUserId, careProfile, permission: requiredPermission, centerId, requireActiveCenter,
  });
  if (centerContext) return centerContext;
  deny('ACCESS_DENIED');
}

module.exports = {
  authorizeCareProfileAccess, CareProfileAuthorizationError,
  FAMILY_PERMISSIONS, CENTER_ROLE_PERMISSIONS, selectEffectiveCenterStaff,
};
