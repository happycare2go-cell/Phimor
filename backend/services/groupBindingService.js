const { GroupBindings, GroupBindingTokens, CenterStaff, CareProfiles, Centers, id, now, audit, withTransaction } = require('../db');
const centerService = require('./centerService');
const familyService = require('./familyService');
const {
  GROUP_BINDING_TRANSACTION_KEY,
  findActiveFamilyBinding,
  listActiveBindingsForGroup,
  isActiveGroupBinding,
} = require('./groupBindingRepository');

const TOKEN_TTL_MS = 15 * 60 * 1000;

function makeCode(kind) {
  const prefix = kind === 'center_staff' ? 'STAFF' : 'FAMILY';
  return `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function createStaffBindingToken(centerId, requesterLineId) {
  const ownerOrManager = await CenterStaff.findOne(
    (s) => s.center_id === centerId && s.line_user_id === requesterLineId && ['owner', 'manager'].includes(s.role)
  );
  if (!ownerOrManager) return { ok: false, reason: 'เฉพาะเจ้าของหรือผู้จัดการเท่านั้นที่ผูกกลุ่มพนักงานได้' };
  return createToken({ kind: 'center_staff', centerId, careProfileId: null, requesterLineId });
}

async function createFamilyBindingToken(careProfileId, requesterLineId) {
  return withTransaction(GROUP_BINDING_TRANSACTION_KEY, async () => {
    const profile = await CareProfiles.findOne(
      (p) => p.care_profile_id === careProfileId && p.owner_line_id === requesterLineId
    );
    if (!profile) return { ok: false, reason: 'เฉพาะเจ้าของ Care Profile เท่านั้นที่ผูกกลุ่มครอบครัวได้', code:'FAMILY_OWNER_REQUIRED' };
    if (await findActiveFamilyBinding(careProfileId)) {
      return { ok:false, reason:'Care Profile นี้เชื่อมกลุ่มครอบครัวแล้ว', code:'FAMILY_GROUP_ALREADY_BOUND' };
    }

    const reusable = (await GroupBindingTokens.findWhere((token) => token.kind === 'family'
      && token.care_profile_id === careProfileId && !token.used_at && !token.invalidated_at
      && new Date(token.expires_at).getTime() > Date.now()))
      .sort((a, b) => new Date(b.expires_at) - new Date(a.expires_at))[0] || null;
    if (reusable) {
      await GroupBindingTokens.updateAll((token) => token.kind === 'family'
        && token.care_profile_id === careProfileId && token.token_id !== reusable.token_id
        && !token.used_at && !token.invalidated_at, {
        invalidated_at:now(), invalidated_reason:'superseded',
      });
      return { ok:true, code:reusable.code, expiresAt:reusable.expires_at, reused:true };
    }
    await GroupBindingTokens.updateAll((token) => token.kind === 'family'
      && token.care_profile_id === careProfileId && !token.used_at && !token.invalidated_at, {
      invalidated_at:now(), invalidated_reason:'superseded',
    });
    return createToken({ kind: 'family', centerId: null, careProfileId, requesterLineId });
  });
}

async function createToken({ kind, centerId, careProfileId, requesterLineId }) {
  const token = await GroupBindingTokens.insert({
    token_id: id('GBT'), code: makeCode(kind), kind,
    center_id: centerId, care_profile_id: careProfileId,
    created_by_line_user_id: requesterLineId,
    expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(), used_at: null,
  });
  return { ok: true, code: token.code, expiresAt: token.expires_at };
}

async function consumeCodeFromGroup({ code, groupId, senderLineId }) {
  const normalized = String(code || '').trim().toUpperCase();
  const probe = await GroupBindingTokens.findOne((token) => token.code === normalized);
  if (!probe) return { ok: false, reason: 'ไม่พบรหัสผูกกลุ่มนี้' };
  return withTransaction(GROUP_BINDING_TRANSACTION_KEY, async () => {
    const token = await GroupBindingTokens.findOne((item) => item.code === normalized);
    if (!token) return { ok: false, reason: 'ไม่พบรหัสผูกกลุ่มนี้' };
    if (token.invalidated_at) return { ok:false, reason:'รหัสนี้ถูกยกเลิกแล้ว กรุณาสร้างรหัสใหม่' };
    if (token.used_at) {
      if (token.used_group_id === groupId && token.created_by_line_user_id === senderLineId) {
        return { ok:true, existing:true, duplicate:true, kind:token.kind,
          centerId:token.center_id, careProfileId:token.care_profile_id };
      }
      return { ok: false, reason: 'รหัสนี้ถูกใช้ไปแล้ว' };
    }
    if (new Date(token.expires_at).getTime() < Date.now()) return { ok: false, reason: 'รหัสผูกกลุ่มหมดอายุแล้ว กรุณาสร้างรหัสใหม่' };
    if (token.created_by_line_user_id !== senderLineId) return { ok: false, reason: 'ต้องส่งรหัสจากบัญชีที่สร้างรหัสเท่านั้น' };
    if (!groupId) return { ok:false, reason:'ต้องส่งรหัสภายในกลุ่ม LINE เท่านั้น' };

    const activeForGroup = await listActiveBindingsForGroup(groupId);
    const conflict = token.kind === 'family'
      ? activeForGroup.find((binding) => binding.kind !== 'family')
      : activeForGroup.find((binding) => binding.kind !== token.kind
        || binding.center_id !== token.center_id);
    if (conflict) return { ok: false, reason: 'กลุ่มนี้ถูกผูกเป็นกลุ่มประเภทอื่นแล้ว' };

    let result;
    if (token.kind === 'center_staff') {
      result = await centerService.bindGroupToCenterInCurrentTransaction({ centerId: token.center_id, groupId, requesterLineId: senderLineId });
    } else {
      result = await familyService.bindFamilyGroupInCurrentTransaction({ careProfileId: token.care_profile_id, groupId, requesterLineId: senderLineId });
    }
    if (!result.ok) return result;
    await GroupBindingTokens.update((item) => item.token_id === token.token_id && !item.used_at, { used_at: now(), used_group_id: groupId });
    let importedStaffCount = 0;
    let memberListAvailable = false;
    if (token.kind === 'center_staff') {
      const lineClient = require('../providers/lineClient');
      const members = await lineClient.listGroupMemberUserIds(groupId);
      memberListAvailable = members.available;
      for (const userId of members.userIds || []) {
        const staff = await centerService.recordStaffFromGroup(groupId, userId);
        if (staff) importedStaffCount += 1;
      }
    }
    await audit('line_group.bound_by_code', senderLineId, { groupId, kind: token.kind, centerId: token.center_id, careProfileId: token.care_profile_id });
    return { ok: true, kind: token.kind, centerId: token.center_id, careProfileId: token.care_profile_id,
      memberListAvailable, importedStaffCount };
  });
}

async function deactivateGroup(groupId, actorLineId = 'line:webhook') {
  return withTransaction(GROUP_BINDING_TRANSACTION_KEY, async () => {
    const bindings = await listActiveBindingsForGroup(groupId);
    if (!bindings.length) return { ok: false, bindings:[] };
    const unboundAt = now();
    await GroupBindings.updateAll((binding) => binding.line_group_id === groupId && isActiveGroupBinding(binding), {
      status:'inactive', unbound_at:unboundAt,
    });
    for (const binding of bindings) {
      if (binding.kind === 'center_staff' && binding.center_id) {
        await Centers.update((center) => center.center_id === binding.center_id && center.group_id === groupId, { group_id:null });
      }
      await audit('line_group.unbound', actorLineId, { groupId, kind: binding.kind,
        centerId:binding.center_id, careProfileId:binding.care_profile_id });
    }
    return { ok:true, binding:bindings[0], bindings };
  });
}

async function handleMemberLeft(groupId, userId) {
  return withTransaction(GROUP_BINDING_TRANSACTION_KEY, async () => {
    const bindings = await listActiveBindingsForGroup(groupId);
    if (!bindings.length) return { ok:false };
    const centerBinding = bindings.find((binding) => binding.kind === 'center_staff');
    if (centerBinding) return centerService.removeStaffFromGroup(groupId, userId);
    const affected = [];
    for (const binding of bindings.filter((item) => item.kind === 'family')) {
      const profile = await CareProfiles.findOne((item) => item.care_profile_id === binding.care_profile_id);
      if (profile?.owner_line_id !== userId) continue;
      await GroupBindings.update((item) => item.binding_id === binding.binding_id && isActiveGroupBinding(item, 'family'), {
        status:'inactive', unbound_at:now(), unbound_reason:'profile_owner_left_group',
      });
      await audit('line_group.unbound', userId, { groupId, kind:'family', careProfileId:binding.care_profile_id,
        reason:'profile_owner_left_group' });
      affected.push(binding.care_profile_id);
    }
    return { ok:true, removed:affected.length > 0, affectedCareProfileIds:affected };
  });
}

module.exports = { createStaffBindingToken, createFamilyBindingToken, consumeCodeFromGroup, deactivateGroup, handleMemberLeft };
