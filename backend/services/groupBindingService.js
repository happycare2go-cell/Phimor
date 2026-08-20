const { GroupBindings, GroupBindingTokens, CenterStaff, CareProfiles, Centers, id, now, audit } = require('../db');
const centerService = require('./centerService');
const familyService = require('./familyService');

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
  const profile = await CareProfiles.findOne(
    (p) => p.care_profile_id === careProfileId && p.owner_line_id === requesterLineId
  );
  if (!profile) return { ok: false, reason: 'เฉพาะเจ้าของ Care Profile เท่านั้นที่ผูกกลุ่มครอบครัวได้' };
  return createToken({ kind: 'family', centerId: null, careProfileId, requesterLineId });
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
  const token = await GroupBindingTokens.findOne((t) => t.code === normalized);
  if (!token) return { ok: false, reason: 'ไม่พบรหัสผูกกลุ่มนี้' };
  if (token.used_at) return { ok: false, reason: 'รหัสนี้ถูกใช้ไปแล้ว' };
  if (new Date(token.expires_at).getTime() < Date.now()) return { ok: false, reason: 'รหัสผูกกลุ่มหมดอายุแล้ว กรุณาสร้างรหัสใหม่' };
  if (token.created_by_line_user_id !== senderLineId) return { ok: false, reason: 'ต้องส่งรหัสจากบัญชีที่สร้างรหัสเท่านั้น' };

  const conflict = await GroupBindings.findOne(
    (g) => g.line_group_id === groupId && g.status !== 'inactive'
      && (g.kind !== token.kind || g.center_id !== token.center_id || g.care_profile_id !== token.care_profile_id)
  );
  if (conflict) return { ok: false, reason: 'กลุ่มนี้ถูกผูกเป็นกลุ่มประเภทอื่นแล้ว' };

  let result;
  if (token.kind === 'center_staff') {
    result = await centerService.bindGroupToCenter({ centerId: token.center_id, groupId, requesterLineId: senderLineId });
  } else {
    result = await familyService.bindFamilyGroup({ careProfileId: token.care_profile_id, groupId, requesterLineId: senderLineId });
  }
  if (!result.ok) return result;
  await GroupBindingTokens.update((t) => t.token_id === token.token_id, { used_at: now(), used_group_id: groupId });
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
}

async function deactivateGroup(groupId, actorLineId = 'line:webhook') {
  const binding = await GroupBindings.findOne((g) => g.line_group_id === groupId && g.status !== 'inactive');
  if (!binding) return { ok: false };
  await GroupBindings.update((g) => g.binding_id === binding.binding_id, { status: 'inactive', unbound_at: now() });
  if (binding.kind === 'center_staff' && binding.center_id) {
    await Centers.update((c) => c.center_id === binding.center_id && c.group_id === groupId, { group_id: null });
  }
  await audit('line_group.unbound', actorLineId, { groupId, kind: binding.kind, centerId: binding.center_id, careProfileId: binding.care_profile_id });
  return { ok: true, binding };
}

async function handleMemberLeft(groupId, userId) {
  const binding = await GroupBindings.findOne((g) => g.line_group_id === groupId && g.status !== 'inactive');
  if (!binding) return { ok: false };
  if (binding.kind === 'center_staff') return centerService.removeStaffFromGroup(groupId, userId);
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === binding.care_profile_id);
  if (profile?.owner_line_id === userId) return deactivateGroup(groupId, userId);
  return { ok: true, removed: false };
}

module.exports = { createStaffBindingToken, createFamilyBindingToken, consumeCodeFromGroup, deactivateGroup, handleMemberLeft };
