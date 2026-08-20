// routes/family.js — Endpoint ตาม Technical Design หมวด 5.4

const express = require('express');
const router = express.Router();
const { requireAuth, requireFamilyAccess } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const familyService = require('../services/familyService');
const { CareProfiles, CareProfileMembers } = require('../db');

router.use(requireAuth);

// GET /api/invite/:token — ตรวจสอบลิงก์เชิญ
router.get('/invite/:token', asyncHandler(async (req, res) => {
  const { Invites, Residents } = require('../db');
  const invite = await Invites.findOne((i) => i.invite_token === req.params.token);
  if (!invite) return res.status(404).json({ error: 'not_found', message: 'ลิงก์เชิญไม่ถูกต้อง' });
  if (invite.used_at) return res.status(410).json({ error: 'gone', message: 'ลิงก์เชิญนี้ถูกใช้ไปแล้ว' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'gone', message: 'ลิงก์เชิญหมดอายุแล้ว' });
  const resident = await Residents.findOne((r) => r.resident_id === invite.resident_id);
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
  const hasConsent = await familyService.hasValidConsent(req.user.lineUserId);
  res.json({ hasConsent });
}));

// POST /api/consent — บันทึกการยินยอม PDPA (ข้อ H6)
router.post('/consent', asyncHandler(async (req, res) => {
  const { accepted } = req.body;
  const consent = await familyService.recordConsent(req.user.lineUserId, !!accepted);
  res.status(201).json(consent);
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
  const result = await familyService.acceptCaregiverInvite(req.params.token, req.user.lineUserId);
  if (!result.ok) return res.status(400).json({ error:'bad_request', message:result.reason });
  res.status(201).json(result.member);
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
  const { CareProfiles: CP } = require('../db');
  const allowed = ['gender', 'blood_type', 'height_cm', 'weight_kg', 'chronic_conditions',
    'drug_allergies', 'food_allergies', 'mobility_limitations',
    'emergency_contact_name', 'emergency_contact_phone', 'family_phone'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  const updated = await CP.update((p) => p.care_profile_id === req.params.careProfileId, patch);
  res.json(updated);
}));

// GET/POST /api/appointments — จัดการนัดหมาย
router.get('/appointments', requireFamilyAccess(), asyncHandler(async (req, res) => {
  const upcoming = await familyService.getUpcomingAppointments(req.params.careProfileId || req.query.careProfileId);
  res.json({ appointments: upcoming });
}));
router.post('/appointments', asyncHandler(async (req, res) => {
  const { careProfileId, hospital, datetime, note } = req.body;
  if (!await familyService.canAccessProfile(careProfileId, req.user.lineUserId)) return res.status(403).json({ error: 'forbidden' });
  const result = await familyService.addAppointmentByFamily({ careProfileId, hospital, datetime, note, createdBy: req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason }); // ข้อ G2
  res.status(201).json(result.appointment);
}));

// POST /api/medications
router.post('/medications', asyncHandler(async (req, res) => {
  const { careProfileId, name, dose } = req.body;
  if (!await familyService.canAccessProfile(careProfileId, req.user.lineUserId)) return res.status(403).json({ error: 'forbidden' });
  const result = await familyService.addMedicationByFamily({ careProfileId, name, dose, createdBy: req.user.lineUserId });
  res.status(201).json(result.medication);
}));

// เก็บรายการยาเป็น snapshot เพื่อย้อนดูการเปลี่ยนแปลงแต่ละครั้งได้
router.post('/care-profile/:careProfileId/medication-snapshots', requireFamilyAccess(), asyncHandler(async (req, res) => {
  let items = req.body.items;
  let source = 'manual';
  if ((!Array.isArray(items) || items.length === 0) && req.body.imageBase64) {
    const aiProvider = require('../providers/aiProvider');
    const parsed = await aiProvider.interpretDocument(Buffer.from(req.body.imageBase64, 'base64'));
    items = parsed.medications || [];
    source = 'image_ai';
  }
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
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${result.asciiFilename}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
  res.send(result.pdfBuffer);
}));

module.exports = router;
