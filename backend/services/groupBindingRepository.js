const { GroupBindings } = require('../db');

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

module.exports = {
  ACTIVE_GROUP_BINDING_STATUS,
  GROUP_BINDING_TRANSACTION_KEY,
  isActiveGroupBinding,
  findActiveFamilyBinding,
  listActiveBindingsForGroup,
  findActiveCenterBinding,
  findActiveCenterBindingByCenter,
  findActiveCare2goBinding,
};
