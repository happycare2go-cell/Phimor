// services/familyService.js — FR-H (ฝั่งครอบครัว) และ FR-N (Care Profile อิสระ)

const { createHash } = require('crypto');
const { CareProfiles, Residents, Invites, Appointments, GroupBindings, Consents, CareProfileMembers, CareProfileShareInvites, AccessRequests, audit, id, now, withTransaction, withTransactionLocks } = require('../db');
const pdfService = require('./pdfService');
const { GROUP_BINDING_TRANSACTION_KEY, bindFamilyDestinationInCurrentTransaction } = require('./groupBindingRepository');

const CONSENT_VERSION = '2569-08-1'; // ข้อ H6: ต้องบันทึกเวอร์ชันเอกสารที่ยอมรับ

function isPast(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) && parsed <= Date.now();
}

// ── FR-H6: บันทึกยินยอม PDPA — ต้องผ่านก่อนเข้าหน้าหลักได้ ──
async function recordConsent(lineUserId, accepted) {
  const consent = await Consents.insert({
    consent_id: id('CNS'), line_user_id: lineUserId, accepted, version: CONSENT_VERSION, at: now(),
  });
  await audit(accepted ? 'consent.granted' : 'consent.withdrawn', lineUserId, {
    consentId:consent.consent_id, version:CONSENT_VERSION,
  });
  return consent;
}

async function getConsentState(lineUserId) {
  const rows = await Consents.findAll();
  const latest = rows.find((row) => row.line_user_id === lineUserId && row.version === CONSENT_VERSION) || null;
  return {
    hasConsent:latest?.accepted === true,
    status:latest ? (latest.accepted === true ? 'active' : 'withdrawn') : 'not_given',
    version:CONSENT_VERSION,
    updatedAt:latest?.at || null,
  };
}

async function hasValidConsent(lineUserId) {
  return (await getConsentState(lineUserId)).hasConsent;
}

async function createCaregiverInvite({ careProfileId, requesterLineId }) {
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId);
  if (!profile || profile.owner_line_id !== requesterLineId) return { ok:false, reason:'เฉพาะเจ้าของ Care Profile หลักเท่านั้นที่เชิญญาติได้' };
  const invite = await CareProfileShareInvites.insert({ invite_id:id('CPI'), token:id('SHARE'), care_profile_id:careProfileId,
    created_by:requesterLineId, created_at:now(), expires_at:new Date(Date.now()+7*86400000).toISOString(), used_at:null, status:'active' });
  const liffId = process.env.LIFF_ID_FAMILY || 'YOUR_LIFF_ID';
  return { ok:true, invite, url:`https://liff.line.me/${liffId}?shareToken=${encodeURIComponent(invite.token)}` };
}

async function getCaregiverInvite(token) {
  const invite = await CareProfileShareInvites.findOne((i) => i.token === token && i.status === 'active');
  if (!invite || invite.used_at || new Date(invite.expires_at).getTime() < Date.now()) return { ok:false, reason:'ลิงก์เชิญไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว' };
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === invite.care_profile_id);
  return profile ? { ok:true, invite, patientName:profile.patient_name } : { ok:false, reason:'ไม่พบ Care Profile' };
}

async function acceptCaregiverInvite(token, lineUserId, identity = {}) {
  const found = await getCaregiverInvite(token); if (!found.ok) return found;
  if (found.invite.created_by === lineUserId) return { ok:false, reason:'เจ้าของ Care Profile ไม่จำเป็นต้องรับคำเชิญของตนเอง' };
  let member = await CareProfileMembers.findOne((m) => m.care_profile_id === found.invite.care_profile_id && m.line_user_id === lineUserId);
  const displayName = typeof identity.displayName === 'string' ? identity.displayName.trim().slice(0, 160) : null;
  if (member) member = await CareProfileMembers.update((m) => m.member_id === member.member_id, { status:'active', role:'caregiver', rejoined_at:now(), display_name:displayName || member.display_name || null });
  else member = await CareProfileMembers.insert({ member_id:id('CPM'), care_profile_id:found.invite.care_profile_id, line_user_id:lineUserId, display_name:displayName, role:'caregiver', status:'active', permissions:['view','edit_profile','manage_appointments','decide_transport'], joined_at:now(), invited_by:found.invite.created_by });
  await CareProfileShareInvites.update((i) => i.invite_id === found.invite.invite_id, { used_at:now(), used_by:lineUserId, status:'used' });
  await audit('care_profile.caregiver_joined', lineUserId, { careProfileId:found.invite.care_profile_id, invitedBy:found.invite.created_by });
  return { ok:true, member };
}

async function canAccessProfile(careProfileId, lineUserId) {
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId);
  if (!profile) return false;
  if (profile.owner_line_id === lineUserId) return true;
  return !!await CareProfileMembers.findOne((m) => m.care_profile_id === careProfileId && m.line_user_id === lineUserId && m.status === 'active');
}

async function hasPermission(careProfileId, lineUserId, permission) {
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId);
  if (!profile) return false;
  if (profile.owner_line_id === lineUserId) return true;
  const member = await CareProfileMembers.findOne((m) => m.care_profile_id === careProfileId && m.line_user_id === lineUserId && m.status === 'active');
  if (!member) return false;
  // Medication mutation is never inferred from membership alone. Existing
  // explicit grants remain valid; legacy rows without a permissions array keep
  // the non-medication compatibility permissions only.
  const permissions = member.permissions || ['view','edit_profile','manage_appointments','decide_transport'];
  return permissions.includes(permission);
}

// ── FR-H1: ผูกบัญชีผ่านลิงก์เชิญ → สร้าง Care Profile โดยครอบครัวเป็นเจ้าของ ──
async function acceptInvite(token, lineUserId, profileData = {}) {
  const probe = await Invites.findOne((item) => item.invite_token === token);
  if (!probe) return { ok:false, reason:'ลิงก์เชิญไม่ถูกต้อง' };
  const initialResident = await Residents.findOne((item) => item.resident_id === probe.resident_id);
  const lockKeys = [`invite:${token}`, `ownership-claim:resident:${probe.resident_id}`];
  if (initialResident?.care_profile_id) lockKeys.push(`ownership-claim:profile:${initialResident.care_profile_id}`);
  const result = await withTransactionLocks(lockKeys, async () => {
    const invite = await Invites.findOne((item) => item.invite_token === token);
    if (!invite) return { ok:false, reason:'ลิงก์เชิญไม่ถูกต้อง' };
    const resident = await Residents.findOne((item) => item.resident_id === invite.resident_id);
    if (!resident || resident.status !== 'active') return { ok:false, reason:'ผู้พักไม่ได้อยู่ในศูนย์นี้แล้ว' };

    if (invite.used_at || invite.status === 'used') {
      const claimedProfile = resident.care_profile_id
        ? await CareProfiles.findOne((item) => item.care_profile_id === resident.care_profile_id) : null;
      if (invite.used_by === lineUserId && claimedProfile?.owner_line_id === lineUserId) {
        return { ok:true, duplicate:true, careProfile:claimedProfile, residentId:resident.resident_id };
      }
      return { ok:false, reason:'ลิงก์เชิญนี้ถูกใช้ ปฏิเสธ หรือยกเลิกแล้ว' };
    }
    if (invite.status && invite.status !== 'active') return { ok:false, reason:'ลิงก์เชิญนี้ถูกใช้ ปฏิเสธ หรือยกเลิกแล้ว' };
    if (new Date(invite.expires_at).getTime() < Date.now()) return { ok:false, reason:'ลิงก์เชิญหมดอายุแล้ว' };

    if (resident.care_profile_id) {
      const existingProfile = await CareProfiles.findOne((item) => item.care_profile_id === resident.care_profile_id);
      if (!existingProfile) return { ok:false, reason:'ไม่พบ Care Profile ของผู้พักรายนี้' };
      if (existingProfile.owner_line_id) {
        return { ok:false, reason:'Care Profile นี้มีเจ้าของข้อมูลหลักแล้ว' };
      }
      const claimed = await CareProfiles.update(
        (item) => item.care_profile_id === existingProfile.care_profile_id && !item.owner_line_id,
        { owner_line_id:lineUserId,
          family_phone:profileData.familyPhone || existingProfile.family_phone || resident.family_phone || null,
          family_claimed_at:now(), managed_by_center:false }
      );
      if (!claimed) return { ok:false, reason:'Care Profile นี้มีเจ้าของข้อมูลหลักแล้ว' };
      await Residents.update((item) => item.resident_id === resident.resident_id, { link_status:'linked' });
      await Invites.update((item) => item.invite_token === token && !item.used_at,
        { used_at:now(), used_by:lineUserId, status:'used' });
      await AccessRequests.updateAll((item) => item.resident_id === resident.resident_id && item.status === 'pending',
        { status:'superseded', responded_at:now() });
      await audit('family.center_managed_profile_claimed', lineUserId, {
        residentId:resident.resident_id, careProfileId:claimed.care_profile_id,
        centerId:resident.center_id, sourceFlow:'center_ownership_claim',
      });
      return { ok:true, careProfile:claimed, residentId:resident.resident_id };
    }

    // Legacy Resident-only Invite compatibility: old rows may not yet have a
    // Center-managed Care Profile. The claim still creates exactly one profile.
    const profile = await CareProfiles.insert({
      care_profile_id:id('CP'), owner_line_id:lineUserId, patient_name:resident.full_name,
      center_id:resident.center_id, family_phone:resident.family_phone || null, status:'linked',
      gender:profileData.gender || null, blood_type:profileData.bloodType || null,
      height_cm:profileData.heightCm ? Number(profileData.heightCm) : null,
      weight_kg:profileData.weightKg ? Number(profileData.weightKg) : null,
      chronic_conditions:Array.isArray(profileData.chronicConditions) ? profileData.chronicConditions : [],
      drug_allergies:profileData.drugAllergies || '', food_allergies:profileData.foodAllergies || '',
      mobility_limitations:profileData.mobilityLimitations || '',
      emergency_contact_name:profileData.emergencyContactName || '',
      emergency_contact_phone:profileData.emergencyContactPhone || '', created_at:now(),
    });
    await Residents.update((item) => item.resident_id === resident.resident_id
      && item.status === 'active' && !item.care_profile_id,
    { care_profile_id:profile.care_profile_id, link_status:'linked' });
    await Invites.update((item) => item.invite_token === token && !item.used_at,
      { used_at:now(), used_by:lineUserId, status:'used' });
    await AccessRequests.updateAll((item) => item.resident_id === resident.resident_id && item.status === 'pending',
      { status:'superseded', responded_at:now() });
    await audit('family.invite_accepted', lineUserId, {
      residentId:resident.resident_id, careProfileId:profile.care_profile_id,
      centerId:resident.center_id, sourceFlow:'legacy_resident_ownership_claim',
    });
    return { ok:true, careProfile:profile, residentId:resident.resident_id };
  });
  if (result.ok && !result.duplicate) {
    await require('./deliveryService').deliverPendingForResident(result.residentId, result.careProfile.care_profile_id);
  }
  return result;
}

async function declineInvite(token, lineUserId) {
  return withTransaction(`invite:${token}`, async () => {
    const invite = await Invites.findOne((item) => item.invite_token === token);
    if (!invite) return { ok:false, code:'INVITE_NOT_FOUND', reason:'ลิงก์เชิญไม่ถูกต้อง' };
    if (invite.status === 'declined' && invite.declined_by === lineUserId) return { ok:true, status:'declined', duplicate:true };
    if (invite.used_at || (invite.status && invite.status !== 'active')) return { ok:false, code:'INVITE_NOT_ACTIVE', reason:'ลิงก์เชิญนี้ไม่สามารถใช้งานได้แล้ว' };
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      await Invites.update((item) => item.invite_token === token && (!item.status || item.status === 'active'), {
        status:'expired', expired_at:now(),
      });
      return { ok:false, code:'INVITE_EXPIRED', reason:'ลิงก์เชิญหมดอายุแล้ว' };
    }
    const declinedAt = now();
    const declined = await Invites.update(
      (item) => item.invite_token === token && (!item.status || item.status === 'active') && !item.used_at,
      { status:'declined', declined_at:declinedAt, declined_by:lineUserId }
    );
    if (!declined) return { ok:false, code:'INVITE_NOT_ACTIVE', reason:'ลิงก์เชิญนี้ไม่สามารถใช้งานได้แล้ว' };
    await audit('family.center_profile_invite_declined', lineUserId, {
      residentId:declined.resident_id, inviteStatus:'declined',
    });
    return { ok:true, status:'declined' };
  });
}

async function listCaregivers(careProfileId, requesterLineId) {
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId && p.owner_line_id === requesterLineId);
  if (!profile) return { ok: false, reason: 'เฉพาะเจ้าของ Care Profile เท่านั้น' };
  const members = await CareProfileMembers.findWhere((m) => m.care_profile_id === careProfileId && m.status === 'active');
  const invites = await CareProfileShareInvites.findWhere((i) => i.care_profile_id === careProfileId && i.status === 'active');
  const { displayIdentity } = require('../utils/safeIdentity');
  return { ok: true, members:members.map((member) => ({
    memberId:member.member_id,
    displayIdentity:displayIdentity({ displayName:member.display_name, lineUserId:member.line_user_id }),
    role:member.role || 'caregiver', status:member.status, permissions:member.permissions || ['view'],
  })), pendingInviteCount:invites.length };
}

async function caregiverByMemberId({ careProfileId, memberId, requesterLineId }) {
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId && p.owner_line_id === requesterLineId);
  if (!profile) return null;
  return CareProfileMembers.findOne((member) => member.care_profile_id === careProfileId && member.member_id === memberId);
}

async function revokeCaregiver({ careProfileId, targetLineId, requesterLineId }) {
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId && p.owner_line_id === requesterLineId);
  if (!profile) return { ok: false, reason: 'เฉพาะเจ้าของ Care Profile เท่านั้น' };
  const member = await CareProfileMembers.update((m) => m.care_profile_id === careProfileId && m.line_user_id === targetLineId && m.status === 'active', { status: 'revoked', revoked_at: now(), revoked_by: requesterLineId });
  if (!member) return { ok: false, reason: 'ไม่พบผู้ดูแลร่วมที่ใช้งานอยู่' };
  await audit('care_profile.caregiver_revoked', requesterLineId, { careProfileId, targetLineId });
  return { ok: true };
}

async function updateCaregiverPermissions({ careProfileId, targetLineId, permissions, requesterLineId }) {
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId && p.owner_line_id === requesterLineId);
  if (!profile) return { ok:false, reason:'เฉพาะเจ้าของ Care Profile เท่านั้น' };
  const allowed = new Set(['view','edit_profile','manage_appointments','manage_medications','decide_transport']);
  const clean = [...new Set((Array.isArray(permissions) ? permissions : []).filter((p) => allowed.has(p)))];
  if (!clean.includes('view')) clean.unshift('view');
  const member = await CareProfileMembers.update((m) => m.care_profile_id === careProfileId && m.line_user_id === targetLineId && m.status === 'active', { permissions:clean, permissions_updated_at:now(), permissions_updated_by:requesterLineId });
  if (!member) return { ok:false, reason:'ไม่พบผู้ดูแลร่วม' };
  await audit('care_profile.caregiver_permissions_updated', requesterLineId, { careProfileId, targetLineId, permissions:clean });
  return { ok:true, member };
}

async function leaveCareProfile({ careProfileId, lineUserId }) {
  const member = await CareProfileMembers.update((m) => m.care_profile_id === careProfileId && m.line_user_id === lineUserId && m.status === 'active', { status: 'left', left_at: now() });
  if (!member) return { ok: false, reason: 'ไม่พบสิทธิผู้ดูแลร่วม' };
  await audit('care_profile.caregiver_left', lineUserId, { careProfileId });
  return { ok: true };
}

// ── FR-N1: ครอบครัวสร้าง Care Profile เองได้โดยไม่ผ่านศูนย์ ──
// familyPhone เก็บไว้ด้วย (Optional) เพื่อให้ข้อ O1 ค้นหาเจอ ถ้าศูนย์เพิ่มผู้พักด้วยเบอร์เดียวกันทีหลัง
async function createIndependentProfile({ ownerLineId, patientName, familyPhone, gender, bloodType, heightCm, weightKg,
  chronicConditions = [], drugAllergies, foodAllergies, mobilityLimitations, emergencyContactName, emergencyContactPhone }) {
  const profile = await CareProfiles.insert({
    care_profile_id: id('CP'),
    owner_line_id: ownerLineId,
    patient_name: patientName,
    center_id: null,
    family_phone: familyPhone || null,
    status: 'independent',
    gender: gender || null, blood_type: bloodType || null,
    height_cm: heightCm ? Number(heightCm) : null, weight_kg: weightKg ? Number(weightKg) : null,
    chronic_conditions: Array.isArray(chronicConditions) ? chronicConditions : [],
    drug_allergies: drugAllergies || '', food_allergies: foodAllergies || '',
    mobility_limitations: mobilityLimitations || '',
    emergency_contact_name: emergencyContactName || '', emergency_contact_phone: emergencyContactPhone || '',
    created_at: now(),
  });
  return profile;
}

// ── FR-N1: ผูกกลุ่มไลน์ครอบครัวด้วยตนเอง ──
async function bindFamilyGroupInCurrentTransaction({ careProfileId, groupId, requesterLineId }) {
  const profile = await CareProfiles.findOne((item) => item.care_profile_id === careProfileId);
  if (!profile) return { ok:false, reason:'ไม่พบ Care Profile', code:'CARE_PROFILE_NOT_FOUND' };
  if (profile.owner_line_id !== requesterLineId) {
    return { ok:false, reason:'เฉพาะเจ้าของ Care Profile เท่านั้นที่ผูกกลุ่มได้', code:'FAMILY_OWNER_REQUIRED' };
  }
  return bindFamilyDestinationInCurrentTransaction({
    careProfileId, groupId, boundByLineUserId:requesterLineId, sourceFlow:'family_owner_code',
  });
}

async function bindFamilyGroup(input) {
  return withTransaction(GROUP_BINDING_TRANSACTION_KEY, () => bindFamilyGroupInCurrentTransaction(input));
}

async function recordMedicationSnapshot({ careProfileId, items, recordedBy, source = 'manual', sourceImageBase64 = null }) {
  const medicationCurrentSetService = require('./medicationCurrentSetService');
  const current = await medicationCurrentSetService.getCurrent({
    careProfileId, requester:{ lineUserId:recordedBy },
  });
  const saved = await medicationCurrentSetService.saveCompleteSet({
    careProfileId, items, baseSnapshotId:current.currentSnapshot?.snapshotId || null,
    requester:{ lineUserId:recordedBy }, source, sourceImageBase64,
  });
  return { ok:true, snapshot:{
    snapshot_id:saved.currentSnapshot?.snapshotId, care_profile_id:careProfileId,
    items:saved.medications, source:saved.currentSnapshot?.source,
    recorded_at:saved.currentSnapshot?.recordedAt,
  }, result:saved };
}

async function getMedicationHistory(careProfileId) {
  const profile = await CareProfiles.findOne((item) => item.care_profile_id === careProfileId);
  if (!profile?.owner_line_id) return [];
  const history = await require('./medicationChangeHistoryService').getHistory({
    careProfileId, requester:{ lineUserId:profile.owner_line_id },
  });
  return history.items;
}

// ── FR-H2: บันทึกนัด/ยาด้วยตนเอง (ใช้ร่วมกันได้ทั้ง linked และ independent) ──
function appointmentCreateHash({ careProfileId, hospital, datetime, note }) {
  return createHash('sha256').update(JSON.stringify({
    careProfileId,
    hospital:String(hospital || '').trim(),
    datetime:new Date(datetime).toISOString(),
    note:String(note || '').trim(),
  })).digest('hex');
}

async function addAppointmentByFamily({ careProfileId, hospital, datetime, note, createdBy, idempotencyKey = null }) {
  if (isPast(datetime)) return { ok: false, reason: 'ไม่สามารถบันทึกนัดที่เป็นเวลาในอดีตได้' }; // ข้อ G2
  const safeKey = /^[A-Za-z0-9._:-]{8,160}$/.test(String(idempotencyKey || '')) ? String(idempotencyKey) : null;
  const safeKeyHash = safeKey ? createHash('sha256').update(safeKey).digest('hex') : null;
  let payloadHash;
  try { payloadHash = appointmentCreateHash({ careProfileId, hospital, datetime, note }); }
  catch (_error) { return { ok:false, reason:'วันเวลานัดไม่ถูกต้อง' }; }
  const saved = await withTransaction(`appointment-create:${createdBy}:${careProfileId}:${safeKeyHash || id('REQ')}`, async () => {
    const existing = safeKey && await Appointments.findOne((item) => (
      item.care_profile_id === careProfileId
        && item.created_by === createdBy
        && item.creation_idempotency_hash === safeKeyHash
    ));
    if (existing) {
      if (existing.creation_payload_hash !== payloadHash) return { conflict:true };
      return { appointment:existing, duplicate:true };
    }
    const appointment = await Appointments.insert({
      appointment_id: id('APT'), care_profile_id: careProfileId, hospital:String(hospital || '').trim(), datetime,
      note: String(note || '').trim(), version:1,
      source: 'family_manual', source_center_id: null, created_by: createdBy, created_at: now(), status:'confirmed', // ข้อ J5
      creation_idempotency_hash:safeKeyHash, creation_payload_hash:safeKey ? payloadHash : null,
    });
    const resident = await Residents.findOne((r) => r.care_profile_id === careProfileId && r.status === 'active');
    await require('./transportService').launchTransportChoice({ appointment, careProfileId, centerId:resident?.center_id || null, notifyFamily:false });
    return { appointment, duplicate:false };
  });
  if (saved.conflict) return { ok:false, reason:'คำขอบันทึกนัดนี้ถูกใช้กับข้อมูลอื่นแล้ว' };
  const resident = await Residents.findOne((r) => r.care_profile_id === careProfileId && r.status === 'active');
  await require('./transportService').launchTransportChoice({
    appointment:saved.appointment, careProfileId, centerId:resident?.center_id || null, notifyFamily:true,
  });
  const notificationState = await require('./appointmentNotificationService').notifyLifecycle({
    eventType:'created', appointment:saved.appointment,
  });
  return { ok: true, appointment: saved.appointment, duplicate:saved.duplicate, notificationState };
}

async function addMedicationByFamily({ careProfileId, name, dose, createdBy }) {
  // Compatibility writer: append to the complete authoritative set rather
  // than creating an unsnapshotted medication row. New clients use the V2
  // complete-set route directly.
  const current = await require('./medicationRetrievalService').loadCurrentSnapshot(careProfileId);
  const result = await require('./medicationCurrentSetService').saveCompleteSet({
    careProfileId,
    baseSnapshotId:current.currentSnapshot?.snapshotId || null,
    items:[...(current.medications || []), { name, dose }],
    requester:{ lineUserId:createdBy },
    source:'family_manual',
    mutationId:`family-medication-compat:${id('MUT')}`,
  });
  const med = result.medications[result.medications.length - 1] || null;
  const resident = await Residents.findOne((r) => r.care_profile_id === careProfileId && r.status === 'active');
  if (resident?.center_id) await notifyCenterChange(resident.center_id, `💊 ครอบครัวอัปเดตรายการยาของ ${resident.full_name}\n${name} ${dose || ''}`.trim(), `family-medication:${result.currentSnapshot.snapshotId}`);
  return { ok: true, medication: med, currentMedication:result };
}

async function notifyCenterChange(centerId, text, dedupeKey) {
  const binding = await GroupBindings.findOne((g) => g.kind === 'center_staff' && g.center_id === centerId && g.status === 'active');
  if (!binding) return { ok: false, reason: 'center_group_not_bound' };
  return require('./notificationService').enqueueAndDeliver({ dedupeKey, to: binding.line_group_id, kind: 'family_health_update', meta: { centerId }, messages: [{ type: 'text', text }] });
}

async function updateFamilyAppointment({ careProfileId, appointmentId, patch, requesterLineId }) {
  if (!await canAccessProfile(careProfileId, requesterLineId)) return { ok: false, reason: 'ไม่มีสิทธิ์' };
  if (patch.datetime && isPast(patch.datetime)) return { ok: false, reason: 'วันนัดต้องเป็นเวลาในอนาคต' };
  const mutation = await withTransaction(`appointment-mutation:${appointmentId}`, async () => {
    const appointment = await Appointments.findOne((a) => a.appointment_id === appointmentId && a.care_profile_id === careProfileId && a.status !== 'cancelled');
    if (!appointment) return { missing:true };
    const requested = {};
    for (const key of ['hospital', 'datetime', 'note']) if (key in patch) requested[key] = patch[key];
    const { patch:clean, changedFields } = require('./appointmentNotificationService').materialPatch(appointment, requested);
    if (changedFields.length === 0) return { appointment, changedFields, noChange:true };
    const update = { ...clean, version:Number(appointment.version || 1) + 1, updated_at:now(), updated_by:requesterLineId,
      last_material_changed_fields:changedFields };
    if (changedFields.includes('datetime')) { update.day_before_reminded = false; update.same_day_reminded = false; }
    const updated = await Appointments.update((a) => a.appointment_id === appointmentId, update);
    return { appointment:updated, changedFields };
  });
  if (mutation.missing) return { ok: false, reason: 'ไม่พบนัด' };
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
  await audit('appointment.updated_by_family', requesterLineId, { careProfileId, appointmentId, version:mutation.appointment.version, changedFields:mutation.changedFields });
  return { ok: true, appointment: mutation.appointment, notificationState };
}

async function cancelFamilyAppointment({ careProfileId, appointmentId, requesterLineId, reason = '' }) {
  if (!await canAccessProfile(careProfileId, requesterLineId)) return { ok: false, reason: 'ไม่มีสิทธิ์' };
  const mutation = await withTransaction(`appointment-mutation:${appointmentId}`, async () => {
    const appointment = await Appointments.findOne((a) => a.appointment_id === appointmentId && a.care_profile_id === careProfileId);
    if (!appointment) return { missing:true };
    if (appointment.status === 'cancelled') return { appointment, alreadyCancelled:true };
    const updated = await Appointments.update((a) => a.appointment_id === appointmentId, {
      status:'cancelled', cancelled_at:now(), cancelled_by:requesterLineId, cancellation_reason:String(reason || '').trim(),
    });
    await require('../db').TransportPlans.updateAll((p) => p.appointment_id === appointmentId, {
      status:'cancelled', cancelled_at:now(), cancellation_reason:String(reason || '').trim(),
    });
    return { appointment:updated, alreadyCancelled:false };
  });
  if (mutation.missing) return { ok: false, reason: 'ไม่พบนัด' };
  if (mutation.alreadyCancelled) {
    const notificationState = await require('./appointmentNotificationService').notifyLifecycle({ eventType:'cancelled', appointment:mutation.appointment });
    return { ok:true, appointment:mutation.appointment, alreadyCancelled:true, notificationState };
  }
  await require('./transportService').notifyAppointmentChanged(appointmentId, 'cancelled', requesterLineId);
  const notificationState = await require('./appointmentNotificationService').notifyLifecycle({ eventType:'cancelled', appointment:mutation.appointment });
  await audit('appointment.cancelled_by_family', requesterLineId, { careProfileId, appointmentId, reason });
  return { ok: true, appointment: mutation.appointment, notificationState };
}

// ── FR-H3: ไทม์ไลน์ย้อนหลัง (กรองนัดที่ผ่านแล้วออกจาก "นัดใกล้ถึง" แต่ยังอยู่ในประวัติ — ข้อ G3) ──
async function getUpcomingAppointments(careProfileId) {
  const all = await Appointments.findWhere((a) => a.care_profile_id === careProfileId);
  return all.filter((a) => !isPast(a.datetime)).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

async function getFullHistory(careProfileId) {
  const appts = await Appointments.findWhere((a) => a.care_profile_id === careProfileId);
  const current = await require('./medicationRetrievalService').loadCurrentSnapshot(careProfileId);
  return { appointments: appts.sort((a, b) => new Date(b.datetime) - new Date(a.datetime)), medications: current.medications };
}

// ── FR-H4: ส่งออกประวัติเป็น PDF จริง (คืน Buffer ให้ Route ตัดสินใจว่าจะส่งแบบ Download หรืออัปโหลด Storage) ──
async function exportHistoryToPdf(careProfileId, { fromDate, toDate } = {}) {
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId);
  if (!profile) return { ok: false, reason: 'ไม่พบข้อมูล' };

  let exportData;
  try {
    exportData = await require('./healthHistoryExportService').createHealthHistoryExportService()
      .build({ careProfileId, fromDate, toDate });
  } catch (error) {
    if (error?.name === 'HealthHistoryExportError') return { ok:false, reason:error.message, errorCode:error.code };
    throw error;
  }
  const pdfBuffer = await pdfService.generateHistoryPdf({ profile, ...exportData, fromDate, toDate });

  return {
    ok: true,
    pdfBuffer,
    recordCount: exportData.appointments.length + exportData.currentMedications.length
      + exportData.medicationHistory.length + exportData.healthReports.length + exportData.standaloneVitals.length,
    filename: `พี่หมอ-${profile.patient_name || 'ประวัติสุขภาพ'}-${Date.now()}.pdf`, // ชื่อไฟล์จริงที่อยากให้ผู้ใช้เห็น (มีภาษาไทยได้)
    asciiFilename: `phimor-health-history-${Date.now()}.pdf`, // ASCII fallback must not expose a raw Care Profile ID.
  };
}

// ── FR-N2, N3, N4: จำกัดฟีเจอร์ AI สำหรับ Care Profile อิสระ ──
function canUseAiFeatures(careProfile) {
  return careProfile.status === 'linked' && !!careProfile.center_id;
}

const AI_RESTRICTED_MESSAGE =
  'ฟีเจอร์อ่านเอกสารอัตโนมัติใช้ได้เมื่อผู้สูงอายุอยู่ในความดูแลของศูนย์ที่ร่วมกับพี่หมอ '
  + 'ตอนนี้บันทึกนัดด้วยการพิมพ์ได้เลยค่ะ'; // ข้อ N4 — ต้องไม่รู้สึกถูกกีดกัน

module.exports = {
  recordConsent, getConsentState, hasValidConsent, acceptInvite, declineInvite, createIndependentProfile, bindFamilyGroup, bindFamilyGroupInCurrentTransaction,
  addAppointmentByFamily, addMedicationByFamily, getUpcomingAppointments, getFullHistory,
  exportHistoryToPdf, canUseAiFeatures, AI_RESTRICTED_MESSAGE, CONSENT_VERSION,
  recordMedicationSnapshot, getMedicationHistory, createCaregiverInvite, getCaregiverInvite, acceptCaregiverInvite, canAccessProfile, hasPermission,
  listCaregivers, caregiverByMemberId, revokeCaregiver, updateCaregiverPermissions, leaveCareProfile, updateFamilyAppointment, cancelFamilyAppointment,
};
