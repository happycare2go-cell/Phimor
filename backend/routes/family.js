// routes/family.js — Endpoint ตาม Technical Design หมวด 5.4

const express = require('express');
const router = express.Router();
const { requireAuth, requireFamilyAccess } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const familyService = require('../services/familyService');
const privacyService = require('../services/privacyService');
const healthHistoryService = require('../services/careProfileHealthHistoryService');
const { CareProfiles, CareProfileMembers } = require('../db');

const PDF_LINK_TTL_MS = 5 * 60 * 1000;
const { signPdfToken } = require('../utils/pdfDownloadToken');

function sendPdf(res, result, disposition = 'attachment') {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', disposition + '; filename="' + result.asciiFilename + '"; filename*=UTF-8' + "''" + encodeURIComponent(result.filename));
  res.send(result.pdfBuffer);
}

router.use(requireAuth);

// GET /api/invite/:token — ตรวจสอบลิงก์เชิญ
router.get('/invite/:token', asyncHandler(async (req, res) => {
  const { Invites, Residents } = require('../db');
  const invite = await Invites.findOne((i) => i.invite_token === req.params.token);
  if (!invite) return res.status(404).json({ error: 'not_found', message: 'ลิงก์เชิญไม่ถูกต้อง' });
  if (invite.used_at || invite.status === 'revoked') return res.status(410).json({ error: 'gone', message: 'ลิงก์เชิญนี้ถูกใช้หรือยกเลิกแล้ว' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'gone', message: 'ลิงก์เชิญหมดอายุแล้ว' });
  const resident = await Residents.findOne((r) => r.resident_id === invite.resident_id && r.status === 'active');
  const existingProfile = resident?.care_profile_id && await CareProfiles.findOne((p) => p.care_profile_id === resident.care_profile_id);
  if (existingProfile?.owner_line_id) return res.status(410).json({ error: 'gone', message: 'ผู้พักรายนี้มีเจ้าของ Care Profile แล้ว' });
  if (!resident) return res.status(410).json({ error: 'gone', message: 'ผู้พักรายนี้ถูกเชื่อมแล้วหรือไม่ได้อยู่ในศูนย์นี้' });
  res.json({ residentName: resident?.full_name, centerId: resident?.center_id, expiresAt: invite.expires_at });
}));

// POST /api/invite/:token/accept — ยอมรับคำเชิญ สร้าง Care Profile
router.post('/invite/:token/accept', asyncHandler(async (req, res) => {
  const hasConsent = await familyService.hasValidConsent(req.user.lineUserId);
  if (!hasConsent) {
    return res.status(412).json({ error: 'consent_required', message: 'กรุณายืนยันความยินยอมก่อนใช้งาน' }); // ข้อ H6
  }
  const result = await familyService.acceptInvite(req.params.token, req.user.lineUserId, req.body || {});
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.status(201).json(result.careProfile);
}));

// GET /api/consent/check — ตรวจสอบว่าเคยยินยอมแล้วหรือยัง (ข้อ H6 — ใช้ตัดสินใจว่าจะบล็อกหน้าหลักไหม)
router.get('/consent/check', asyncHandler(async (req, res) => {
  res.json(await familyService.getConsentState(req.user.lineUserId));
}));

// POST /api/consent — บันทึกการยินยอม PDPA (ข้อ H6)
router.post('/consent', asyncHandler(async (req, res) => {
  const { accepted } = req.body;
  if (accepted !== true) return res.status(400).json({ error:'confirmation_required', message:'กรุณายืนยันว่าต้องการให้ความยินยอม' });
  await familyService.recordConsent(req.user.lineUserId, true);
  res.status(201).json(await familyService.getConsentState(req.user.lineUserId));
}));

router.post('/consent/withdraw', asyncHandler(async (req, res) => {
  if (req.body?.confirmed !== true) return res.status(400).json({ error:'confirmation_required', message:'กรุณายืนยันการถอนความยินยอม' });
  const before = await familyService.getConsentState(req.user.lineUserId);
  if (before.status !== 'withdrawn') await familyService.recordConsent(req.user.lineUserId, false);
  res.json({ ok:true, consent:await familyService.getConsentState(req.user.lineUserId), message:'บันทึกการถอนความยินยอมแล้ว ข้อมูลเดิมไม่ได้ถูกลบอัตโนมัติ' });
}));

router.post('/data-requests', asyncHandler(async (req, res) => {
  try {
    const result = await privacyService.createRequest({
      lineUserId:req.user.lineUserId, displayName:req.user.claims?.name,
      type:req.body?.type, note:req.body?.note,
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    if (error instanceof privacyService.PrivacyRequestError) return res.status(error.status).json({ error:error.code, message:error.message });
    throw error;
  }
}));

router.get('/data-requests', asyncHandler(async (req, res) => {
  res.json({ requests:await privacyService.listOwnRequests(req.user.lineUserId) });
}));

router.get('/data-requests/:requestId', asyncHandler(async (req, res) => {
  try {
    res.json({ request:await privacyService.getOwnRequest({ lineUserId:req.user.lineUserId, requestId:req.params.requestId }) });
  } catch (error) {
    if (error instanceof privacyService.PrivacyRequestError) return res.status(error.status).json({ error:error.code, message:error.message });
    throw error;
  }
}));

// POST /api/care-profile/independent — สร้าง Care Profile อิสระเอง (ข้อ N1)
router.post('/care-profile/independent', asyncHandler(async (req, res) => {
  const hasConsent = await familyService.hasValidConsent(req.user.lineUserId);
  if (!hasConsent) return res.status(412).json({ error: 'consent_required', message: 'กรุณายืนยันความยินยอมก่อนใช้งาน' });
  const { patientName, familyPhone, gender, bloodType, heightCm, weightKg, chronicConditions,
    drugAllergies, foodAllergies, mobilityLimitations, emergencyContactName, emergencyContactPhone } = req.body;
  if (!patientName) return res.status(400).json({ error: 'bad_request', message: 'กรุณาระบุชื่อ' });
  const profile = await familyService.createIndependentProfile({ ownerLineId: req.user.lineUserId, patientName, familyPhone,
    gender, bloodType, heightCm, weightKg, chronicConditions, drugAllergies, foodAllergies,
    mobilityLimitations, emergencyContactName, emergencyContactPhone });
  res.status(201).json(profile);
}));

router.post('/care-profile/:careProfileId/caregiver-invites', requireFamilyAccess(), asyncHandler(async (req, res) => {
  if (req.familyRole !== 'owner') return res.status(403).json({ error:'forbidden', message:'เฉพาะเจ้าของ Care Profile หลักเท่านั้นที่เชิญญาติได้' });
  const result = await familyService.createCaregiverInvite({ careProfileId:req.params.careProfileId, requesterLineId:req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error:'bad_request', message:result.reason });
  res.status(201).json({ url:result.url, expiresAt:result.invite.expires_at });
}));

router.get('/caregiver-invites/:token', asyncHandler(async (req, res) => {
  const result = await familyService.getCaregiverInvite(req.params.token);
  if (!result.ok) return res.status(410).json({ error:'gone', message:result.reason });
  res.json({ patientName:result.patientName, expiresAt:result.invite.expires_at });
}));

router.post('/caregiver-invites/:token/accept', asyncHandler(async (req, res) => {
  if (!await familyService.hasValidConsent(req.user.lineUserId)) return res.status(412).json({ error:'consent_required', message:'กรุณายืนยันความยินยอมก่อนใช้งาน' });
  const result = await familyService.acceptCaregiverInvite(req.params.token, req.user.lineUserId, { displayName:req.user.claims?.name });
  if (!result.ok) return res.status(400).json({ error:'bad_request', message:result.reason });
  res.status(201).json({ memberId:result.member.member_id, role:result.member.role, status:result.member.status });
}));

router.get('/care-profile/:careProfileId/caregivers', requireFamilyAccess(), asyncHandler(async (req, res) => {
  if (req.familyRole !== 'owner') return res.status(403).json({ error: 'forbidden' });
  const result = await familyService.listCaregivers(req.params.careProfileId, req.user.lineUserId);
  res.json(result);
}));

router.delete('/care-profile/:careProfileId/caregivers/member/:memberId', requireFamilyAccess(), asyncHandler(async (req, res) => {
  const member = await familyService.caregiverByMemberId({ careProfileId:req.params.careProfileId, memberId:req.params.memberId, requesterLineId:req.user.lineUserId });
  if (!member) return res.status(404).json({ error:'not_found', message:'ไม่พบผู้ดูแลร่วม' });
  const result = await familyService.revokeCaregiver({ careProfileId:req.params.careProfileId, targetLineId:member.line_user_id, requesterLineId:req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error:'bad_request', message:result.reason });
  res.json(result);
}));

router.patch('/care-profile/:careProfileId/caregivers/member/:memberId', requireFamilyAccess(), asyncHandler(async (req, res) => {
  const member = await familyService.caregiverByMemberId({ careProfileId:req.params.careProfileId, memberId:req.params.memberId, requesterLineId:req.user.lineUserId });
  if (!member) return res.status(404).json({ error:'not_found', message:'ไม่พบผู้ดูแลร่วม' });
  const result = await familyService.updateCaregiverPermissions({ careProfileId:req.params.careProfileId, targetLineId:member.line_user_id, permissions:req.body.permissions, requesterLineId:req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error:'bad_request', message:result.reason });
  res.json({ memberId:result.member.member_id, permissions:result.member.permissions });
}));

router.delete('/care-profile/:careProfileId/caregivers/:targetLineId', requireFamilyAccess(), asyncHandler(async (req, res) => {
  const result = await familyService.revokeCaregiver({ careProfileId: req.params.careProfileId, targetLineId: req.params.targetLineId, requesterLineId: req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json(result);
}));

router.patch('/care-profile/:careProfileId/caregivers/:targetLineId', requireFamilyAccess(), asyncHandler(async (req, res) => {
  const result = await familyService.updateCaregiverPermissions({ careProfileId:req.params.careProfileId, targetLineId:req.params.targetLineId, permissions:req.body.permissions, requesterLineId:req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error:'bad_request', message:result.reason });
  res.json({ memberId:result.member.member_id, permissions:result.member.permissions, status:result.member.status });
}));

router.post('/care-profile/:careProfileId/leave', requireFamilyAccess(), asyncHandler(async (req, res) => {
  if (req.familyRole === 'owner') return res.status(400).json({ error: 'bad_request', message: 'เจ้าของหลักต้องโอนสิทธิ์ก่อน จึงออกจาก Care Profile ได้' });
  const result = await familyService.leaveCareProfile({ careProfileId: req.params.careProfileId, lineUserId: req.user.lineUserId });
  res.json(result);
}));

// POST /api/care-profile/:id/bind-group — ผูกกลุ่มไลน์ครอบครัวด้วยตนเอง (ข้อ N1)
router.post('/care-profile/:careProfileId/bind-group', requireFamilyAccess(), asyncHandler(async (req, res) => {
  const { groupId } = req.body;
  const result = await familyService.bindFamilyGroup({ careProfileId: req.params.careProfileId, groupId, requesterLineId: req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json({ ok: true });
}));

// GET /api/init-dashboard — ข้อมูลหน้าหลักทั้งหมดในการเรียกครั้งเดียว
router.get('/init-dashboard', asyncHandler(async (req, res) => {
  const memberships = await CareProfileMembers.findWhere((m) => m.line_user_id === req.user.lineUserId && m.status === 'active');
  const memberIds = new Set(memberships.map((m) => m.care_profile_id));
  const profiles = await CareProfiles.findWhere((p) => p.owner_line_id === req.user.lineUserId || memberIds.has(p.care_profile_id));
  const data = await Promise.all(profiles.map(async (p) => ({
    profile: p,
    familyRole: p.owner_line_id === req.user.lineUserId ? 'owner' : 'caregiver',
    upcomingAppointments: await familyService.getUpcomingAppointments(p.care_profile_id),
    canUseAi: familyService.canUseAiFeatures(p),
  })));
  res.json({ profiles: data });
}));

// PATCH /api/care-profile/:id — แก้ไขข้อมูลสุขภาพ
router.patch('/care-profile/:careProfileId', requireFamilyAccess(), asyncHandler(async (req, res) => {
  if (!req.familyPermissions.includes('*') && !req.familyPermissions.includes('edit_profile')) return res.status(403).json({ error:'forbidden', message:'ไม่มีสิทธิ์แก้ไขข้อมูลสุขภาพ' });
  try {
    const result = await healthHistoryService.updateCareProfileHealth({
      careProfileId: req.params.careProfileId,
      lineUserId: req.user.lineUserId,
      patch: req.body,
      source: 'family_liff',
    });
    res.json(result.profile);
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error:error.code || 'health_history_error', message:error.message });
    throw error;
  }
}));

router.get('/care-profile/:careProfileId/health-history', requireFamilyAccess(), asyncHandler(async (req, res) => {
  if (!req.familyPermissions.includes('*') && !req.familyPermissions.includes('edit_profile')) return res.status(403).json({ error:'forbidden', message:'ไม่มีสิทธิ์ดูประวัติข้อมูลสุขภาพ' });
  try {
    const result = await healthHistoryService.getCareProfileHealthHistory({
      careProfileId: req.params.careProfileId,
      lineUserId: req.user.lineUserId,
      audience: 'family',
      limit: req.query.limit,
      cursor: req.query.cursor,
      field: req.query.field,
    });
    res.json(result);
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error:error.code || 'health_history_error', message:error.message });
    throw error;
  }
}));

// GET/POST /api/appointments — จัดการนัดหมาย
router.get('/appointments', requireFamilyAccess(), asyncHandler(async (req, res) => {
  const upcoming = await familyService.getUpcomingAppointments(req.params.careProfileId || req.query.careProfileId);
  res.json({ appointments: upcoming });
}));
router.post('/appointments', asyncHandler(async (req, res) => {
  const { careProfileId, hospital, datetime, note } = req.body;
  if (!await familyService.hasPermission(careProfileId, req.user.lineUserId, 'manage_appointments')) return res.status(403).json({ error: 'forbidden' });
  const result = await familyService.addAppointmentByFamily({ careProfileId, hospital, datetime, note, createdBy: req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason }); // ข้อ G2
  res.status(201).json(result.appointment);
}));

router.patch('/care-profile/:careProfileId/appointments/:appointmentId', requireFamilyAccess(), asyncHandler(async (req, res) => {
  if (!req.familyPermissions.includes('*') && !req.familyPermissions.includes('manage_appointments')) return res.status(403).json({ error:'forbidden' });
  const result = await familyService.updateFamilyAppointment({ careProfileId: req.params.careProfileId, appointmentId: req.params.appointmentId, patch: req.body, requesterLineId: req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json(result.appointment);
}));

router.post('/care-profile/:careProfileId/appointments/:appointmentId/cancel', requireFamilyAccess(), asyncHandler(async (req, res) => {
  if (!req.familyPermissions.includes('*') && !req.familyPermissions.includes('manage_appointments')) return res.status(403).json({ error:'forbidden' });
  const result = await familyService.cancelFamilyAppointment({ careProfileId: req.params.careProfileId, appointmentId: req.params.appointmentId, requesterLineId: req.user.lineUserId, reason: req.body.reason || '' });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json(result);
}));

// POST /api/medications
router.post('/medications', asyncHandler(async (req, res) => {
  const { careProfileId, name, dose } = req.body;
  if (!await familyService.hasPermission(careProfileId, req.user.lineUserId, 'manage_medications')) return res.status(403).json({ error: 'forbidden' });
  const result = await familyService.addMedicationByFamily({ careProfileId, name, dose, createdBy: req.user.lineUserId });
  res.status(201).json(result.medication);
}));

// เก็บรายการยาเป็น snapshot เพื่อย้อนดูการเปลี่ยนแปลงแต่ละครั้งได้
router.post('/care-profile/:careProfileId/medication-snapshots', requireFamilyAccess(), asyncHandler(async (req, res) => {
  if (!req.familyPermissions.includes('*') && !req.familyPermissions.includes('manage_medications')) return res.status(403).json({ error:'forbidden' });
  let items = req.body.items;
  let source = 'manual';
  let image = null;
  if (req.body.imageBase64) {
    image = require('../utils/imageUpload').decodeMedicalImage(req.body.imageBase64, req.body.imageMimeType);
    if (!image.ok) return res.status(image.status).json({ error: image.error, message: image.message });
  }
  if ((!Array.isArray(items) || items.length === 0) && req.body.imageBase64) {
    const aiProvider = require('../providers/aiProvider');
    const parsed = await aiProvider.interpretDocument(image.buffer, image.mimeType);
    items = parsed.medications || [];
    source = 'image_ai';
    if (!req.body.confirmAi) return res.status(202).json({ status: 'draft_requires_confirmation', items, message: 'กรุณาตรวจสอบและยืนยันรายการยาที่ AI อ่านได้ก่อนบันทึก' });
  }
  if (image && req.body.confirmAi) source = 'image_ai';
  const result = await familyService.recordMedicationSnapshot({
    careProfileId: req.params.careProfileId, items, recordedBy: req.user.lineUserId,
    source, sourceImageBase64: req.body.imageBase64 || null,
  });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.status(201).json(result.snapshot);
}));

router.get('/care-profile/:careProfileId/medication-snapshots', requireFamilyAccess(), asyncHandler(async (req, res) => {
  const snapshots = await familyService.getMedicationHistory(req.params.careProfileId);
  res.json({ snapshots });
}));

// POST /api/export/pdf — ส่งออกประวัติเป็นไฟล์ PDF จริง ตามช่วงวันที่ (ข้อ H4)
router.post('/export/pdf', asyncHandler(async (req, res) => {
  const { careProfileId, fromDate, toDate } = req.body;
  if (!await familyService.canAccessProfile(careProfileId, req.user.lineUserId)) return res.status(403).json({ error: 'forbidden' });

  const result = await familyService.exportHistoryToPdf(careProfileId, { fromDate, toDate });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });

  // ⚠️ HTTP Header ต้องเป็น ASCII เท่านั้น — ชื่อไฟล์ภาษาไทยใส่ตรงๆ ใน Header ไม่ได้ (ทำให้ setHeader Throw Error)
  // ใช้ RFC 5987 (filename*=UTF-8'') สำหรับชื่อจริงที่มี Unicode + fallback ASCII สำหรับ Browser เก่า
  sendPdf(res, result, 'attachment');
}));

// ออกลิงก์ชั่วคราวเพื่อให้ LIFF เปิด PDF ใน external browser ได้บน iOS/Android
router.post('/export/pdf-link', asyncHandler(async (req, res) => {
  const { careProfileId, fromDate, toDate } = req.body;
  if (!await familyService.canAccessProfile(careProfileId, req.user.lineUserId)) {
    return res.status(403).json({ error: 'forbidden', message: 'ไม่มีสิทธิ์เข้าถึง Care Profile นี้' });
  }
  const expiresAt = Date.now() + PDF_LINK_TTL_MS;
  const token = signPdfToken({ careProfileId, lineUserId: req.user.lineUserId, fromDate: fromDate || null, toDate: toDate || null, exp: expiresAt });
  const forwardedProtocol = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const origin = process.env.PUBLIC_BACKEND_URL || `${forwardedProtocol || req.protocol}://${req.get('host')}`;
  const base = `${origin}/api/export/pdf/download?token=${encodeURIComponent(token)}`;
  res.json({ previewUrl: base, downloadUrl: `${base}&download=1`, expiresAt: new Date(expiresAt).toISOString() });
}));

module.exports = router;
