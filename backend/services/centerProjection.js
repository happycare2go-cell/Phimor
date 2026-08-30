const SECRET_CENTER_FIELDS = new Set([
  'external_api_key', 'externalApiKey', 'api_key', 'apiKey',
]);

function projectCenter(center, extra = {}) {
  if (!center) return null;
  const safe = {};
  for (const [key, value] of Object.entries(center)) {
    if (!SECRET_CENTER_FIELDS.has(key)) safe[key] = value;
  }
  return { ...safe, ...extra };
}

const ROLE_CAPABILITIES = Object.freeze({
  owner: Object.freeze({
    canManageResidents:true, canCreateResident:true, canReviewDailyCare:true,
    canFinalizeDailyCare:true, canManageTeam:true, canManageCenterSettings:true,
    canManageRateCard:true, canBindCenterGroup:true, canIssueFamilyGroupCode:true,
    canIssueOwnershipClaim:true,
  }),
  manager: Object.freeze({
    canManageResidents:true, canCreateResident:true, canReviewDailyCare:true,
    canFinalizeDailyCare:true, canManageTeam:false, canManageCenterSettings:false,
    canManageRateCard:true, canBindCenterGroup:true, canIssueFamilyGroupCode:true,
    canIssueOwnershipClaim:true,
  }),
  staff: Object.freeze({
    canManageResidents:false, canCreateResident:false, canReviewDailyCare:false,
    canFinalizeDailyCare:false, canManageTeam:false, canManageCenterSettings:false,
    canManageRateCard:false, canBindCenterGroup:false, canIssueFamilyGroupCode:false,
    canIssueOwnershipClaim:false,
  }),
});

/**
 * Minimal Center LIFF context. This is presentation convenience only; every
 * route still authorizes the actor and authoritative Center independently.
 */
function projectCenterContext(center, { role, subscription, staffGroupBound = false } = {}) {
  if (!center) return null;
  const safeRole = Object.hasOwn(ROLE_CAPABILITIES, role) ? role : 'staff';
  const entitlement = subscription && typeof subscription === 'object' ? {
    allowed:Boolean(subscription.allowed), code:subscription.code || null,
    state:subscription.state || null, packageType:subscription.packageType || null,
    startsAt:subscription.startsAt || null, expiresAt:subscription.expiresAt || null,
    remainingDays:Number.isFinite(subscription.remainingDays) ? subscription.remainingDays : null,
    needsConfiguration:Boolean(subscription.needsConfiguration),
  } : { allowed:false, code:'subscription_unavailable', state:null, packageType:null,
    startsAt:null, expiresAt:null, remainingDays:null, needsConfiguration:false };
  const centerId = center.center_id;
  const projection = {
    // Preserve the established LIFF field names while adding explicit aliases.
    center_id:centerId, centerId, name:center.name || 'ศูนย์ดูแล',
    myRole:safeRole, role:safeRole,
    status:center.status || 'active', operationalStatus:center.status || 'active',
    subscription:entitlement, entitlement,
    uiCapabilities:{ ...ROLE_CAPABILITIES[safeRole] },
    centerStaffGroup:{ status:staffGroupBound ? 'verified' : 'missing' },
  };
  if (safeRole === 'owner') {
    projection.settings = { address:center.address || '', contactPhone:center.contact_phone || '' };
  }
  return projection;
}

module.exports = { projectCenter, projectCenterContext, ROLE_CAPABILITIES, SECRET_CENTER_FIELDS };
