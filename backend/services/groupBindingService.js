const { createHash, randomBytes } = require('crypto');
const {
  GroupBindings, GroupBindingTokens, CenterStaff, CareProfiles, Centers, Residents,
  id, now, audit, withTransaction,
} = require('../db');
const centerService = require('./centerService');
const familyService = require('./familyService');
const {
  GROUP_BINDING_TRANSACTION_KEY,
  findActiveFamilyBinding,
  listActiveBindingsForGroup,
  isActiveGroupBinding,
  bindFamilyDestinationInCurrentTransaction,
} = require('./groupBindingRepository');

const TOKEN_TTL_MS = 15 * 60 * 1000;
const CENTER_FAMILY_SOURCE = 'center_issued_family_group';

function makeCode(kind) {
  if (kind === 'center_family') return `CGROUP-${randomBytes(16).toString('hex').toUpperCase()}`;
  const prefix = kind === 'center_staff' ? 'STAFF' : 'FAMILY';
  return `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function hashCode(code) {
  return createHash('sha256').update(normalizeCode(code)).digest('hex');
}

function isLiveToken(token, at = Date.now()) {
  return Boolean(token) && !token.used_at && !token.invalidated_at
    && new Date(token.expires_at).getTime() > at;
}

function isFamilyBindingToken(token) {
  return token?.kind === 'family' || token?.kind === 'center_family';
}

async function findTokenByCode(normalized) {
  if (normalized.startsWith('CGROUP-')) {
    const codeHash = hashCode(normalized);
    const token = await GroupBindingTokens.findOneByField('code_hash', codeHash);
    return token?.kind === 'center_family' ? token : null;
  }
  return GroupBindingTokens.findOneByField('code', normalized);
}

async function validateCenterFamilyEligibility({ centerId, residentId, careProfileId = null, requesterLineId = null }) {
  const center = await Centers.findOne((item) => item.center_id === centerId && item.status === 'active');
  if (!center || !require('./subscriptionService').entitlement(center).allowed) {
    return { ok:false, code:'CENTER_NOT_ELIGIBLE', reason:'ศูนย์นี้ไม่พร้อมสร้างรหัสผูกกลุ่มครอบครัว' };
  }
  if (requesterLineId) {
    const staff = await CenterStaff.findOne((item) => item.center_id === centerId
      && item.line_user_id === requesterLineId && ['owner', 'manager'].includes(item.role)
      && (!item.status || item.status === 'active'));
    if (!staff) return { ok:false, code:'CENTER_MANAGER_REQUIRED', reason:'เฉพาะเจ้าของหรือผู้จัดการศูนย์เท่านั้น' };
  }
  const resident = await Residents.findOne((item) => item.resident_id === residentId
    && item.center_id === centerId && item.status === 'active');
  if (!resident?.care_profile_id || (careProfileId && resident.care_profile_id !== careProfileId)) {
    return { ok:false, code:'RESIDENT_NOT_ELIGIBLE', reason:'ไม่พบผู้พักที่เชื่อม Care Profile ในศูนย์นี้' };
  }
  const profile = await CareProfiles.findOne((item) => item.care_profile_id === resident.care_profile_id
    && item.center_id === centerId && item.status === 'linked');
  if (!profile) return { ok:false, code:'CARE_PROFILE_NOT_ELIGIBLE', reason:'Care Profile ไม่ได้เชื่อมกับศูนย์นี้' };
  const activeRelationships = (await Residents.findWhereByField('care_profile_id', profile.care_profile_id))
    .filter((item) => item.status === 'active');
  if (activeRelationships.length !== 1 || activeRelationships[0].resident_id !== resident.resident_id) {
    return { ok:false, code:'CARE_PROFILE_RELATIONSHIP_CONFLICT', reason:'ความสัมพันธ์ผู้พักกับ Care Profile ไม่พร้อมสำหรับการผูกกลุ่ม' };
  }
  return { ok:true, center, resident, profile };
}

async function createStaffBindingToken(centerId, requesterLineId) {
  const ownerOrManager = await CenterStaff.findOne(
    (s) => s.center_id === centerId && s.line_user_id === requesterLineId
      && ['owner', 'manager'].includes(s.role) && (!s.status || s.status === 'active')
  );
  if (!ownerOrManager) return { ok:false, reason:'เฉพาะเจ้าของหรือผู้จัดการเท่านั้นที่ผูกกลุ่มพนักงานได้' };
  return createToken({ kind:'center_staff', centerId, careProfileId:null, requesterLineId });
}

async function createFamilyBindingToken(careProfileId, requesterLineId) {
  return withTransaction(GROUP_BINDING_TRANSACTION_KEY, async () => {
    const profile = await CareProfiles.findOne(
      (p) => p.care_profile_id === careProfileId && p.owner_line_id === requesterLineId
    );
    if (!profile) return { ok:false, reason:'เฉพาะเจ้าของ Care Profile เท่านั้นที่ผูกกลุ่มครอบครัวได้', code:'FAMILY_OWNER_REQUIRED' };
    if (await findActiveFamilyBinding(careProfileId)) {
      return { ok:false, reason:'Care Profile นี้เชื่อมกลุ่มครอบครัวแล้ว', code:'FAMILY_GROUP_ALREADY_BOUND' };
    }

    const liveTokens = await GroupBindingTokens.findWhere((token) => isFamilyBindingToken(token)
      && token.care_profile_id === careProfileId && isLiveToken(token));
    const reusable = liveTokens.filter((token) => token.kind === 'family' && token.code)
      .sort((a, b) => new Date(b.expires_at) - new Date(a.expires_at))[0] || null;
    if (!reusable && liveTokens.length) {
      return { ok:false, reason:'Care Profile นี้มีรหัสผูกกลุ่มที่ยังใช้งานอยู่', code:'FAMILY_GROUP_CODE_ACTIVE', expiresAt:liveTokens[0].expires_at };
    }
    if (reusable) {
      await GroupBindingTokens.updateAll((token) => isFamilyBindingToken(token)
        && token.care_profile_id === careProfileId && token.token_id !== reusable.token_id
        && !token.used_at && !token.invalidated_at, {
        invalidated_at:now(), invalidated_reason:'superseded', status:'revoked',
      });
      return { ok:true, code:reusable.code, expiresAt:reusable.expires_at, reused:true };
    }
    return createToken({ kind:'family', centerId:null, careProfileId, requesterLineId,
      sourceFlow:'family_owner_code' });
  });
}

async function createCenterFamilyBindingToken({ centerId, residentId, requesterLineId }) {
  return withTransaction(GROUP_BINDING_TRANSACTION_KEY, async () => {
    const eligible = await validateCenterFamilyEligibility({ centerId, residentId, requesterLineId });
    if (!eligible.ok) return eligible;
    const careProfileId = eligible.profile.care_profile_id;
    if (await findActiveFamilyBinding(careProfileId)) {
      return { ok:false, code:'FAMILY_GROUP_ALREADY_BOUND', reason:'Care Profile นี้เชื่อมกลุ่มครอบครัวแล้ว' };
    }
    const live = (await GroupBindingTokens.findWhere((token) => isFamilyBindingToken(token)
      && token.care_profile_id === careProfileId && isLiveToken(token)))
      .sort((a, b) => new Date(b.expires_at) - new Date(a.expires_at))[0] || null;
    if (live) {
      return { ok:false, code:'FAMILY_GROUP_CODE_ACTIVE', reason:'มีรหัสผูกกลุ่มที่ยังใช้งานอยู่ กรุณารอให้หมดอายุหรือยกเลิกรหัสเดิม', expiresAt:live.expires_at };
    }

    const code = makeCode('center_family');
    const token = await GroupBindingTokens.insert({
      token_id:id('GBT'), code_hash:hashCode(code), kind:'center_family', source_flow:CENTER_FAMILY_SOURCE,
      center_id:centerId, care_profile_id:careProfileId, resident_id:eligible.resident.resident_id,
      created_by_line_user_id:requesterLineId, issued_by_line_user_id:requesterLineId,
      created_at:now(), expires_at:new Date(Date.now() + TOKEN_TTL_MS).toISOString(), used_at:null,
      invalidated_at:null, revoked_at:null, status:'active',
    });
    await audit('family_group.center_code_created', requesterLineId, {
      centerId, residentId:eligible.resident.resident_id, careProfileId,
      tokenId:token.token_id, sourceFlow:CENTER_FAMILY_SOURCE, expiresAt:token.expires_at,
    });
    return { ok:true, code, expiresAt:token.expires_at };
  });
}

async function createToken({ kind, centerId, careProfileId, requesterLineId, sourceFlow = null }) {
  const token = await GroupBindingTokens.insert({
    token_id:id('GBT'), code:makeCode(kind), kind, center_id:centerId, care_profile_id:careProfileId,
    created_by_line_user_id:requesterLineId, source_flow:sourceFlow,
    created_at:now(), expires_at:new Date(Date.now() + TOKEN_TTL_MS).toISOString(), used_at:null,
    invalidated_at:null, status:'active',
  });
  return { ok:true, code:token.code, expiresAt:token.expires_at };
}

async function consumeCodeFromGroup({ code, groupId, senderLineId }) {
  const normalized = normalizeCode(code);
  const probe = await findTokenByCode(normalized);
  if (!probe) return { ok:false, reason:'ไม่พบรหัสผูกกลุ่มนี้' };
  const transactionResult = await withTransaction(GROUP_BINDING_TRANSACTION_KEY, async () => {
    const token = await findTokenByCode(normalized);
    if (!token) return { ok:false, reason:'ไม่พบรหัสผูกกลุ่มนี้' };
    if (token.invalidated_at || token.revoked_at || token.status === 'revoked') {
      return { ok:false, reason:'รหัสนี้ถูกยกเลิกแล้ว กรุณาสร้างรหัสใหม่' };
    }
    if (token.used_at) {
      if (token.used_group_id === groupId
        && (token.kind === 'center_family' || token.created_by_line_user_id === senderLineId)) {
        return { ok:true, existing:true, duplicate:true, kind:token.kind,
          centerId:token.center_id, careProfileId:token.care_profile_id, residentId:token.resident_id || null };
      }
      return { ok:false, reason:'รหัสนี้ถูกใช้ไปแล้ว' };
    }
    if (new Date(token.expires_at).getTime() < Date.now()) {
      const expiredAt = now();
      const expirationPatch = { invalidated_at:expiredAt, invalidated_reason:'expired', status:'expired' };
      if (token.kind === 'center_family') expirationPatch.expired_audit_at = expiredAt;
      await GroupBindingTokens.update((item) => item.token_id === token.token_id && !item.used_at && !item.invalidated_at,
        expirationPatch);
      if (token.kind === 'center_family' && !token.expired_audit_at) await audit('family_group.center_code_expired', 'system', {
        centerId:token.center_id, residentId:token.resident_id, careProfileId:token.care_profile_id,
        tokenId:token.token_id, sourceFlow:token.source_flow || null,
      });
      return { ok:false, reason:'รหัสผูกกลุ่มหมดอายุแล้ว กรุณาสร้างรหัสใหม่' };
    }
    if (token.kind !== 'center_family' && token.created_by_line_user_id !== senderLineId) {
      return { ok:false, reason:'ต้องส่งรหัสจากบัญชีที่สร้างรหัสเท่านั้น' };
    }
    if (!groupId) return { ok:false, reason:'ต้องส่งรหัสภายในกลุ่ม LINE เท่านั้น' };

    let eligible = null;
    if (token.kind === 'center_family') {
      eligible = await validateCenterFamilyEligibility({
        centerId:token.center_id, residentId:token.resident_id, careProfileId:token.care_profile_id,
      });
      if (!eligible.ok) return { ...eligible, reason:'Care Profile นี้ไม่พร้อมเชื่อมกลุ่มครอบครัวแล้ว กรุณาขอรหัสใหม่จากศูนย์' };
    }

    const activeForGroup = await listActiveBindingsForGroup(groupId);
    const conflict = isFamilyBindingToken(token)
      ? activeForGroup.find((binding) => binding.kind !== 'family')
      : activeForGroup.find((binding) => binding.kind !== token.kind || binding.center_id !== token.center_id);
    if (conflict) return { ok:false, reason:'กลุ่มนี้ถูกผูกเป็นกลุ่มประเภทอื่นแล้ว' };

    let result;
    if (token.kind === 'center_staff') {
      result = await centerService.bindGroupToCenterInCurrentTransaction({
        centerId:token.center_id, groupId, requesterLineId:senderLineId,
      });
    } else if (token.kind === 'center_family') {
      result = await bindFamilyDestinationInCurrentTransaction({
        careProfileId:token.care_profile_id, groupId, boundByLineUserId:senderLineId,
        sourceFlow:CENTER_FAMILY_SOURCE, sourceCenterId:token.center_id,
      });
    } else {
      result = await familyService.bindFamilyGroupInCurrentTransaction({
        careProfileId:token.care_profile_id, groupId, requesterLineId:senderLineId,
      });
    }
    if (!result.ok) return result;
    await GroupBindingTokens.update((item) => item.token_id === token.token_id && !item.used_at,
      { used_at:now(), used_group_id:groupId, status:'used' });

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
    const auditMeta = token.kind === 'center_family'
      ? { tokenId:token.token_id, kind:'family', centerId:token.center_id, residentId:token.resident_id,
        careProfileId:token.care_profile_id, sourceFlow:CENTER_FAMILY_SOURCE }
      : { groupId, kind:token.kind, centerId:token.center_id, careProfileId:token.care_profile_id };
    await audit(token.kind === 'center_family' ? 'family_group.center_code_consumed' : 'line_group.bound_by_code',
      senderLineId || 'line:webhook', auditMeta);
    if (token.kind === 'center_family') {
      await audit('family_group.bound_via_center_code', senderLineId || 'line:webhook', auditMeta);
    }
    return { ok:true, kind:token.kind, centerId:token.center_id, careProfileId:token.care_profile_id,
      residentId:token.resident_id || eligible?.resident?.resident_id || null,
      memberListAvailable, importedStaffCount };
  });

  if (transactionResult.ok && !transactionResult.duplicate && transactionResult.careProfileId) {
    const resident = transactionResult.residentId
      ? await Residents.findOne((item) => item.resident_id === transactionResult.residentId && item.status === 'active')
      : await Residents.findOne((item) => item.care_profile_id === transactionResult.careProfileId && item.status === 'active');
    if (resident) {
      await require('./deliveryService').deliverPendingForResident(resident.resident_id, transactionResult.careProfileId);
    }
  }
  return transactionResult;
}

async function deactivateGroup(groupId, actorLineId = 'line:webhook') {
  return withTransaction(GROUP_BINDING_TRANSACTION_KEY, async () => {
    const bindings = await listActiveBindingsForGroup(groupId);
    if (!bindings.length) return { ok:false, bindings:[] };
    const unboundAt = now();
    await GroupBindings.updateAll((binding) => binding.line_group_id === groupId && isActiveGroupBinding(binding), {
      status:'inactive', unbound_at:unboundAt,
    });
    for (const binding of bindings) {
      if (binding.kind === 'center_staff' && binding.center_id) {
        await Centers.update((center) => center.center_id === binding.center_id && center.group_id === groupId, { group_id:null });
      }
      await audit('line_group.unbound', actorLineId, { groupId, kind:binding.kind,
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

module.exports = {
  TOKEN_TTL_MS, CENTER_FAMILY_SOURCE, hashCode,
  createStaffBindingToken, createFamilyBindingToken, createCenterFamilyBindingToken,
  consumeCodeFromGroup, deactivateGroup, handleMemberLeft,
};
