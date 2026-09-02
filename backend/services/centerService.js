// services/centerService.js — FR-A (ตั้งค่าศูนย์), FR-B (ทะเบียนผู้พัก), FR-J1/J2 (นำเข้าข้อมูล)

const { Centers, CenterStaff, StaffContexts, Residents, CareProfiles, Invites, GroupBindings, GroupBindingTokens, audit, id, now, withTransaction } = require('../db');
const { GROUP_BINDING_TRANSACTION_KEY, findActiveFamilyBinding, findActiveCenterBinding, listActiveBindingsForGroup, isActiveGroupBinding } = require('./groupBindingRepository');
const richMenuService = require('./richMenuService');
const { addBangkokCalendarMonth } = require('./subscriptionService');

const INVITE_EXPIRY_DAYS = 30; // ตาม Technical Design หมวด 9

/** เชื่อม Rich Menu ฝั่งศูนย์แบบไม่บล็อก Flow หลัก — ตามที่วิเคราะห์ไว้ Rich Menu ไม่ใช่ของที่ขาดไม่ได้
 *  ถ้าล้มเหลว (เช่น ผู้ใช้ยังไม่ได้เพิ่มเพื่อน OA) ให้ log ไว้เฉยๆ ไม่ทำให้การสร้างศูนย์/แต่งตั้งพัง */
function linkMenuBestEffort(lineUserId) {
  richMenuService.linkCenterMenuToUser(lineUserId).catch((err) => {
    console.error(`เชื่อม Rich Menu ให้ ${lineUserId} ไม่สำเร็จ (ไม่กระทบการทำงานหลัก):`, err.message);
  });
}

// ── FR-A1: ทีมงานสร้างบัญชีศูนย์ ──
async function createCenter({
  name, ownerLineId, address = '', contactPhone = '',
  subscriptionRequired = process.env.NODE_ENV !== 'test', selfRegistrationTrial = false,
}) {
  return withTransaction(`center-create:${ownerLineId}:${name}`, async () => {
    const registrationTime = now();
    const trialEnd = selfRegistrationTrial ? addBangkokCalendarMonth(registrationTime).toISOString() : null;
    const center = await Centers.insert({
      center_id: id('CTR'),
      name,
      address: address || '', contact_phone: contactPhone || '',
      owner_line_id: ownerLineId,
      group_id: null,
      external_api_key: id('EXT'), // deprecated compatibility credential; never project to Center users
      status: 'active',
      subscription_required: selfRegistrationTrial ? true : !!subscriptionRequired,
      subscription_package_type: selfRegistrationTrial ? 'trial' : null,
      subscription_start_at: selfRegistrationTrial ? registrationTime : null,
      subscription_end_at: trialEnd,
      created_at: registrationTime,
    });
    await CenterStaff.insert({
      staff_id: id('STF'),
      center_id: center.center_id,
      line_user_id: ownerLineId,
      role: 'owner',
      status: 'active',
      assigned_at: now(),
    });
    // Migration 0008 must be applied before this code is deployed. Existing
    // unit tests use the in-memory legacy database and exercise P0 separately.
    if (process.env.NODE_ENV !== 'test') {
      await require('./platformService').platformService.ensureOrganizationForCenter({
        centerId: center.center_id, displayName: center.name, actorReference: 'system:center-create',
      });
    }
    linkMenuBestEffort(ownerLineId);
    return center;
  });
}

async function updateCenterSettings({ centerId, requesterLineId, address, contactPhone }) {
  const owner = await CenterStaff.findOne((s) => s.center_id === centerId && s.line_user_id === requesterLineId && s.role === 'owner');
  if (!owner) return { ok:false, reason:'เฉพาะเจ้าของศูนย์เท่านั้นที่แก้ไขข้อมูลติดต่อได้' };
  const patch = {};
  if (typeof address === 'string') patch.address = address.trim();
  if (typeof contactPhone === 'string') patch.contact_phone = contactPhone.trim();
  const center = await Centers.update((c) => c.center_id === centerId && c.status === 'active', patch);
  if (!center) return { ok:false, reason:'ไม่พบศูนย์' };
  await audit('center.settings_updated', requesterLineId, { centerId, changedFields:Object.keys(patch) });
  return { ok:true, center };
}

// ── FR-A2, A3: ผูกกลุ่มไลน์งานศูนย์ (ต้องเป็นเจ้าของ/ผู้จัดการเป็นผู้เชิญ) ──
async function bindGroupToCenterInCurrentTransaction({ centerId, groupId, requesterLineId }) {
  const staff = await CenterStaff.findOne(
    (s) => s.center_id === centerId && s.line_user_id === requesterLineId && ['owner', 'manager'].includes(s.role)
  );
  if (!staff) {
    return { ok: false, reason: 'ผู้เชิญไม่มีสิทธิ์เจ้าของหรือผู้จัดการของศูนย์นี้' };
  }
  const previous = await GroupBindings.findOne(
    (g) => isActiveGroupBinding(g, 'center_staff') && g.center_id === centerId
  );
  const groupUsedElsewhere = (await listActiveBindingsForGroup(groupId)).find(
    (g) => !(g.kind === 'center_staff' && g.center_id === centerId)
  );
  if (groupUsedElsewhere) return { ok: false, reason: 'กลุ่มนี้ถูกผูกกับศูนย์หรือ Care Profile อื่นแล้ว' };

  const alreadyBound = !!previous && previous.line_group_id !== groupId;
  if (previous && previous.line_group_id !== groupId) {
    await GroupBindings.update(
      (g) => g.binding_id === previous.binding_id,
      { status: 'inactive', unbound_at: now() }
    );
  }
  if (!previous || previous.line_group_id !== groupId) {
    await GroupBindings.insert({
      binding_id: id('GB'), kind: 'center_staff', center_id: centerId,
      care_profile_id: null, line_group_id: groupId, status: 'active',
      bound_by_line_user_id: requesterLineId, bound_at: now(),
    });
  }
  // เก็บ field เดิมไว้เพื่อให้ deployment เก่าและข้อมูลเดิมยังทำงานระหว่างเปลี่ยนผ่าน
  await Centers.update((c) => c.center_id === centerId, { group_id: groupId });
  await audit('center.group_bound', requesterLineId, { centerId, groupId, replacedPrevious: alreadyBound });
  return { ok: true, replacedPrevious: alreadyBound };
}

async function bindGroupToCenter(input) {
  return withTransaction(GROUP_BINDING_TRANSACTION_KEY, () => bindGroupToCenterInCurrentTransaction(input));
}

async function findCenterByGroup(groupId) {
  const binding = await findActiveCenterBinding(groupId);
  if (binding) {
    const center = await Centers.findOne((c) => c.center_id === binding.center_id && c.status === 'active');
    return require('./subscriptionService').entitlement(center).allowed ? center : null;
  }
  if ((await listActiveBindingsForGroup(groupId)).length) return null;
  const center = await Centers.findOne((c) => c.group_id === groupId && c.status === 'active');
  return require('./subscriptionService').entitlement(center).allowed ? center : null;
}

// ── FR-A4: แต่งตั้ง/ถอดถอนผู้จัดการ (เฉพาะเจ้าของ) ──
async function appointManager({ centerId, targetLineId, requesterLineId }) {
  const requester = await CenterStaff.findOne(
    (s) => s.center_id === centerId && s.line_user_id === requesterLineId && s.role === 'owner'
  );
  if (!requester) return { ok: false, reason: 'เฉพาะเจ้าของศูนย์เท่านั้นที่แต่งตั้งผู้จัดการได้' };

  const already = await CenterStaff.findOne((s) => s.center_id === centerId && s.line_user_id === targetLineId);
  if (already?.role === 'owner') return { ok: false, reason: 'ผู้ใช้นี้เป็นเจ้าของศูนย์อยู่แล้ว' };
  if (already?.role === 'manager') return { ok: false, reason: 'ผู้ใช้นี้เป็นผู้จัดการอยู่แล้ว' };

  if (already?.role === 'staff') {
    const promoted = await CenterStaff.update(
      (s) => s.center_id === centerId && s.line_user_id === targetLineId,
      { role: 'manager', promoted_at: now() }
    );
    linkMenuBestEffort(targetLineId);
    await audit('center.manager_appointed', requesterLineId, { centerId, targetLineId, promotedExistingStaff: true });
    return { ok: true, staff: promoted };
  }

  const staff = await CenterStaff.insert({
    staff_id: id('STF'), center_id: centerId, line_user_id: targetLineId, role: 'manager', assigned_at: now(),
  });
  linkMenuBestEffort(targetLineId);
  await audit('center.manager_appointed', requesterLineId, { centerId, targetLineId });
  return { ok: true, staff };
}

async function removeManager({ centerId, targetLineId, requesterLineId }) {
  const requester = await CenterStaff.findOne(
    (s) => s.center_id === centerId && s.line_user_id === requesterLineId && s.role === 'owner'
  );
  if (!requester) return { ok: false, reason: 'เฉพาะเจ้าของศูนย์เท่านั้นที่ถอดถอนผู้จัดการได้' };

  const removed = await CenterStaff.update(
    (s) => s.center_id === centerId && s.line_user_id === targetLineId && s.role === 'manager'
    , { role: 'staff', demoted_at: now() }
  );
  if (removed) await audit('center.manager_removed', requesterLineId, { centerId, targetLineId });
  return { ok: removed };
}

async function listStaff(centerId) {
  const rows = await CenterStaff.findWhere((s) => s.center_id === centerId);
  const unique = new Map();
  const rank = (s) => ({ owner:3, manager:2, staff:1 }[s.role] || 0) + ((!s.status || s.status === 'active') ? 10 : 0);
  for (const row of rows) {
    const previous = unique.get(row.line_user_id);
    if (!previous || rank(row) > rank(previous)) unique.set(row.line_user_id, row);
  }
  return [...unique.values()];
}

// ── ทะเบียนพนักงานอัตโนมัติ ──
// LINE ไม่มี API ให้ค้นย้อนว่า "ผู้ใช้คนนี้อยู่กลุ่มไหนบ้าง" จึงต้องเก็บเองจาก Event ที่เกิดในกลุ่มงานศูนย์
// พนักงานทักอะไรก็ได้ในกลุ่มครั้งเดียว ระบบจะจำได้ว่าเป็นพนักงานของศูนย์ใด แล้วส่งรูปในแชทส่วนตัวได้ตลอดไป
async function recordStaffFromGroup(groupId, lineUserId) {
  if (!groupId || !lineUserId) return null;
  const center = await findCenterByGroup(groupId);
  if (!center) return null;

  const existing = await CenterStaff.findOne((s) => s.center_id === center.center_id && s.line_user_id === lineUserId);
  if (existing) {
    if (existing.status === 'revoked') {
      const requireApproval = process.env.REQUIRE_STAFF_APPROVAL === 'true' || (process.env.NODE_ENV !== 'test' && process.env.REQUIRE_STAFF_APPROVAL !== 'false');
      const restored = await CenterStaff.update((s) => s.staff_id === existing.staff_id, {
        role: 'staff', status: requireApproval ? 'pending' : 'active',
        rejoined_group_at: now(), revoked_at: null, revoked_by: null, revoke_reason: null,
      });
      await audit('center.staff_rejoined', lineUserId, { centerId: center.center_id, requiresApproval: requireApproval });
      if (!requireApproval) {
        linkMenuBestEffort(lineUserId);
        await setActiveCenterForStaff(lineUserId, center.center_id);
      }
      return restored;
    }
    if (existing.status === 'pending') return existing;
    linkMenuBestEffort(lineUserId);
    await setActiveCenterForStaff(lineUserId, center.center_id);
    return existing;
  }

  const lineClient = require('../providers/lineClient');
  const profile = await lineClient.getGroupMemberProfile(groupId, lineUserId);
  const requireApproval = process.env.REQUIRE_STAFF_APPROVAL === 'true' || (process.env.NODE_ENV !== 'test' && process.env.REQUIRE_STAFF_APPROVAL !== 'false');

  const staff = await CenterStaff.insert({
    staff_id: id('STF'), center_id: center.center_id, line_user_id: lineUserId,
    display_name: profile?.displayName || null, picture_url: profile?.pictureUrl || null,
    role: 'staff', status: requireApproval ? 'pending' : 'active', joined_group_at: now(),
    assigned_at: requireApproval ? null : now(), auto_registered: true,
  });
  if (requireApproval) await audit('center.staff_pending_approval', lineUserId, { centerId: center.center_id, groupId });
  else { linkMenuBestEffort(lineUserId); await setActiveCenterForStaff(lineUserId, center.center_id); }
  return staff;
}

async function createCenterManagedCareProfile({ centerId, residentId, profileData = {}, requesterLineId }) {
  return withTransaction(`center-care-profile:${residentId}`, async () => {
    const resident = await Residents.findOne((r) => r.resident_id === residentId && r.center_id === centerId && r.status === 'active');
    if (!resident) return { ok:false, reason:'ไม่พบผู้พักในสาขานี้' };
    if (resident.care_profile_id) return { ok:false, reason:'ผู้พักรายนี้มี Care Profile แล้ว' };
    const profile = await CareProfiles.insert({
      care_profile_id:id('CP'), owner_line_id:null, patient_name:resident.full_name,
      center_id:centerId, family_phone:profileData.familyPhone || resident.family_phone || null,
      status:'linked', managed_by_center:true,
      gender:profileData.gender || null, blood_type:profileData.bloodType || null,
      height_cm:profileData.heightCm ? Number(profileData.heightCm) : null,
      weight_kg:profileData.weightKg ? Number(profileData.weightKg) : null,
      chronic_conditions:Array.isArray(profileData.chronicConditions) ? profileData.chronicConditions : [],
      drug_allergies:profileData.drugAllergies || '', food_allergies:profileData.foodAllergies || '',
      mobility_limitations:profileData.mobilityLimitations || '',
      emergency_contact_name:profileData.emergencyContactName || '',
      emergency_contact_phone:profileData.emergencyContactPhone || '',
      created_by_center_user_id:requesterLineId, created_at:now(),
    });
    await Residents.update((r) => r.resident_id === residentId && !r.care_profile_id, { care_profile_id:profile.care_profile_id, link_status:'center_managed' });
    await audit('care_profile.created_by_center', requesterLineId, { centerId, residentId, careProfileId:profile.care_profile_id });
    return { ok:true, profile };
  });
}

async function getOrCreateResidentInvite({ centerId, residentId, requesterLineId = 'center:legacy' }) {
  return withTransaction(`ownership-claim:resident:${residentId}`, async () => {
    const resident = await Residents.findOne((item) => item.resident_id === residentId
      && item.center_id === centerId && item.status === 'active');
    if (!resident) return { ok:false, reason:'ไม่พบผู้พักในสาขานี้' };
    if (resident.care_profile_id) {
      const profile = await CareProfiles.findOne((item) => item.care_profile_id === resident.care_profile_id);
      if (profile?.owner_line_id) return { ok:false, reason:'Care Profile นี้มีเจ้าของครอบครัวแล้ว' };
    }
    let invite = await Invites.findOne((item) => item.resident_id === residentId && item.status === 'active'
      && !item.used_at && new Date(item.expires_at) > new Date());
    let created = false;
    if (!invite) {
      invite = await Invites.insert({ invite_token:id('INV'), resident_id:residentId,
        expires_at:new Date(Date.now() + INVITE_EXPIRY_DAYS * 86400000).toISOString(),
        used_at:null, status:'active', revoked_at:null, source_flow:'center_ownership_claim',
        issued_by_line_user_id:requesterLineId, issued_at:now() });
      created = true;
      await audit('family.ownership_claim_link_issued', requesterLineId, {
        centerId, residentId, careProfileId:resident.care_profile_id || null,
        sourceFlow:'center_ownership_claim', expiresAt:invite.expires_at,
      });
    }
    return { ok:true, inviteUrl:`https://liff.line.me/${process.env.LIFF_ID_FAMILY || 'YOUR_LIFF_ID'}?token=${encodeURIComponent(invite.invite_token)}`,
      inviteExpiresAt:invite.expires_at, created };
  });
}

async function approveStaff({ centerId, targetLineId, requesterLineId, role = 'staff' }) {
  const requester = await CenterStaff.findOne((s) => s.center_id === centerId && s.line_user_id === requesterLineId && s.role === 'owner' && (!s.status || s.status === 'active'));
  if (!requester) return { ok: false, reason: 'เฉพาะเจ้าของศูนย์เท่านั้นที่อนุมัติพนักงานได้' };
  if (!['staff', 'manager'].includes(role)) return { ok: false, reason: 'บทบาทไม่ถูกต้อง' };
  const member = await CenterStaff.update((s) => s.center_id === centerId && s.line_user_id === targetLineId && s.status === 'pending', { status: 'active', role, assigned_at: now(), approved_by: requesterLineId });
  if (!member) return { ok: false, reason: 'ไม่พบสมาชิกที่รออนุมัติ' };
  linkMenuBestEffort(targetLineId);
  await setActiveCenterForStaff(targetLineId, centerId);
  await audit('center.staff_approved', requesterLineId, { centerId, targetLineId, role });
  return { ok: true, staff: member };
}

async function revokeStaff({ centerId, targetLineId, requesterLineId, reason = '' }) {
  const requester = await CenterStaff.findOne((s) => s.center_id === centerId && s.line_user_id === requesterLineId && s.role === 'owner' && (!s.status || s.status === 'active'));
  if (!requester) return { ok: false, reason: 'เฉพาะเจ้าของศูนย์เท่านั้นที่ถอนสิทธิ์พนักงานได้' };
  const target = await CenterStaff.findOne((s) => s.center_id === centerId && s.line_user_id === targetLineId);
  if (!target || target.role === 'owner') return { ok: false, reason: 'ไม่สามารถถอนสิทธิ์รายการนี้ได้' };
  const member = await CenterStaff.update((s) => s.staff_id === target.staff_id, { status: 'revoked', revoked_at: now(), revoked_by: requesterLineId, revoke_reason: String(reason || '').slice(0, 500) });
  await StaffContexts.remove((c) => c.line_user_id === targetLineId && c.center_id === centerId);
  await audit('center.staff_revoked', requesterLineId, { centerId, targetLineId, previousRole: target.role, reason });
  return { ok: true, staff: member };
}

async function transferOwner({ centerId, newOwnerLineId, actor = 'admin', keepPreviousAsManager = false }) {
  return withTransaction(`center-owner:${centerId}`, async () => {
    const center = await Centers.findOne((c) => c.center_id === centerId);
    if (!center) return { ok:false, reason:'ไม่พบศูนย์นี้' };
    const oldOwner = await CenterStaff.findOne((s) => s.center_id === centerId && s.role === 'owner' && (!s.status || s.status === 'active'));
    let target = await CenterStaff.findOne((s) => s.center_id === centerId && s.line_user_id === newOwnerLineId);
    if (target) target = await CenterStaff.update((s) => s.staff_id === target.staff_id, { role:'owner', status:'active', ownership_started_at:now(), approved_by:actor });
    else target = await CenterStaff.insert({ staff_id:id('STF'), center_id:centerId, line_user_id:newOwnerLineId, role:'owner', status:'active', assigned_at:now(), ownership_started_at:now(), approved_by:actor });
    if (oldOwner && oldOwner.line_user_id !== newOwnerLineId) await CenterStaff.update((s) => s.staff_id === oldOwner.staff_id, keepPreviousAsManager ? { role:'manager', status:'active', ownership_ended_at:now() } : { role:'owner_previous', status:'revoked', ownership_ended_at:now(), revoked_by:actor, revoke_reason:'ownership_transferred' });
    const updated = await Centers.update((c) => c.center_id === centerId, { owner_line_id:newOwnerLineId, owner_transferred_at:now(), owner_transferred_by:actor });
    await audit('center.owner_transferred', actor, { centerId, previousOwnerLineId:oldOwner?.line_user_id || center.owner_line_id, newOwnerLineId, keepPreviousAsManager });
    linkMenuBestEffort(newOwnerLineId);
    return { ok:true, center:updated, owner:target };
  });
}

async function reconcileAllCenterStaff() {
  const centers = await Centers.findWhere((c) => c.status === 'active' && c.group_id);
  let checked = 0; let revoked = 0;
  const lineClient = require('../providers/lineClient');
  for (const center of centers) {
    const result = await lineClient.listGroupMemberUserIds(center.group_id);
    if (!result.available) continue;
    const actual = new Set(result.userIds);
    const members = await CenterStaff.findWhere((s) => s.center_id === center.center_id && s.role !== 'owner' && (!s.status || ['active','pending'].includes(s.status)));
    for (const member of members) {
      checked += 1;
      if (!actual.has(member.line_user_id)) {
        await CenterStaff.update((s) => s.staff_id === member.staff_id, { status:'revoked', revoked_at:now(), revoked_by:'system:group_reconciliation', revoke_reason:'not_in_staff_group' });
        await StaffContexts.remove((c) => c.line_user_id === member.line_user_id && c.center_id === center.center_id);
        await audit('center.staff_reconciled_revoked', 'system', { centerId:center.center_id, targetLineId:member.line_user_id });
        revoked += 1;
      }
    }
  }
  return { centers:centers.length, checked, revoked };
}

async function setActiveCenterForStaff(lineUserId, centerId) {
  const membership = await CenterStaff.findOne((s) => s.line_user_id === lineUserId && s.center_id === centerId && (!s.status || s.status === 'active'));
  if (!membership) return { ok: false, reason: 'ผู้ใช้ไม่มีสิทธิ์ในสาขานี้' };
  const existing = await StaffContexts.findOne((c) => c.line_user_id === lineUserId);
  if (existing) await StaffContexts.update((c) => c.line_user_id === lineUserId, { center_id: centerId, selected_at: now() });
  else await StaffContexts.insert({ context_id: id('CTX'), line_user_id: lineUserId, center_id: centerId, selected_at: now() });
  return { ok: true };
}

async function getActiveCenterIdForStaff(lineUserId) {
  const context = await StaffContexts.findOne((row) => row.line_user_id === lineUserId);
  if (!context?.center_id) return null;
  const membership = await CenterStaff.findOne((row) => row.line_user_id === lineUserId
    && row.center_id === context.center_id && (!row.status || row.status === 'active'));
  return membership ? context.center_id : null;
}

async function listCentersByStaffUser(lineUserId) {
  const memberships = await CenterStaff.findWhere((s) => s.line_user_id === lineUserId && (!s.status || s.status === 'active'));
  const centers = [];
  for (const membership of memberships) {
    const center = await Centers.findOne((c) => c.center_id === membership.center_id && c.status === 'active');
    if (center && require('./subscriptionService').entitlement(center).allowed && membership.status !== 'revoked' && membership.status !== 'pending') centers.push({ ...center, role: membership.role });
  }
  return centers;
}

/** ถอนสิทธิ์สาขาทันทีเมื่อออกจากกลุ่มพนักงาน เจ้าของต้องโอนสิทธิ์/ปิดศูนย์ด้วยขั้นตอนเฉพาะ */
async function removeStaffFromGroup(groupId, lineUserId) {
  if (!groupId || !lineUserId) return { removed: false };
  const center = await findCenterByGroup(groupId);
  if (!center) return { removed: false };
  const member = await CenterStaff.findOne(
    (s) => s.center_id === center.center_id && s.line_user_id === lineUserId
  );
  if (!member || member.role === 'owner') return { removed: false, preservedOwner: member?.role === 'owner' };
  const removed = await CenterStaff.remove(
    (s) => s.center_id === center.center_id && s.line_user_id === lineUserId && s.role !== 'owner'
  );
  const context = await StaffContexts.findOne((c) => c.line_user_id === lineUserId && c.center_id === center.center_id);
  if (removed && context) await StaffContexts.remove((c) => c.line_user_id === lineUserId && c.center_id === center.center_id);
  if (removed) await audit('center.staff_left_group', lineUserId, { centerId: center.center_id, groupId, previousRole: member.role });
  if (removed) {
    const remaining = await CenterStaff.findWhere((s) => s.line_user_id === lineUserId);
    if (remaining.length === 0) {
      const lineClient = require('../providers/lineClient');
      lineClient.unlinkRichMenuFromUser(lineUserId).catch((err) => console.error('คืน Rich Menu เริ่มต้นไม่สำเร็จ:', err.message));
    }
  }
  return { removed, centerId: center.center_id };
}

/** หาศูนย์ที่ผู้ใช้คนนี้สังกัด — ใช้ตอนพนักงานส่งรูปในแชทส่วนตัว */
async function findCenterByStaffUser(lineUserId) {
  const centers = await listCentersByStaffUser(lineUserId);
  if (centers.length === 0) return null;
  if (centers.length === 1) return centers[0];
  const context = await StaffContexts.findOne((c) => c.line_user_id === lineUserId);
  return centers.find((c) => c.center_id === context?.center_id) || null;
}

/** รายชื่อเจ้าของและผู้จัดการของศูนย์ — ใช้ส่งการ์ดยืนยันเข้าแชทส่วนตัวของแต่ละคน */
async function listApprovers(centerId) {
  return CenterStaff.findWhere((s) => s.center_id === centerId && ['owner', 'manager'].includes(s.role) && (!s.status || s.status === 'active'));
}

/** ตรวจว่าผู้ใช้มีสิทธิ์ยืนยันการ์ดของศูนย์นี้ไหม (เฉพาะเจ้าของและผู้จัดการ) */
async function canApprove(centerId, lineUserId) {
  const staff = await CenterStaff.findOne(
    (s) => s.center_id === centerId && s.line_user_id === lineUserId && ['owner', 'manager'].includes(s.role) && (!s.status || s.status === 'active')
  );
  return !!staff;
}

// ── FR-B2, B3, B7: เพิ่มผู้พัก + ชื่ออื่นที่ใช้ + สร้างลิงก์เชิญ ──
// familyPhone is contact information only. Existing-profile linking now uses
// an explicit anonymous Center link; phone numbers are never identity proof.
async function addResident({ centerId, fullName, aliases = [], room, familyPhone }) {
  const duplicate = await Residents.findOne((r) => r.center_id === centerId && r.status === 'active' && r.full_name.trim() === fullName.trim());
  if (duplicate) return { ok: false, reason: 'มีผู้พักชื่อนี้อยู่ในสาขาแล้ว', duplicate };
  const resident = await Residents.insert({
    resident_id: id('R'),
    center_id: centerId,
    full_name: fullName,
    aliases,
    room: room || null,
    family_phone: familyPhone || null,
    care_profile_id: null,
    status: 'active', // active | discharged
    created_at: now(),
  });

  const invite = await Invites.insert({
    invite_token: id('INV'),
    resident_id: resident.resident_id,
    expires_at: new Date(Date.now() + INVITE_EXPIRY_DAYS * 86400000).toISOString(),
    used_at: null, status: 'active', revoked_at: null,
  });

  return {
    ok: true, resident, inviteUrl: `https://liff.line.me/${process.env.LIFF_ID_FAMILY || 'YOUR_LIFF_ID'}?token=${encodeURIComponent(invite.invite_token)}`, inviteExpiresAt: invite.expires_at,
    accessRequestSent:false, accessRequestId:null,
  };
}

// ── FR-B4: แก้ไขข้อมูลผู้พัก ──
function createResidentUpdater(overrides = {}) {
  const residents = overrides.Residents || Residents;
  const profiles = overrides.CareProfiles || CareProfiles;
  const runTransaction = overrides.withTransaction || withTransaction;
  const recordAudit = overrides.audit || audit;

  return async function updateResident(centerId, residentId, patch, requesterLineId = null) {
    const allowed = ['full_name', 'aliases', 'room', 'family_phone'];
    const clean = {};
    for (const key of allowed) if (key in patch) clean[key] = patch[key];
    const synchronizesName = Object.hasOwn(clean, 'full_name');

    return runTransaction(`resident-update:${residentId}`, async () => {
      // Read the relationship first so linked rows can be locked in the same
      // Care Profile -> Resident order used by Integration identity learning.
      const snapshot = await residents.findOneByField('resident_id', residentId);
      if (!snapshot || snapshot.center_id !== centerId || snapshot.status !== 'active') return null;

      let profile = null;
      if (synchronizesName && snapshot.care_profile_id) {
        profile = await profiles.findOneByFieldForUpdate('care_profile_id', snapshot.care_profile_id);
        if (!profile) return null;
      }
      const resident = await residents.findOneByFieldForUpdate('resident_id', residentId);
      if (!resident || resident.center_id !== centerId || resident.status !== 'active') return null;
      if (synchronizesName && resident.care_profile_id !== snapshot.care_profile_id) {
        const error = new Error('Resident relationship changed during update');
        error.code = 'RESIDENT_RELATIONSHIP_CHANGED';
        throw error;
      }

      const residentNameChanged = synchronizesName && resident.full_name !== clean.full_name;
      const profileNameChanged = Boolean(profile && profile.patient_name !== clean.full_name);
      const updated = await residents.update((row) => row.resident_id === residentId
        && row.center_id === centerId && row.status === 'active', clean);
      if (!updated) {
        const error = new Error('Resident update conflict');
        error.code = 'RESIDENT_UPDATE_CONFLICT';
        throw error;
      }
      if (profileNameChanged) {
        const synced = await profiles.update((row) => row.care_profile_id === resident.care_profile_id,
          { patient_name:clean.full_name });
        if (!synced) {
          const error = new Error('Care Profile update conflict');
          error.code = 'CARE_PROFILE_UPDATE_CONFLICT';
          throw error;
        }
      }
      if (profile && (residentNameChanged || profileNameChanged)) {
        await recordAudit('resident.identity_name_synced', requesterLineId || 'system:resident_update', {
          centerId, residentId, careProfileId:resident.care_profile_id,
          residentNameChanged, careProfileNameChanged:profileNameChanged,
        });
      }
      return updated;
    });
  };
}

const updateResident = createResidentUpdater();

// ── FR-B5, B6: จำหน่ายผู้พักออก — เพิกถอนสิทธิ์ศูนย์ทันที แต่ Care Profile ยังอยู่กับครอบครัว ──
// เชื่อมกับ FR-N6: Care Profile ต้องเปลี่ยนเป็นสถานะอิสระโดยอัตโนมัติ
async function dischargeResident(centerId, residentId, requesterLineId) {
  // Backwards-compatible internal signature: dischargeResident(residentId, actor).
  // HTTP routes always pass centerId explicitly; deriving here is safe for old
  // internal callers but never authorizes a cross-center request.
  if (requesterLineId === undefined) {
    requesterLineId = residentId;
    residentId = centerId;
    const existing = await Residents.findOne((r) => r.resident_id === residentId);
    centerId = existing?.center_id;
  }
  const transition = await withTransaction(GROUP_BINDING_TRANSACTION_KEY, async () => {
    const resident = await Residents.findOne((item) => item.resident_id === residentId
      && item.center_id === centerId && item.status === 'active');
    if (!resident) return { ok:false, reason:'ไม่พบผู้พัก' };
    await Residents.update((item) => item.resident_id === residentId && item.center_id === centerId
      && item.status === 'active', { status:'discharged', discharged_at:now() });
    await Invites.updateAll((item) => item.resident_id === residentId && !item.used_at && item.status !== 'revoked',
      { status:'revoked', revoked_at:now(), revoke_reason:'resident_discharged' });
    const revokedAt = now();
    const revokedCodes = await GroupBindingTokens.updateAll((item) => item.kind === 'center_family'
      && item.resident_id === residentId && !item.used_at && !item.invalidated_at && !item.revoked_at,
    { status:'revoked', revoked_at:revokedAt, invalidated_at:revokedAt, invalidated_reason:'resident_discharged' });
    if (revokedCodes.length) await audit('family_group.center_code_revoked', requesterLineId, {
      centerId, residentId, careProfileId:resident.care_profile_id || null,
      sourceFlow:'center_issued_family_group', reason:'resident_discharged', count:revokedCodes.length,
    });
    if (!resident.care_profile_id) return { ok:true, resident, careProfile:null, target:null };
    await CareProfiles.update((item) => item.care_profile_id === resident.care_profile_id,
      { center_id:null, status:'independent' });
    const groupBinding = await findActiveFamilyBinding(resident.care_profile_id);
    const careProfile = await CareProfiles.findOne((item) => item.care_profile_id === resident.care_profile_id);
    return { ok:true, resident, careProfile,
      target:groupBinding?.line_group_id || careProfile?.owner_line_id || null };
  });
  if (!transition.ok) return transition;
  let familyNotice = null;
  let familyNotified = false;
  if (transition.careProfile) {
    familyNotice = 'ศูนย์แจ้งสิ้นสุดการดูแลแล้ว ข้อมูลทั้งหมดยังอยู่กับคุณครบถ้วน '
      + 'ยังบันทึกนัด รับการเตือน และเรียกใช้บริการผู้ดูแลจาก Care2Go ได้ตามปกติ';
    if (transition.target) {
      await require('../providers/lineClient').pushMessage(transition.target, [{ type:'text',
        text:`${transition.careProfile.patient_name || transition.resident.full_name} — ${familyNotice}` }]);
      familyNotified = true;
    }
  }
  await audit('resident.discharged', requesterLineId, { residentId, familyNotified });
  return { ok:true, familyNotice, familyNotified };
}

async function listResidents(centerId, { search } = {}) {
  let rows = await Residents.findWhere((r) => r.center_id === centerId && r.status === 'active');
  if (search) {
    const q = search.trim().toLowerCase();
    rows = rows.filter((r) =>
      r.full_name.toLowerCase().includes(q) || (r.aliases || []).some((a) => a.toLowerCase().includes(q))
    );
  }
  const profileIds = new Set(rows.map((item) => item.care_profile_id).filter(Boolean));
  const [profiles, bindings, tokens] = await Promise.all([
    CareProfiles.findWhere((item) => profileIds.has(item.care_profile_id)),
    GroupBindings.findWhere((item) => item.kind === 'family' && item.status === 'active'
      && profileIds.has(item.care_profile_id)),
    GroupBindingTokens.findWhere((item) => ['family', 'center_family'].includes(item.kind)
      && profileIds.has(item.care_profile_id) && !item.used_at && !item.invalidated_at && !item.revoked_at
      && new Date(item.expires_at).getTime() > Date.now()),
  ]);
  const profileById = new Map(profiles.map((item) => [item.care_profile_id, item]));
  const boundProfiles = new Set(bindings.map((item) => item.care_profile_id));
  const activeCodeByProfile = new Map();
  for (const token of tokens.sort((a, b) => new Date(b.expires_at) - new Date(a.expires_at))) {
    if (!activeCodeByProfile.has(token.care_profile_id)) activeCodeByProfile.set(token.care_profile_id, token);
  }
  return rows.map((resident) => {
    const profile = profileById.get(resident.care_profile_id) || null;
    const activeCode = activeCodeByProfile.get(resident.care_profile_id) || null;
    return { ...resident,
      family_group_connected:boundProfiles.has(resident.care_profile_id),
      ownership_claimed:Boolean(profile?.owner_line_id),
      family_group_code_active_until:activeCode?.expires_at || null,
    };
  });
}

// ── FR-J1: นำเข้ารายชื่อแบบชุด พร้อมตรวจชื่อซ้ำก่อนบันทึก ──
async function importResidentsBulk(centerId, rows) {
  const existing = await Residents.findWhere((r) => r.center_id === centerId && r.status === 'active');
  const existingNames = new Set(existing.map((r) => r.full_name.trim()));

  const results = { imported: [], skippedDuplicates: [] };
  for (const row of rows) {
    const fullName = (row.fullName || '').trim();
    if (!fullName) continue;
    if (existingNames.has(fullName)) {
      results.skippedDuplicates.push(fullName);
      continue;
    }
    const { resident } = await addResident({
      centerId, fullName, aliases: row.aliases || [], room: row.room, familyPhone: row.familyPhone,
    });
    existingNames.add(fullName);
    results.imported.push(resident);
  }
  return results;
}

// ── FR-K1, K2: ตารางนัดของศูนย์ — ทุกผู้พัก พร้อมสถานะการจัดการเดินทาง ──
async function getCenterAppointments(centerId) {
  const { Appointments, TransportPlans } = require('../db');
  const residents = await Residents.findWhere((r) => r.center_id === centerId && r.status === 'active');
  const profileToResident = new Map(residents.filter((r) => r.care_profile_id).map((r) => [r.care_profile_id, r]));

  const allAppts = await Appointments.findWhere((a) => profileToResident.has(a.care_profile_id));
  const now_ = Date.now();
  const upcoming = allAppts.filter((a) => a.status !== 'cancelled' && new Date(a.datetime).getTime() > now_); // นัดที่ยกเลิกต้องไม่แสดง/เตือน

  const allPlans = await TransportPlans.findWhere((p) => p.center_id === centerId);
  const planByAppt = new Map(allPlans.map((p) => [p.appointment_id, p]));

  const rows = upcoming.map((a) => {
    const resident = profileToResident.get(a.care_profile_id);
    const plan = planByAppt.get(a.appointment_id);
    const needsAttention = !plan || plan.status === 'awaiting_family' || plan.status === 'awaiting_center'; // ข้อ K2: ไฮไลต์ที่ยังไม่ตัดสินใจ
    return {
      appointmentId: a.appointment_id,
      residentId: resident?.resident_id, residentName: resident?.full_name, room: resident?.room,
      hospital: a.hospital, datetime: a.datetime, note: a.note,
      clinicOrDepartment: a.clinic_or_department || '', reasonForVisit: a.reason_for_visit || '',
      relatedCondition: a.related_condition || '', doctorName: a.doctor_name || '', status: a.status || 'confirmed',
      transportStatus: plan ? plan.status : 'not_created',
      needsAttention,
    };
  });

  return rows.sort((a, b) => new Date(a.datetime) - new Date(b.datetime)); // ข้อ K1: เรียงตามวันเวลา
}

async function updateAppointment({ centerId, appointmentId, patch, requesterLineId }) {
  if (patch.datetime && new Date(patch.datetime).getTime() <= Date.now()) return { ok: false, reason: 'วันเวลานัดต้องเป็นเวลาในอนาคต' };
  const mutation = await withTransaction(`appointment-mutation:${appointmentId}`, async () => {
    const residents = await Residents.findWhere((r) => r.center_id === centerId && r.status === 'active');
    const profileIds = new Set(residents.map((r) => r.care_profile_id).filter(Boolean));
    const appointment = await require('../db').Appointments.findOne(
      (a) => a.appointment_id === appointmentId && profileIds.has(a.care_profile_id) && a.status !== 'cancelled'
    );
    if (!appointment) return { missing:true };
    const { patch:clean, changedFields } = require('./appointmentNotificationService').materialPatch(appointment, patch);
    if (changedFields.length === 0) return { appointment, changedFields, noChange:true };
    const update = { ...clean, updated_by:requesterLineId, updated_at:now(), version:Number(appointment.version || 1) + 1,
      last_material_changed_fields:changedFields };
    // เมื่อแก้วันนัด ให้สิทธิ์ระบบส่งการเตือนตามวันใหม่อีกครั้ง
    if (changedFields.includes('datetime')) { update.day_before_reminded = false; update.same_day_reminded = false; }
    const updated = await require('../db').Appointments.update((a) => a.appointment_id === appointmentId, update);
    return { appointment:updated, changedFields };
  });
  if (mutation.missing) return { ok: false, reason: 'ไม่พบนัดที่ใช้งานอยู่ในสาขานี้' };
  if (mutation.noChange) {
    const notificationState = Array.isArray(mutation.appointment.last_material_changed_fields)
      ? await require('./appointmentNotificationService').notifyLifecycle({
        eventType:'updated', appointment:mutation.appointment,
        changedFields:mutation.appointment.last_material_changed_fields,
      })
      : { status:'not_needed' };
    return { ok:true, appointment:mutation.appointment, noChange:true, notificationState };
  }
  await require('./transportService').notifyAppointmentChanged(appointmentId, 'updated', requesterLineId);
  const notificationState = await require('./appointmentNotificationService').notifyLifecycle({
    eventType:'updated', appointment:mutation.appointment, changedFields:mutation.changedFields,
  });
  await audit('appointment.updated', requesterLineId, { centerId, appointmentId, changedFields:mutation.changedFields, version:mutation.appointment.version });
  return { ok: true, appointment: mutation.appointment, notificationState };
}

async function cancelAppointment({ centerId, appointmentId, requesterLineId, reason = '' }) {
  const { Appointments, TransportPlans } = require('../db');
  const mutation = await withTransaction(`appointment-mutation:${appointmentId}`, async () => {
    const residents = await Residents.findWhere((r) => r.center_id === centerId && r.status === 'active');
    const profileIds = new Set(residents.map((r) => r.care_profile_id).filter(Boolean));
    const appointment = await Appointments.findOne((a) => a.appointment_id === appointmentId && profileIds.has(a.care_profile_id));
    if (!appointment) return { missing:true };
    if (appointment.status === 'cancelled') return { appointment, alreadyCancelled:true };
    const cancelled = await Appointments.update((a) => a.appointment_id === appointmentId, {
      status:'cancelled', cancelled_at:now(), cancelled_by:requesterLineId, cancellation_reason:String(reason || '').trim(),
    });
    await TransportPlans.updateAll((p) => p.appointment_id === appointmentId, { status:'cancelled', cancelled_at:now() });
    return { appointment:cancelled, alreadyCancelled:false };
  });
  if (mutation.missing) return { ok: false, reason: 'ไม่พบนัดในสาขานี้' };
  if (mutation.alreadyCancelled) {
    const notificationState = await require('./appointmentNotificationService').notifyLifecycle({ eventType:'cancelled', appointment:mutation.appointment });
    return { ok:true, appointment:mutation.appointment, alreadyCancelled:true, notificationState };
  }
  await require('./transportService').notifyAppointmentChanged(appointmentId, 'cancelled', requesterLineId);
  const notificationState = await require('./appointmentNotificationService').notifyLifecycle({ eventType:'cancelled', appointment:mutation.appointment });
  await audit('appointment.cancelled', requesterLineId, { centerId, appointmentId, reason: reason || '' });
  return { ok:true, appointment:mutation.appointment, notificationState };
}

// ── ข้อ J4/หมวดความปลอดภัย: หมุน API Key ของศูนย์ใหม่ (เพิกถอนของเดิมทันที) ──
async function rotateExternalApiKey(centerId, requesterLineId) {
  const newKey = id('EXT');
  await Centers.update((c) => c.center_id === centerId, { external_api_key: newKey });
  await audit('center.api_key_rotated', requesterLineId, { centerId });
  return newKey;
}

async function findCenterByApiKey(apiKey) {
  if (!apiKey) return null;
  const center = await Centers.findOne((c) => c.external_api_key === apiKey && c.status === 'active');
  return require('./subscriptionService').entitlement(center).allowed ? center : null;
}

module.exports = {
  createCenter, updateCenterSettings, bindGroupToCenter, bindGroupToCenterInCurrentTransaction, findCenterByGroup, appointManager, removeManager, listStaff,
  addResident, updateResident, createResidentUpdater, dischargeResident, listResidents, importResidentsBulk, getCenterAppointments,
  updateAppointment, cancelAppointment,
  rotateExternalApiKey, findCenterByApiKey,
  recordStaffFromGroup, findCenterByStaffUser, listApprovers, canApprove,
  removeStaffFromGroup,
  approveStaff, revokeStaff, createCenterManagedCareProfile, getOrCreateResidentInvite,
  transferOwner, reconcileAllCenterStaff,
  setActiveCenterForStaff, getActiveCenterIdForStaff, listCentersByStaffUser,
};
