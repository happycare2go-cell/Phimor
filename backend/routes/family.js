// routes/family.js — Endpoint ตาม Technical Design หมวด 5.4

const express = require('express');
const router = express.Router();
const { requireAuth, requireFamilyAccess } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const familyService = require('../services/familyService');
const privacyService = require('../services/privacyService');
const healthHistoryService = require('../services/careProfileHealthHistoryService');
const medicationCurrentSetService = require('../services/medicationCurrentSetService');
const medicationChangeHistoryService = require('../services/medicationChangeHistoryService');
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

function medicationError(res, error) {
  if (!(error instanceof medicationCurrentSetService.MedicationCurrentSetError)) throw error;
  const body = { status:'rejected', errorCode:error.code, message:error.message };
  if (error.code === 'DUPLICATE_MEDICATION_IDENTITY' && error.details?.conflicts) {
    body.conflicts = error.details.conflicts;
  }
  return res.status(error.status).json(body);
}

function familyMedicationRequester(req) {
  return { lineUserId:req.user.lineUserId };
}

router.use(requireAuth);

// GET /api/invite/:token — ตรวจสอบลิงก์เชิญ
router.get('/invite/:token', asyncHandler(async (req, res) => {
  const { Invites, Residents } = require('../db');
  const invite = await Invites.findOne((i) => i.invite_token === req.params.token);
  if (!invite) return res.status(404).json({ error: 'not_found', message: 'ลิงก์เชิญไม่ถูกต้อง' });
  // Preserve claim links written before Invite.status was introduced.
  if (invite.used_at || (invite.status && invite.status !== 'active')) return res.status(410).json({ error: 'gone', message: 'ลิงก์เชิญนี้ถูกใช้ ปฏิเสธ หรือยกเลิกแล้ว' });
  if (new Date(invite.expires_at) < new Date()) {
    await Invites.update((item) => item.invite_token === req.params.token && (!item.status || item.status === 'active'), { status:'expired', expired_at:new Date().toISOString() });
    return res.status(410).json({ error: 'gone', message: 'ลิงก์เชิญหมดอายุแล้ว' });
  }
  const resident = await Residents.findOne((r) => r.resident_id === invite.resident_id && r.status === 'active');
  const existingProfile = resident?.care_profile_id && await CareProfiles.findOne((p) => p.care_profile_id === resident.care_profile_id);
  if (existingProfile?.owner_line_id) return res.status(410).json({ error: 'gone', message: 'ผู้พักรายนี้มีเจ้าของ Care Profile แล้ว' });
  if (!resident) return res.status(410).json({ error: 'gone', message: 'ผู้พักรายนี้ถูกเชื่อมแล้วหรือไม่ได้อยู่ในศูนย์นี้' });
  res.json({ residentName: resident?.full_name, centerId: resident?.center_id, expiresAt: invite.expires_at });
}));

router.post('/invite/:token/decline', asyncHandler(async (req, res) => {
  if (req.body?.confirmed !== true) return res.status(400).json({ error:'confirmation_required', message:'กรุณายืนยันว่าต้องการปฏิเสธคำเชิญนี้' });
  const result = await familyService.declineInvite(req.params.token, req.user.lineUserId);
  if (!result.ok) return res.status(result.code === 'INVITE_NOT_FOUND' ? 404 : 410).json({ error:result.code || 'gone', message:result.reason });
  res.json({ ok:true, status:'declined' });
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

// Legacy endpoint intentionally cannot bind a caller-supplied group ID. A
// Family binding must be proven by sending its short-lived code in that group.
router.post('/care-profile/:careProfileId/bind-group', requireFamilyAccess(), asyncHandler(async (req, res) => {
  res.status(410).json({
    error:'group_binding_code_required',
    message:'กรุณาสร้างรหัสผูกกลุ่ม แล้วส่งรหัสด้วยบัญชีเดิมภายในกลุ่ม LINE ที่ต้องการเชื่อม',
  });
}));

// GET /api/init-dashboard — ข้อมูลหน้าหลักทั้งหมดในการเรียกครั้งเดียว
router.get('/init-dashboard', asyncHandler(async (req, res) => {
  const memberships = await CareProfileMembers.findWhere((m) => m.line_user_id === req.user.lineUserId && m.status === 'active');
  const memberIds = new Set(memberships.map((m) => m.care_profile_id));
  const profiles = (await CareProfiles.findWhere((p) => p.owner_line_id === req.user.lineUserId || memberIds.has(p.care_profile_id)))
    .sort((a, b) => String(a.created_at || a._createdAt || '').localeCompare(String(b.created_at || b._createdAt || ''))
      || String(a.care_profile_id).localeCompare(String(b.care_profile_id)));
  const { findActiveFamilyBinding } = require('../services/groupBindingRepository');
  const data = await Promise.all(profiles.map(async (p) => {
    const membership = memberships.find((item) => item.care_profile_id === p.care_profile_id);
    const isOwner = p.owner_line_id === req.user.lineUserId;
    return ({
    profile: p,
    familyRole: isOwner ? 'owner' : 'caregiver',
    familyPermissions:isOwner ? ['*'] : (membership?.permissions || ['view','edit_profile','manage_appointments','decide_transport']),
    familyGroup:await findActiveFamilyBinding(p.care_profile_id)
      ? { active:true, status:'active' } : { active:false, status:'unbound' },
    upcomingAppointments: await familyService.getUpcomingAppointments(p.care_profile_id),
    canUseAi: familyService.canUseAiFeatures(p),
  }); }));
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
  const { careProfileId, hospital, datetime, note, idempotencyKey } = req.body;
  if (!await familyService.hasPermission(careProfileId, req.user.lineUserId, 'manage_appointments')) return res.status(403).json({ error: 'forbidden' });
  const result = await familyService.addAppointmentByFamily({ careProfileId, hospital, datetime, note, createdBy: req.user.lineUserId, idempotencyKey });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason }); // ข้อ G2
  const { creation_idempotency_hash: _keyHash, creation_payload_hash: _payloadHash, ...appointment } = result.appointment;
  res.status(result.duplicate ? 200 : 201).json({ ...appointment, notificationState:result.notificationState, duplicate:result.duplicate === true });
}));

router.patch('/care-profile/:careProfileId/appointments/:appointmentId', requireFamilyAccess(), asyncHandler(async (req, res) => {
  if (!req.familyPermissions.includes('*') && !req.familyPermissions.includes('manage_appointments')) return res.status(403).json({ error:'forbidden' });
  const result = await familyService.updateFamilyAppointment({ careProfileId: req.params.careProfileId, appointmentId: req.params.appointmentId, patch: req.body, requesterLineId: req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json({ ...result.appointment, notificationState:result.notificationState, noChange:result.noChange === true });
}));

router.post('/care-profile/:careProfileId/appointments/:appointmentId/cancel', requireFamilyAccess(), asyncHandler(async (req, res) => {
  if (!req.familyPermissions.includes('*') && !req.familyPermissions.includes('manage_appointments')) return res.status(403).json({ error:'forbidden' });
  const result = await familyService.cancelFamilyAppointment({ careProfileId: req.params.careProfileId, appointmentId: req.params.appointmentId, requesterLineId: req.user.lineUserId, reason: req.body.reason || '' });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json(result);
}));

// POST /api/medications
router.post('/medications', asyncHandler(async (req, res) => {
  res.status(409).json({ status:'rejected', errorCode:'CURRENT_MEDICATION_SET_REQUIRED',
    message:'กรุณาเปิดรายการยาปัจจุบันและบันทึกเป็นชุด เพื่อป้องกันข้อมูลยารายการอื่นสูญหาย' });
}));

router.get('/care-profile/:careProfileId/medications/current', requireFamilyAccess(), asyncHandler(async (req, res) => {
  try {
    res.json(await medicationCurrentSetService.getCurrent({
      careProfileId:req.params.careProfileId, requester:familyMedicationRequester(req),
    }));
  } catch (error) { return medicationError(res, error); }
}));

router.get('/care-profile/:careProfileId/medications/history', requireFamilyAccess(), asyncHandler(async (req, res) => {
  res.json(await medicationChangeHistoryService.getHistory({
    careProfileId:req.params.careProfileId, requester:familyMedicationRequester(req), limit:req.query.limit,
  }));
}));

router.put('/care-profile/:careProfileId/medications/current', requireFamilyAccess(), asyncHandler(async (req, res) => {
  if (!req.familyPermissions.includes('*') && !req.familyPermissions.includes('manage_medications')) return res.status(403).json({ error:'forbidden' });
  try {
    const result = await medicationCurrentSetService.saveCompleteSet({
      careProfileId:req.params.careProfileId, items:req.body.items,
      baseSnapshotId:req.body.baseSnapshotId || null,
      requester:familyMedicationRequester(req), source:req.body.source === 'image_ai' ? 'image_ai' : 'manual',
      sourceImageBase64:req.body.source === 'image_ai' ? req.body.imageBase64 || null : null,
      confirmRemoveAll:req.body.confirmRemoveAll === true, mutationId:req.body.mutationId || null,
    });
    res.status(result.noChange ? 200 : 201).json(result);
  } catch (error) { return medicationError(res, error); }
}));

router.post('/care-profile/:careProfileId/medications/image-proposal', requireFamilyAccess(), asyncHandler(async (req, res) => {
  if (!req.familyPermissions.includes('*') && !req.familyPermissions.includes('manage_medications')) return res.status(403).json({ error:'forbidden' });
  const image = require('../utils/imageUpload').decodeMedicalImage(req.body.imageBase64, req.body.imageMimeType);
  if (!image.ok) return res.status(image.status).json({ error:image.error, message:image.message });
  const parsed = await require('../providers/aiProvider').interpretDocument(image.buffer, image.mimeType);
  try {
    const proposal = await medicationCurrentSetService.proposeImageMerge({
      careProfileId:req.params.careProfileId, extractedItems:parsed.medications || [],
      requester:familyMedicationRequester(req),
    });
    res.status(202).json({ status:'draft_requires_confirmation', ...proposal,
      message:proposal.extracted.length ? 'กรุณาตรวจสอบการเปลี่ยนแปลงก่อนบันทึก' : 'ไม่พบรายการยาที่นำมาเสนอ กรุณาตรวจภาพหรือกรอกข้อมูลเอง' });
  } catch (error) { return medicationError(res, error); }
}));

// เก็บรายการยาเป็น snapshot เพื่อย้อนดูการเปลี่ยนแปลงแต่ละครั้งได้
router.post('/care-profile/:careProfileId/medication-snapshots', requireFamilyAccess(), asyncHandler(async (req, res) => {
  if (!req.familyPermissions.includes('*') && !req.familyPermissions.includes('manage_medications')) return res.status(403).json({ error:'forbidden' });
  if (req.body.imageBase64 && !req.body.confirmAi) {
    const image = require('../utils/imageUpload').decodeMedicalImage(req.body.imageBase64, req.body.imageMimeType);
    if (!image.ok) return res.status(image.status).json({ error:image.error, message:image.message });
    const parsed = await require('../providers/aiProvider').interpretDocument(image.buffer, image.mimeType);
    try {
      const proposal = await medicationCurrentSetService.proposeImageMerge({ careProfileId:req.params.careProfileId,
        extractedItems:parsed.medications || [], requester:familyMedicationRequester(req) });
      return res.status(202).json({ status:'draft_requires_confirmation', ...proposal });
    } catch (error) { return medicationError(res, error); }
  }
  try {
    const result = await medicationCurrentSetService.saveCompleteSet({
      careProfileId:req.params.careProfileId, items:req.body.items,
      baseSnapshotId:req.body.baseSnapshotId || null, requester:familyMedicationRequester(req),
      source:req.body.confirmAi ? 'image_ai' : 'manual',
      sourceImageBase64:req.body.confirmAi ? req.body.imageBase64 || null : null,
      confirmRemoveAll:req.body.confirmRemoveAll === true, mutationId:req.body.mutationId || null,
    });
    res.status(result.noChange ? 200 : 201).json(result);
  } catch (error) { return medicationError(res, error); }
}));

router.get('/care-profile/:careProfileId/medication-snapshots', requireFamilyAccess(), asyncHandler(async (req, res) => {
  const history = await medicationChangeHistoryService.getHistory({
    careProfileId:req.params.careProfileId, requester:familyMedicationRequester(req), limit:req.query.limit,
  });
  res.json({ snapshots:history.items, items:history.items, nextCursor:history.nextCursor });
}));

// POST /api/export/pdf — ส่งออกประวัติเป็นไฟล์ PDF จริง ตามช่วงวันที่ (ข้อ H4)
router.post('/export/pdf', asyncHandler(async (req, res) => {
  const { careProfileId, fromDate, toDate } = req.body;
  if (!await familyService.canAccessProfile(careProfileId, req.user.lineUserId)) return res.status(403).json({ error: 'forbidden' });

  const result = await familyService.exportHistoryToPdf(careProfileId, { fromDate, toDate });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', errorCode:result.errorCode || 'EXPORT_FAILED', message: result.reason });

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
