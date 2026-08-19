// services/familyService.js — FR-H (ฝั่งครอบครัว) และ FR-N (Care Profile อิสระ)

const { CareProfiles, Residents, Invites, Appointments, Medications, GroupBindings, Consents, audit, id, now } = require('../db');
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

// ── FR-H1: ผูกบัญชีผ่านลิงก์เชิญ → สร้าง Care Profile โดยครอบครัวเป็นเจ้าของ ──
async function acceptInvite(token, lineUserId) {
  const invite = await Invites.findOne((i) => i.invite_token === token);
  if (!invite) return { ok: false, reason: 'ลิงก์เชิญไม่ถูกต้อง' };
  if (invite.used_at) return { ok: false, reason: 'ลิงก์เชิญนี้ถูกใช้ไปแล้ว' };
  if (new Date(invite.expires_at).getTime() < Date.now()) return { ok: false, reason: 'ลิงก์เชิญหมดอายุแล้ว' };

  const resident = await Residents.findOne((r) => r.resident_id === invite.resident_id);
  if (!resident) return { ok: false, reason: 'ไม่พบข้อมูลผู้พัก' };

  const profile = await CareProfiles.insert({
    care_profile_id: id('CP'),
    owner_line_id: lineUserId,
    patient_name: resident.full_name,
    center_id: resident.center_id,
    family_phone: resident.family_phone || null, // เก็บเบอร์ไว้ด้วย เผื่อข้อ O1 ต้องค้นหาเบอร์นี้ในอนาคต
    status: 'linked', // linked | independent
    blood_type: null, height_cm: null, weight_kg: null, chronic_conditions: [],
    created_at: now(),
  });

  await Residents.update((r) => r.resident_id === resident.resident_id, { care_profile_id: profile.care_profile_id });
  await Invites.update((i) => i.invite_token === token, { used_at: now() });
  await audit('family.invite_accepted', lineUserId, { residentId: resident.resident_id, careProfileId: profile.care_profile_id });

  return { ok: true, careProfile: profile };
}

// ── FR-N1: ครอบครัวสร้าง Care Profile เองได้โดยไม่ผ่านศูนย์ ──
// familyPhone เก็บไว้ด้วย (Optional) เพื่อให้ข้อ O1 ค้นหาเจอ ถ้าศูนย์เพิ่มผู้พักด้วยเบอร์เดียวกันทีหลัง
async function createIndependentProfile({ ownerLineId, patientName, familyPhone }) {
  const profile = await CareProfiles.insert({
    care_profile_id: id('CP'),
    owner_line_id: ownerLineId,
    patient_name: patientName,
    center_id: null,
    family_phone: familyPhone || null,
    status: 'independent',
    blood_type: null, height_cm: null, weight_kg: null, chronic_conditions: [],
    created_at: now(),
  });
  return profile;
}

// ── FR-N1: ผูกกลุ่มไลน์ครอบครัวด้วยตนเอง ──
async function bindFamilyGroup({ careProfileId, groupId, requesterLineId }) {
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId);
  if (!profile) return { ok: false, reason: 'ไม่พบ Care Profile' };
  if (profile.owner_line_id !== requesterLineId) return { ok: false, reason: 'เฉพาะเจ้าของ Care Profile เท่านั้นที่ผูกกลุ่มได้' };

  await GroupBindings.insert({
    binding_id: id('GB'), care_profile_id: careProfileId, line_group_id: groupId, kind: 'family', bound_at: now(),
  });
  return { ok: true };
}

// ── FR-H2: บันทึกนัด/ยาด้วยตนเอง (ใช้ร่วมกันได้ทั้ง linked และ independent) ──
async function addAppointmentByFamily({ careProfileId, hospital, datetime, note, createdBy }) {
  if (isPast(datetime)) return { ok: false, reason: 'ไม่สามารถบันทึกนัดที่เป็นเวลาในอดีตได้' }; // ข้อ G2
  const appt = await Appointments.insert({
    appointment_id: id('APT'), care_profile_id: careProfileId, hospital, datetime, note: note || '',
    source: 'family_manual', source_center_id: null, created_by: createdBy, created_at: now(), // ข้อ J5: ระบุชัดว่าไม่มีศูนย์เกี่ยวข้อง
  });
  return { ok: true, appointment: appt };
}

async function addMedicationByFamily({ careProfileId, name, dose, createdBy }) {
  const med = await Medications.insert({
    medication_id: id('MED'), care_profile_id: careProfileId, name, dose,
    source: 'family_manual', source_center_id: null, created_at: now(),
  });
  return { ok: true, medication: med };
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

  const { appointments, medications } = await getFullHistory(careProfileId);
  const filteredAppointments = appointments.filter((a) => {
    if (fromDate && new Date(a.datetime) < new Date(fromDate)) return false;
    if (toDate && new Date(a.datetime) > new Date(toDate)) return false;
    return true;
  });

  const pdfBuffer = await pdfService.generateHistoryPdf({
    profile, appointments: filteredAppointments, medications, fromDate, toDate,
  });

  return {
    ok: true,
    pdfBuffer,
    recordCount: filteredAppointments.length + medications.length,
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
};
