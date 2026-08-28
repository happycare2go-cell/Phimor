const { Residents, CenterStaff } = require('../db');

const FAMILY_ACTORS = new Set(['family_owner', 'family_caregiver']);
const CENTER_ACTORS = new Set(['center_staff', 'center_manager', 'center_owner']);

function persistedAuthority(record = {}) {
  const source = record.created_source;
  const actorType = record.created_by_actor_type;
  if (source === 'family_liff' && FAMILY_ACTORS.has(actorType)) return 'family';
  if (source === 'center_liff' && CENTER_ACTORS.has(actorType)) return 'center';
  return 'ambiguous';
}

function createClinicalRecordMutationAuthority(overrides = {}) {
  const residents = overrides.Residents || Residents;
  const centerStaff = overrides.CenterStaff || CenterStaff;

  async function resolveAuthoritativeCenter({ careProfileId, creatorLineUserId }) {
    if (!creatorLineUserId) return null;
    // Lab/Doctor Visit V1 records do not persist center_id. Use only the
    // intersection of persisted Care Profile relationships and the original
    // creator's Center memberships. Include inactive historical rows so a
    // later Center move cannot silently re-attribute an older record.
    const [linked, memberships] = await Promise.all([
      residents.findWhere((row) => row.care_profile_id === careProfileId
        && typeof row.center_id === 'string' && row.center_id),
      centerStaff.findWhere((row) => row.line_user_id === creatorLineUserId
        && typeof row.center_id === 'string' && row.center_id),
    ]);
    const linkedCenters = new Set(linked.map((row) => row.center_id));
    const candidates = [...new Set(memberships.map((row) => row.center_id))]
      .filter((centerId) => linkedCenters.has(centerId));
    return candidates.length === 1 ? candidates[0] : null;
  }

  async function assertMutationAllowed({ record, access, careProfileId, requestedCenterId, fail }) {
    const authority = persistedAuthority(record);
    if (authority === 'family') {
      if (!FAMILY_ACTORS.has(access?.principalType)) fail('ACCESS_DENIED');
      return { authority, centerId:null };
    }
    if (authority === 'center') {
      if (access?.principalType !== 'center_staff' || !['manager', 'owner'].includes(access.role)) {
        fail('ACCESS_DENIED');
      }
      const authoritativeCenterId = await resolveAuthoritativeCenter({
        careProfileId, creatorLineUserId:record.created_by_actor_id,
      });
      if (!authoritativeCenterId) fail('RECORD_PROVENANCE_AMBIGUOUS');
      const callerCenterId = access?.center?.center_id || requestedCenterId || null;
      if (callerCenterId !== authoritativeCenterId) fail('ACCESS_DENIED');
      return { authority, centerId:authoritativeCenterId };
    }
    fail('RECORD_PROVENANCE_AMBIGUOUS');
    return null;
  }

  return { persistedAuthority, resolveAuthoritativeCenter, assertMutationAllowed };
}

module.exports = {
  FAMILY_ACTORS, CENTER_ACTORS, persistedAuthority, createClinicalRecordMutationAuthority,
};
