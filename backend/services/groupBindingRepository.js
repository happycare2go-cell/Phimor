const { GroupBindings, id, now } = require('../db');

const ACTIVE_GROUP_BINDING_STATUS = 'active';
const GROUP_BINDING_TRANSACTION_KEY = 'group-binding-registry:v1';

function isActiveGroupBinding(binding, kind = null) {
  return Boolean(binding)
    && binding.status === ACTIVE_GROUP_BINDING_STATUS
    && (!kind || binding.kind === kind);
}

async function findActiveFamilyBinding(careProfileId, bindings = GroupBindings) {
  return bindings.findOne((binding) => isActiveGroupBinding(binding, 'family')
    && binding.care_profile_id === careProfileId);
}

async function listActiveBindingsForGroup(groupId, bindings = GroupBindings) {
  return bindings.findWhere((binding) => isActiveGroupBinding(binding)
    && binding.line_group_id === groupId);
}

async function findActiveCenterBinding(groupId, bindings = GroupBindings) {
  return bindings.findOne((binding) => isActiveGroupBinding(binding, 'center_staff')
    && binding.line_group_id === groupId);
}

async function findActiveCenterBindingByCenter(centerId, bindings = GroupBindings) {
  return bindings.findOne((binding) => isActiveGroupBinding(binding, 'center_staff')
    && binding.center_id === centerId);
}

async function findActiveCare2goBinding(bindings = GroupBindings) {
  return bindings.findOne((binding) => isActiveGroupBinding(binding, 'care2go_ops'));
}

/**
 * Canonical Family destination mutation shared by owner-issued FAMILY codes
 * and Center-issued CGROUP codes. Authorization must be completed by the
 * caller before invoking this primitive. Keeping the cardinality checks here
 * prevents the two issuance flows from drifting into parallel binding models.
 */
async function bindFamilyDestinationInCurrentTransaction({
  careProfileId, groupId, boundByLineUserId, sourceFlow = 'family_owner_code', sourceCenterId = null,
}, bindings = GroupBindings) {
  if (!groupId) return { ok:false, reason:'ไม่พบข้อมูลกลุ่ม LINE', code:'GROUP_CONTEXT_REQUIRED' };
  const groupBindings = await listActiveBindingsForGroup(groupId, bindings);
  if (groupBindings.some((binding) => binding.kind !== 'family')) {
    return { ok:false, reason:'กลุ่มนี้ถูกผูกเป็นกลุ่มประเภทอื่นแล้ว', code:'GROUP_KIND_CONFLICT' };
  }
  const current = await findActiveFamilyBinding(careProfileId, bindings);
  if (current?.line_group_id === groupId) return { ok:true, existing:true, binding:current };
  if (current) {
    return { ok:false, reason:'Care Profile นี้เชื่อมกลุ่มครอบครัวแล้ว', code:'FAMILY_GROUP_ALREADY_BOUND' };
  }
  const binding = await bindings.insert({
    binding_id:id('GB'), care_profile_id:careProfileId, line_group_id:groupId,
    kind:'family', center_id:null, status:'active', bound_at:now(),
    bound_by_line_user_id:boundByLineUserId || null,
    binding_source:sourceFlow,
    source_center_id:sourceCenterId || null,
  });
  return { ok:true, binding };
}

module.exports = {
  ACTIVE_GROUP_BINDING_STATUS,
  GROUP_BINDING_TRANSACTION_KEY,
  isActiveGroupBinding,
  findActiveFamilyBinding,
  listActiveBindingsForGroup,
  findActiveCenterBinding,
  findActiveCenterBindingByCenter,
  findActiveCare2goBinding,
  bindFamilyDestinationInCurrentTransaction,
};
