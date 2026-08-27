// services/centerService.js — FR-A (ตั้งค่าศูนย์), FR-B (ทะเบียนผู้พัก), FR-J1/J2 (นำเข้าข้อมูล)

const { Centers, CenterStaff, StaffContexts, Residents, CareProfiles, Invites, GroupBindings, audit, id, now, withTransaction } = require('../db');
const richMenuService = require('./richMenuService');

const INVITE_EXPIRY_DAYS = 30; // ตาม Technical Design หมวด 9

/** เชื่อม Rich Menu ฝั่งศูนย์แบบไม่บล็อก Flow หลัก — ตามที่วิเคราะห์ไว้ Rich Menu ไม่ใช่ของที่ขาดไม่ได้
 *  ถ้าล้มเหลว (เช่น ผู้ใช้ยังไม่ได้เพิ่มเพื่อน OA) ให้ log ไว้เฉยๆ ไม่ทำให้การสร้างศูนย์/แต่งตั้งพัง */
function linkMenuBestEffort(lineUserId) {
  richMenuService.linkCenterMenuToUser(lineUserId).catch((err) => {
    console.error(`เชื่อม Rich Menu ให้ ${lineUserId} ไม่สำเร็จ (ไม่กระทบการทำงานหลัก):`, err.message);
  });
}

// ── FR-A1: ทีมงานสร้างบัญชีศูนย์ ──
async function createCenter({ name, ownerLineId, address = '', contactPhone = '', subscriptionRequired = process.env.NODE_ENV !== 'test' }) {
  return withTransaction(`center-create:${ownerLineId}:${name}`, async () => {
    const center = await Centers.insert({
      center_id: id('CTR'),
      name,
      address: address || '', contact_phone: contactPhone || '',
      owner_line_id: ownerLineId,
      group_id: null,
      external_api_key: id('EXT'), // deprecated compatibility credential; never project to Center users
      status: 'active',
      subscription_required: !!subscriptionRequired,
      subscription_start_at: null,
      subscription_end_at: null,
      created_at: now(),
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
async function bindGroupToCenter({ centerId, groupId, requesterLineId }) {
  const staff = await CenterStaff.findOne(
    (s) => s.center_id === centerId && s.line_user_id === requesterLineId && ['owner', 'manager'].includes(s.role)
  );
  if (!staff) {
    return { ok: false, reason: 'ผู้เชิญไม่มีสิทธิ์เจ้าของหรือผู้จัดการของศูนย์นี้' };
  }
  const previous = await GroupBindings.findOne(
    (g) => g.kind === 'center_staff' && g.center_id === centerId && g.status !== 'inactive'
  );
  const groupUsedElsewhere = await GroupBindings.findOne(
    (g) => g.line_group_id === groupId && g.status !== 'inactive'
      && !(g.kind === 'center_staff' && g.center_id === centerId)
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

async function findCenterByGroup(groupId) {
  const binding = await GroupBindings.findOne((g) => g.line_group_id === groupId);
  if (binding) {
    if (binding.kind !== 'center_staff' || binding.status === 'inactive') return null;
    const center = await Centers.findOne((c) => c.center_id === binding.center_id && c.status === 'active');
    return require('./subscriptionService').entitlement(center).allowed ? center : null;
  }
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

async function getOrCreateResidentInvite({ centerId, residentId }) {
  const resident = await Residents.findOne((r) => r.resident_id === residentId && r.center_id === centerId && r.status === 'active');
  if (!resident) return { ok:false, reason:'ไม่พบผู้พักในสาขานี้' };
  if (resident.care_profile_id) {
    const profile = await CareProfiles.findOne((p) => p.care_profile_id === resident.care_profile_id);
    if (profile?.owner_line_id) return { ok:false, reason:'Care Profile นี้มีเจ้าของครอบครัวแล้ว' };
  }
  let invite = await Invites.findOne((i) => i.resident_id === residentId && i.status === 'active' && !i.used_at && new Date(i.expires_at) > new Date());
  if (!invite) invite = await Invites.insert({ invite_token:id('INV'), resident_id:residentId, expires_at:new Date(Date.now()+INVITE_EXPIRY_DAYS*86400000).toISOString(), used_at:null, status:'active', revoked_at:null });
  return { ok:true, inviteUrl:`https://liff.line.me/${process.env.LIFF_ID_FAMILY || 'YOUR_LIFF_ID'}?token=${encodeURIComponent(invite.invite_token)}`, inviteExpiresAt:invite.expires_at };
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
// ข้อ O1: ถ้าเบอร์ญาติตรงกับ Care Profile ที่มีอยู่แล้ว ต้องส่งคำขอเชื่อมต่อ ห้ามเชื่อมอัตโนมัติ
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

  // ข้อ O1: ตรวจสอบว่าเบอร์นี้เคยมี Care Profile จากศูนย์อื่นมาก่อนไหม (ไม่ใช่แค่ Test เฉยๆ ต้องเรียกจริง)
  let accessRequestSent = false;
  let accessRequestId = null;
  if (familyPhone) {
    const accessService = require('./accessService');
    const existingProfile = await accessService.findProfileByPhone(familyPhone);
    if (existingProfile && !existingProfile.center_id) {
      const requestResult = await accessService.createAccessRequest({
        centerId, careProfileId: existingProfile.care_profile_id,
        residentId: resident.resident_id, requestedBy: 'system:auto_match',
      });
      accessRequestSent = !!requestResult.ok;
      accessRequestId = requestResult.request?.request_id || null;
    }
  }

  return {
    ok: true, resident, inviteUrl: `https://liff.line.me/${process.env.LIFF_ID_FAMILY || 'YOUR_LIFF_ID'}?token=${encodeURIComponent(invite.invite_token)}`, inviteExpiresAt: invite.expires_at,
    accessRequestSent, accessRequestId,
  };
}

// ── FR-B4: แก้ไขข้อมูลผู้พัก ──
async function updateResident(centerId, residentId, patch) {
  const allowed = ['full_name', 'aliases', 'room', 'family_phone'];
  const clean = {};
  for (const k of allowed) if (k in patch) clean[k] = patch[k];
  return Residents.update((r) => r.resident_id === residentId && r.center_id === centerId && r.status === 'active', clean);
}

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
  const resident = await Residents.findOne((r) => r.resident_id === residentId && r.center_id === centerId && r.status === 'active');
  if (!resident) return { ok: false, reason: 'ไม่พบผู้พัก' };

  await Residents.update((r) => r.resident_id === residentId && r.center_id === centerId && r.status === 'active', { status: 'discharged', discharged_at: now() });
  await Invites.updateAll((i) => i.resident_id === residentId && !i.used_at && i.status !== 'revoked', { status: 'revoked', revoked_at: now(), revoke_reason: 'resident_discharged' });

  let familyNotice = null;
  let familyNotified = false;
  if (resident.care_profile_id) {
    const { CareProfiles, GroupBindings } = require('../db');
    const lineClient = require('../providers/lineClient');
    await CareProfiles.update(
      (p) => p.care_profile_id === resident.care_profile_id,
      { center_id: null, status: 'independent' } // FR-N6
    );
    familyNotice = 'ศูนย์แจ้งสิ้นสุดการดูแลแล้ว ข้อมูลทั้งหมดยังอยู่กับคุณครบถ้วน '
      + 'ยังบันทึกนัด รับการเตือน และเรียกใช้บริการผู้ดูแลจาก Care2Go ได้ตามปกติ'; // ข้อความตามที่ตกลงไว้

    // ⚠️ ข้อ B6 ระบุว่า "ระบบส่งข้อความแจ้งครอบครัว" — ต้อง Push จริง ไม่ใช่แค่คืนค่าไปให้ศูนย์เห็น
    const groupBinding = await GroupBindings.findOne((g) => g.care_profile_id === resident.care_profile_id && g.kind === 'family' && g.status !== 'inactive');
    const careProfile = await CareProfiles.findOne((p) => p.care_profile_id === resident.care_profile_id);
    const target = groupBinding ? groupBinding.line_group_id : (careProfile ? careProfile.owner_line_id : null);
    if (target) {
      await lineClient.pushMessage(target, [{ type: 'text', text: familyNotice }]);
      familyNotified = true;
    }
  }

  await audit('resident.discharged', requesterLineId, { residentId, familyNotified });
  return { ok: true, familyNotice, familyNotified };
}

async function listResidents(centerId, { search } = {}) {
  let rows = await Residents.findWhere((r) => r.center_id === centerId && r.status === 'active');
  if (search) {
    const q = search.trim().toLowerCase();
    rows = rows.filter((r) =>
      r.full_name.toLowerCase().includes(q) || (r.aliases || []).some((a) => a.toLowerCase().includes(q))
    );
  }
  return rows;
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
  const residents = await Residents.findWhere((r) => r.center_id === centerId && r.status === 'active');
  const profileIds = new Set(residents.map((r) => r.care_profile_id).filter(Boolean));
  const appointment = await require('../db').Appointments.findOne(
    (a) => a.appointment_id === appointmentId && profileIds.has(a.care_profile_id) && a.status !== 'cancelled'
  );
  if (!appointment) return { ok: false, reason: 'ไม่พบนัดที่ใช้งานอยู่ในสาขานี้' };
  if (patch.datetime && new Date(patch.datetime).getTime() <= Date.now()) return { ok: false, reason: 'วันเวลานัดต้องเป็นเวลาในอนาคต' };
  const clean = {};
  for (const [input, stored] of Object.entries({ hospital:'hospital', datetime:'datetime', note:'note', clinicOrDepartment:'clinic_or_department', reasonForVisit:'reason_for_visit', relatedCondition:'related_condition', doctorName:'doctor_name' })) {
    if (input in patch) clean[stored] = patch[input];
  }
  clean.updated_by = requesterLineId; clean.updated_at = now(); clean.version = Number(appointment.version || 1) + 1;
  // เมื่อแก้วันนัด ให้สิทธิ์ระบบส่งการเตือนตามวันใหม่อีกครั้ง
  if ('datetime' in patch) { clean.day_before_reminded = false; clean.same_day_reminded = false; }
  const updated = await require('../db').Appointments.update((a) => a.appointment_id === appointmentId, clean);
  await require('./transportService').notifyAppointmentChanged(appointmentId, 'updated', requesterLineId);
  await notifyFamilyAppointmentEvent(updated.care_profile_id, `⚠️ ศูนย์แก้ไขข้อมูลนัด\n${updated.hospital} · ${updated.datetime}`, `appointment-updated:${appointmentId}:${clean.version}`);
  await audit('appointment.updated', requesterLineId, { centerId, appointmentId, changedFields: Object.keys(clean) });
  return { ok: true, appointment: updated };
}

async function cancelAppointment({ centerId, appointmentId, requesterLineId, reason = '' }) {
  const { Appointments, TransportPlans } = require('../db');
  const residents = await Residents.findWhere((r) => r.center_id === centerId && r.status === 'active');
  const profileIds = new Set(residents.map((r) => r.care_profile_id).filter(Boolean));
  const appointment = await Appointments.findOne((a) => a.appointment_id === appointmentId && profileIds.has(a.care_profile_id));
  if (!appointment) return { ok: false, reason: 'ไม่พบนัดในสาขานี้' };
  if (appointment.status === 'cancelled') return { ok: true, appointment, alreadyCancelled: true };
  const cancelled = await Appointments.update((a) => a.appointment_id === appointmentId, {
    status: 'cancelled', cancelled_at: now(), cancelled_by: requesterLineId, cancellation_reason: reason || '',
  });
  await TransportPlans.updateAll((p) => p.appointment_id === appointmentId, { status: 'cancelled', cancelled_at: now() });
  await require('./transportService').notifyAppointmentChanged(appointmentId, 'cancelled', requesterLineId);
  await notifyFamilyAppointmentEvent(cancelled.care_profile_id, `❌ ศูนย์ยกเลิกนัด ${cancelled.hospital || ''}\nเหตุผล: ${reason || 'ไม่ระบุ'}`, `appointment-cancelled:${appointmentId}`);
  await audit('appointment.cancelled', requesterLineId, { centerId, appointmentId, reason: reason || '' });
  return { ok: true, appointment: cancelled };
}

async function notifyFamilyAppointmentEvent(careProfileId, text, dedupeKey) {
  const profile = await require('../db').CareProfiles.findOne((p) => p.care_profile_id === careProfileId);
  const binding = await GroupBindings.findOne((g) => g.kind === 'family' && g.care_profile_id === careProfileId && g.status !== 'inactive');
  const target = binding?.line_group_id || profile?.owner_line_id;
  if (!target) return { ok:false, reason:'no_family_target' };
  return require('./notificationService').enqueueAndDeliver({ dedupeKey, to:target, kind:'appointment_changed', meta:{careProfileId}, messages:[{type:'text',text}] });
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
  createCenter, updateCenterSettings, bindGroupToCenter, findCenterByGroup, appointManager, removeManager, listStaff,
  addResident, updateResident, dischargeResident, listResidents, importResidentsBulk, getCenterAppointments,
  updateAppointment, cancelAppointment,
  rotateExternalApiKey, findCenterByApiKey,
  recordStaffFromGroup, findCenterByStaffUser, listApprovers, canApprove,
  removeStaffFromGroup,
  approveStaff, revokeStaff, createCenterManagedCareProfile, getOrCreateResidentInvite,
  transferOwner, reconcileAllCenterStaff,
  setActiveCenterForStaff, listCentersByStaffUser,
};
