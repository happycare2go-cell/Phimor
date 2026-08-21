// services/familyService.js — FR-H (ฝั่งครอบครัว) และ FR-N (Care Profile อิสระ)

const { CareProfiles, Residents, Invites, Appointments, Medications, MedicationSnapshots, GroupBindings, Consents, CareProfileMembers, CareProfileShareInvites, AccessRequests, audit, id, now, withTransaction } = require('../db');
const { isPast } = require('./cardService');
const pdfService = require('./pdfService');

const CONSENT_VERSION = '2569-08-1'; // ข้อ H6: ต้องบันทึกเวอร์ชันเอกสารที่ยอมรับ

// ── FR-H6: บันทึกยินยอม PDPA — ต้องผ่านก่อนเข้าหน้าหลักได้ ──
async function recordConsent(lineUserId, accepted) {
  const consent = await Consents.insert({
    consent_id: id('CNS'), line_user_id: lineUserId, accepted, version: CONSENT_VERSION, at: now(),
  });
  return consent;
}

async function hasValidConsent(lineUserId) {
  const c = await Consents.findOne((x) => x.line_user_id === lineUserId && x.accepted && x.version === CONSENT_VERSION);
  return !!c;
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

async function acceptCaregiverInvite(token, lineUserId) {
  const found = await getCaregiverInvite(token); if (!found.ok) return found;
  if (found.invite.created_by === lineUserId) return { ok:false, reason:'เจ้าของ Care Profile ไม่จำเป็นต้องรับคำเชิญของตนเอง' };
  let member = await CareProfileMembers.findOne((m) => m.care_profile_id === found.invite.care_profile_id && m.line_user_id === lineUserId);
  if (member) member = await CareProfileMembers.update((m) => m.member_id === member.member_id, { status:'active', role:'caregiver', rejoined_at:now() });
  else member = await CareProfileMembers.insert({ member_id:id('CPM'), care_profile_id:found.invite.care_profile_id, line_user_id:lineUserId, role:'caregiver', status:'active', permissions:['view','edit_profile','manage_appointments','manage_medications','decide_transport'], joined_at:now(), invited_by:found.invite.created_by });
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
  const permissions = member?.permissions || ['view','edit_profile','manage_appointments','manage_medications','decide_transport'];
  return permissions.includes(permission);
}

// ── FR-H1: ผูกบัญชีผ่านลิงก์เชิญ → สร้าง Care Profile โดยครอบครัวเป็นเจ้าของ ──
async function acceptInvite(token, lineUserId, profileData = {}) {
  return withTransaction(`invite:${token}`, async () => {
  const invite = await Invites.findOne((i) => i.invite_token === token);
  if (!invite) return { ok: false, reason: 'ลิงก์เชิญไม่ถูกต้อง' };
  if (invite.used_at || invite.status === 'revoked') return { ok: false, reason: 'ลิงก์เชิญนี้ถูกใช้หรือยกเลิกแล้ว' };
  if (new Date(invite.expires_at).getTime() < Date.now()) return { ok: false, reason: 'ลิงก์เชิญหมดอายุแล้ว' };

  const resident = await Residents.findOne((r) => r.resident_id === invite.resident_id);
  if (!resident || resident.status !== 'active') return { ok: false, reason: 'ผู้พักไม่ได้อยู่ในศูนย์นี้แล้ว' };
  if (resident.care_profile_id) return { ok: false, reason: 'ผู้พักรายนี้ผูก Care Profile แล้ว กรุณาเปิด Family LIFF เพื่อตรวจสอบ' };

  const profile = await CareProfiles.insert({
    care_profile_id: id('CP'),
    owner_line_id: lineUserId,
    patient_name: resident.full_name,
    center_id: resident.center_id,
    family_phone: resident.family_phone || null, // เก็บเบอร์ไว้ด้วย เผื่อข้อ O1 ต้องค้นหาเบอร์นี้ในอนาคต
    status: 'linked', // linked | independent
    gender: profileData.gender || null,
    blood_type: profileData.bloodType || null,
    height_cm: profileData.heightCm ? Number(profileData.heightCm) : null,
    weight_kg: profileData.weightKg ? Number(profileData.weightKg) : null,
    chronic_conditions: Array.isArray(profileData.chronicConditions) ? profileData.chronicConditions : [],
    drug_allergies: profileData.drugAllergies || '', food_allergies: profileData.foodAllergies || '',
    mobility_limitations: profileData.mobilityLimitations || '',
    emergency_contact_name: profileData.emergencyContactName || '',
    emergency_contact_phone: profileData.emergencyContactPhone || '',
    created_at: now(),
  });

  await Residents.update((r) => r.resident_id === resident.resident_id && r.status === 'active' && !r.care_profile_id, { care_profile_id: profile.care_profile_id, link_status: 'linked' });
  await Invites.update((i) => i.invite_token === token && !i.used_at, { used_at: now(), used_by: lineUserId, status: 'used' });
  await AccessRequests.updateAll((r) => r.resident_id === resident.resident_id && r.status === 'pending', { status: 'superseded', responded_at: now() });
  await audit('family.invite_accepted', lineUserId, { residentId: resident.resident_id, careProfileId: profile.care_profile_id });
  await require('./deliveryService').deliverPendingForResident(resident.resident_id, profile.care_profile_id);

  return { ok: true, careProfile: profile };
  });
}

async function listCaregivers(careProfileId, requesterLineId) {
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId && p.owner_line_id === requesterLineId);
  if (!profile) return { ok: false, reason: 'เฉพาะเจ้าของ Care Profile เท่านั้น' };
  const members = await CareProfileMembers.findWhere((m) => m.care_profile_id === careProfileId && m.status === 'active');
  const invites = await CareProfileShareInvites.findWhere((i) => i.care_profile_id === careProfileId && i.status === 'active');
  return { ok: true, ownerLineId: profile.owner_line_id, members, invites };
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
async function bindFamilyGroup({ careProfileId, groupId, requesterLineId }) {
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId);
  if (!profile) return { ok: false, reason: 'ไม่พบ Care Profile' };
  if (profile.owner_line_id !== requesterLineId) return { ok: false, reason: 'เฉพาะเจ้าของ Care Profile เท่านั้นที่ผูกกลุ่มได้' };

  const conflict = await GroupBindings.findOne(
    (g) => g.line_group_id === groupId && g.status !== 'inactive'
      && !(g.kind === 'family' && g.care_profile_id === careProfileId)
  );
  if (conflict) return { ok: false, reason: 'กลุ่มนี้ถูกผูกกับศูนย์หรือ Care Profile อื่นแล้ว' };
  const previous = await GroupBindings.findOne(
    (g) => g.kind === 'family' && g.care_profile_id === careProfileId && g.status !== 'inactive'
  );
  if (previous && previous.line_group_id === groupId) return { ok: true, existing: true };
  if (previous) await GroupBindings.update((g) => g.binding_id === previous.binding_id, { status: 'inactive', unbound_at: now() });
  await GroupBindings.insert({
    binding_id: id('GB'), care_profile_id: careProfileId, line_group_id: groupId, kind: 'family', bound_at: now(),
    center_id: null, status: 'active', bound_by_line_user_id: requesterLineId,
  });
  return { ok: true };
}

async function recordMedicationSnapshot({ careProfileId, items, recordedBy, source = 'manual', sourceImageBase64 = null }) {
  const cleanItems = (Array.isArray(items) ? items : []).map((item) => ({
    name: String(item.name || '').trim(), dose: String(item.dose || '').trim(),
    condition: String(item.condition || '').trim(), note: String(item.note || '').trim(),
  })).filter((item) => item.name);
  if (cleanItems.length === 0) return { ok: false, reason: 'กรุณาระบุรายการยาอย่างน้อยหนึ่งรายการ' };
  const snapshot = await MedicationSnapshots.insert({
    snapshot_id: id('MEDS'), care_profile_id: careProfileId, items: cleanItems,
    source, source_image_base64: sourceImageBase64, recorded_by: recordedBy, recorded_at: now(),
  });
  for (const item of cleanItems) {
    await Medications.insert({ medication_id: id('MED'), care_profile_id: careProfileId, ...item,
      snapshot_id: snapshot.snapshot_id, source, created_by: recordedBy, created_at: now() });
  }
  return { ok: true, snapshot };
}

async function getMedicationHistory(careProfileId) {
  return MedicationSnapshots.findWhere((s) => s.care_profile_id === careProfileId);
}

// ── FR-H2: บันทึกนัด/ยาด้วยตนเอง (ใช้ร่วมกันได้ทั้ง linked และ independent) ──
async function addAppointmentByFamily({ careProfileId, hospital, datetime, note, createdBy }) {
  if (isPast(datetime)) return { ok: false, reason: 'ไม่สามารถบันทึกนัดที่เป็นเวลาในอดีตได้' }; // ข้อ G2
  const appt = await Appointments.insert({
    appointment_id: id('APT'), care_profile_id: careProfileId, hospital, datetime, note: note || '',
    source: 'family_manual', source_center_id: null, created_by: createdBy, created_at: now(), status:'confirmed', // ข้อ J5
  });
  const { Residents } = require('../db');
  const resident = await Residents.findOne((r) => r.care_profile_id === careProfileId && r.status === 'active');
  await require('./transportService').launchTransportChoice({ appointment:appt, careProfileId, centerId:resident?.center_id || null });
  if (resident?.center_id) await notifyCenterChange(resident.center_id, `📅 ครอบครัวเพิ่มนัดใหม่ของ ${resident.full_name}\n${hospital} · ${datetime}`, `family-appointment:${appt.appointment_id}`);
  return { ok: true, appointment: appt };
}

async function addMedicationByFamily({ careProfileId, name, dose, createdBy }) {
  const med = await Medications.insert({
    medication_id: id('MED'), care_profile_id: careProfileId, name, dose,
    source: 'family_manual', source_center_id: null, created_at: now(),
  });
  const resident = await Residents.findOne((r) => r.care_profile_id === careProfileId && r.status === 'active');
  if (resident?.center_id) await notifyCenterChange(resident.center_id, `💊 ครอบครัวอัปเดตรายการยาของ ${resident.full_name}\n${name} ${dose || ''}`.trim(), `family-medication:${med.medication_id}`);
  return { ok: true, medication: med };
}

async function notifyCenterChange(centerId, text, dedupeKey) {
  const binding = await GroupBindings.findOne((g) => g.kind === 'center_staff' && g.center_id === centerId && g.status === 'active');
  if (!binding) return { ok: false, reason: 'center_group_not_bound' };
  return require('./notificationService').enqueueAndDeliver({ dedupeKey, to: binding.line_group_id, kind: 'family_health_update', meta: { centerId }, messages: [{ type: 'text', text }] });
}

async function updateFamilyAppointment({ careProfileId, appointmentId, patch, requesterLineId }) {
  if (!await canAccessProfile(careProfileId, requesterLineId)) return { ok: false, reason: 'ไม่มีสิทธิ์' };
  const appointment = await Appointments.findOne((a) => a.appointment_id === appointmentId && a.care_profile_id === careProfileId && a.status !== 'cancelled');
  if (!appointment) return { ok: false, reason: 'ไม่พบนัด' };
  if (patch.datetime && isPast(patch.datetime)) return { ok: false, reason: 'วันนัดต้องเป็นเวลาในอนาคต' };
  const clean = {}; for (const key of ['hospital', 'datetime', 'note']) if (key in patch) clean[key] = patch[key];
  const version = Number(appointment.version || 1) + 1;
  const updated = await Appointments.update((a) => a.appointment_id === appointmentId, { ...clean, version, updated_at: now(), updated_by: requesterLineId, day_before_reminded: false, same_day_reminded: false });
  await require('./transportService').notifyAppointmentChanged(appointmentId, 'updated', requesterLineId);
  await audit('appointment.updated_by_family', requesterLineId, { careProfileId, appointmentId, version });
  return { ok: true, appointment: updated };
}

async function cancelFamilyAppointment({ careProfileId, appointmentId, requesterLineId, reason = '' }) {
  if (!await canAccessProfile(careProfileId, requesterLineId)) return { ok: false, reason: 'ไม่มีสิทธิ์' };
  const appointment = await Appointments.findOne((a) => a.appointment_id === appointmentId && a.care_profile_id === careProfileId);
  if (!appointment) return { ok: false, reason: 'ไม่พบนัด' };
  if (appointment.status === 'cancelled') return { ok: true, appointment, alreadyCancelled: true };
  const updated = await Appointments.update((a) => a.appointment_id === appointmentId, { status: 'cancelled', cancelled_at: now(), cancelled_by: requesterLineId, cancellation_reason: reason });
  await require('../db').TransportPlans.updateAll((p) => p.appointment_id === appointmentId, { status: 'cancelled', cancelled_at: now(), cancellation_reason: reason });
  await require('./transportService').notifyAppointmentChanged(appointmentId, 'cancelled', requesterLineId);
  await audit('appointment.cancelled_by_family', requesterLineId, { careProfileId, appointmentId, reason });
  return { ok: true, appointment: updated };
}

// ── FR-H3: ไทม์ไลน์ย้อนหลัง (กรองนัดที่ผ่านแล้วออกจาก "นัดใกล้ถึง" แต่ยังอยู่ในประวัติ — ข้อ G3) ──
async function getUpcomingAppointments(careProfileId) {
  const all = await Appointments.findWhere((a) => a.care_profile_id === careProfileId);
  return all.filter((a) => !isPast(a.datetime)).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

async function getFullHistory(careProfileId) {
  const appts = await Appointments.findWhere((a) => a.care_profile_id === careProfileId);
  const meds = await Medications.findWhere((m) => m.care_profile_id === careProfileId);
  return { appointments: appts.sort((a, b) => new Date(b.datetime) - new Date(a.datetime)), medications: meds };
}

// ── FR-H4: ส่งออกประวัติเป็น PDF จริง (คืน Buffer ให้ Route ตัดสินใจว่าจะส่งแบบ Download หรืออัปโหลด Storage) ──
async function exportHistoryToPdf(careProfileId, { fromDate, toDate } = {}) {
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId);
  if (!profile) return { ok: false, reason: 'ไม่พบข้อมูล' };

  const start = fromDate ? new Date(`${fromDate}T00:00:00.000+07:00`) : null;
  const end = toDate ? new Date(`${toDate}T23:59:59.999+07:00`) : null;
  if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) {
    return { ok: false, reason: 'รูปแบบช่วงวันที่ไม่ถูกต้อง' };
  }
  if (start && end && start > end) return { ok: false, reason: 'วันที่เริ่มต้องไม่อยู่หลังวันที่สิ้นสุด' };

  const { appointments, medications } = await getFullHistory(careProfileId);
  const filteredAppointments = appointments.filter((a) => {
    const at = new Date(a.datetime);
    if (start && at < start) return false;
    if (end && at > end) return false;
    return true;
  });
  const filteredMedications = medications.filter((m) => {
    const raw = m.created_at || m.recorded_at;
    if (!raw) return true; // เก็บข้อมูล legacy ที่ไม่มีเวลาไว้เพื่อไม่ให้ยาสำคัญหายจากรายงาน
    const at = new Date(raw);
    if (start && at < start) return false;
    if (end && at > end) return false;
    return true;
  }).sort((a, b) => new Date(b.created_at || b.recorded_at || 0) - new Date(a.created_at || a.recorded_at || 0));

  const pdfBuffer = await pdfService.generateHistoryPdf({
    profile, appointments: filteredAppointments, medications: filteredMedications, fromDate, toDate,
  });

  return {
    ok: true,
    pdfBuffer,
    recordCount: filteredAppointments.length + filteredMedications.length,
    filename: `พี่หมอ-${profile.patient_name || 'ประวัติสุขภาพ'}-${Date.now()}.pdf`, // ชื่อไฟล์จริงที่อยากให้ผู้ใช้เห็น (มีภาษาไทยได้)
    asciiFilename: `phimor-history-${careProfileId}-${Date.now()}.pdf`,             // ★ ใช้ใส่ HTTP Header ตรงๆ ต้องเป็น ASCII ล้วนเท่านั้น
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
  recordConsent, hasValidConsent, acceptInvite, createIndependentProfile, bindFamilyGroup,
  addAppointmentByFamily, addMedicationByFamily, getUpcomingAppointments, getFullHistory,
  exportHistoryToPdf, canUseAiFeatures, AI_RESTRICTED_MESSAGE, CONSENT_VERSION,
  recordMedicationSnapshot, getMedicationHistory, createCaregiverInvite, getCaregiverInvite, acceptCaregiverInvite, canAccessProfile, hasPermission,
  listCaregivers, revokeCaregiver, updateCaregiverPermissions, leaveCareProfile, updateFamilyAppointment, cancelFamilyAppointment,
};
