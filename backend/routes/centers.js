// routes/centers.js — Endpoint ตาม Technical Design หมวด 5.2 และ 6.3

const express = require('express');
const router = express.Router();
const { requireAuth, requireCenterStaff } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const centerService = require('../services/centerService');
const familyService = require('../services/familyService');
const healthHistoryService = require('../services/careProfileHealthHistoryService');
const transportService = require('../services/transportService');
const { CenterStaff, Centers } = require('../db');
const { projectCenter } = require('../services/centerProjection');
const { platformService: defaultPlatformService } = require('../services/platformService');
const { displayIdentity } = require('../utils/safeIdentity');
const accessService = require('../services/accessService');
const groupBindingService = require('../services/groupBindingService');

function platformServiceFor(req) {
  return req.app.locals.platformService || defaultPlatformService;
}

function staffProjection(row) {
  return {
    staff_id:row.staff_id,
    display_identity:displayIdentity({ displayName:row.display_name, lineUserId:row.line_user_id }),
    role:row.role, status:row.status || 'active', auto_registered:Boolean(row.auto_registered),
    assigned_at:row.assigned_at || null,
  };
}

async function staffRecordInCenter(centerId, staffId) {
  return CenterStaff.findOne((row) => row.center_id === centerId && row.staff_id === staffId);
}

router.use(requireAuth);

// GET /api/center/me — ข้อมูลศูนย์ของผู้ใช้ปัจจุบัน
router.get('/center/me', asyncHandler(async (req, res) => {
  const staffRows = await CenterStaff.findWhere((s) => s.line_user_id === req.user.lineUserId && (!s.status || s.status === 'active'));
  if (staffRows.length === 0) return res.status(404).json({ error: 'not_found', message: 'ไม่พบศูนย์ที่ท่านมีสิทธิ์' });
  const centers = await Promise.all(staffRows.map(async (s) => {
    const c = await Centers.findOne((x) => x.center_id === s.center_id);
    return projectCenter(c, { myRole: s.role, subscription: require('../services/subscriptionService').entitlement(c) });
  }));
  res.json({ centers });
}));

// Center LIFF capability projection. The backend remains authoritative and
// exposes only the two public feature switches, never platform credentials.
router.get('/center/:centerId/capabilities', requireCenterStaff(['owner', 'manager', 'staff']), asyncHandler(async (req, res) => {
  const rows = await platformServiceFor(req).listCenterCapabilities(req.centerId);
  const byKey = new Map(rows.map((row) => [row.capabilityKey, Boolean(row.enabled)]));
  res.json({
    capabilities: {
      vital_signs_v1: byKey.get('vital_signs_v1') === true,
      daily_care_v1: byKey.get('daily_care_v1') === true,
    },
  });
}));

router.patch('/center/settings', requireCenterStaff(['owner']), asyncHandler(async (req, res) => {
  const result = await centerService.updateCenterSettings({ centerId:req.centerId, requesterLineId:req.user.lineUserId,
    address:req.body.address, contactPhone:req.body.contactPhone });
  if (!result.ok) return res.status(400).json({ error:'bad_request', message:result.reason });
  res.json(projectCenter(result.center));
}));

// GET /api/center/staff — รายชื่อผู้มีสิทธิ์จัดการ (เจ้าของเท่านั้น)
router.get('/center/staff', requireCenterStaff(['owner']), asyncHandler(async (req, res) => {
  const staff = await centerService.listStaff(req.centerId);
  res.json({ staff:staff.map(staffProjection) });
}));

// POST /api/center/staff — แต่งตั้งผู้จัดการ (เจ้าของเท่านั้น)
router.post('/center/staff', requireCenterStaff(['owner']), asyncHandler(async (req, res) => {
  let { targetLineId } = req.body;
  if (!targetLineId && req.body?.targetStaffId) {
    const target = await staffRecordInCenter(req.centerId, req.body.targetStaffId);
    targetLineId = target?.line_user_id;
  }
  if (!targetLineId) return res.status(400).json({ error: 'bad_request', message: 'ไม่ระบุผู้ใช้ที่จะแต่งตั้ง' });
  const result = await centerService.appointManager({ centerId: req.centerId, targetLineId, requesterLineId: req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.status(201).json(staffProjection(result.staff));
}));

router.delete('/center/staff-records/:staffId', requireCenterStaff(['owner']), asyncHandler(async (req, res) => {
  const target = await staffRecordInCenter(req.centerId, req.params.staffId);
  if (!target) return res.status(404).json({ error:'not_found', message:'ไม่พบสมาชิกทีม' });
  const result = await centerService.revokeStaff({ centerId:req.centerId, targetLineId:target.line_user_id, requesterLineId:req.user.lineUserId, reason:req.body?.reason || '' });
  if (!result.ok) return res.status(400).json({ error:'bad_request', message:result.reason });
  res.json({ ok:true });
}));

router.post('/center/staff-records/:staffId/approve', requireCenterStaff(['owner']), asyncHandler(async (req, res) => {
  const target = await staffRecordInCenter(req.centerId, req.params.staffId);
  if (!target) return res.status(404).json({ error:'not_found', message:'ไม่พบสมาชิกทีม' });
  const result = await centerService.approveStaff({ centerId:req.centerId, targetLineId:target.line_user_id, requesterLineId:req.user.lineUserId, role:req.body.role || 'staff' });
  if (!result.ok) return res.status(400).json({ error:'bad_request', message:result.reason });
  res.json(staffProjection(result.staff));
}));

// DELETE /api/center/staff/:id — ถอดถอนผู้จัดการ (เจ้าของเท่านั้น)
router.delete('/center/staff/:targetLineId', requireCenterStaff(['owner']), asyncHandler(async (req, res) => {
  const result = await centerService.revokeStaff({ centerId: req.centerId, targetLineId: req.params.targetLineId, requesterLineId: req.user.lineUserId, reason: req.body?.reason || '' });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json({ ok: true });
}));

router.post('/center/staff/:targetLineId/approve', requireCenterStaff(['owner']), asyncHandler(async (req, res) => {
  const result = await centerService.approveStaff({ centerId: req.centerId, targetLineId: req.params.targetLineId, requesterLineId: req.user.lineUserId, role: req.body.role || 'staff' });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json(staffProjection(result.staff));
}));

// GET /api/residents — รายชื่อผู้พักของศูนย์ (เจ้าของ/ผู้จัดการ)
router.get('/residents', requireCenterStaff(['owner', 'manager', 'staff']), asyncHandler(async (req, res) => {
  const rows = await centerService.listResidents(req.centerId, { search: req.query.search });
  res.json({ residents: rows });
}));

router.post('/center/care-profile-link-requests', requireCenterStaff(['owner', 'manager']), asyncHandler(async (req, res) => {
  const result = await accessService.createAnonymousLinkRequest({ centerId:req.centerId, requestedBy:req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error:result.code || 'link_unavailable', message:result.reason });
  res.status(201).json({ linkUrl:result.linkUrl, expiresAt:result.expiresAt });
}));

router.get('/center/care-profile-link-requests', requireCenterStaff(['owner', 'manager']), asyncHandler(async (req, res) => {
  const requests = await accessService.listActiveAnonymousLinksForCenter(req.centerId);
  res.json({ requests });
}));

// GET /api/center/appointments — ตารางนัดของทุกผู้พักในศูนย์ (ข้อ K1, K2)
router.get('/center/appointments', requireCenterStaff(['owner', 'manager', 'staff']), asyncHandler(async (req, res) => {
  const rows = await centerService.getCenterAppointments(req.centerId);
  res.json({ appointments: rows });
}));

// POST /api/residents — เพิ่มผู้พัก คืนลิงก์เชิญ (เจ้าของ/ผู้จัดการ)
router.post('/residents', requireCenterStaff(), asyncHandler(async (req, res) => {
  const { fullName, aliases, room, familyPhone } = req.body;
  if (!fullName || !fullName.trim()) {
    return res.status(400).json({ error: 'bad_request', message: 'กรุณาระบุชื่อ-นามสกุลผู้พัก' });
  }
  const result = await centerService.addResident({
    centerId: req.centerId, fullName, aliases, room, familyPhone,
  });
  if (!result.ok) return res.status(409).json({ error: 'duplicate', message: result.reason, resident: result.duplicate });
  const { resident, inviteUrl, inviteExpiresAt, accessRequestSent, accessRequestId } = result;
  res.status(201).json({
    residentId: resident.resident_id, status: resident.status, careProfileId: resident.care_profile_id,
    inviteUrl, inviteExpiresAt, accessRequestSent, accessRequestId,
  });
}));

router.post('/residents/:residentId/care-profile', requireCenterStaff(['owner', 'manager']), asyncHandler(async (req, res) => {
  const result = await centerService.createCenterManagedCareProfile({ centerId:req.centerId, residentId:req.params.residentId, profileData:req.body || {}, requesterLineId:req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error:'bad_request', message:result.reason });
  res.status(201).json(result.profile);
}));

router.post('/residents/:residentId/invite', requireCenterStaff(['owner', 'manager']), asyncHandler(async (req, res) => {
  const result = await centerService.getOrCreateResidentInvite({
    centerId:req.centerId, residentId:req.params.residentId, requesterLineId:req.user.lineUserId,
  });
  if (!result.ok) return res.status(400).json({ error:'bad_request', message:result.reason });
  res.json(result);
}));

router.post('/residents/:residentId/family-group-binding-token', requireCenterStaff(['owner', 'manager']), asyncHandler(async (req, res) => {
  const result = await groupBindingService.createCenterFamilyBindingToken({
    centerId:req.centerId, residentId:req.params.residentId, requesterLineId:req.user.lineUserId,
  });
  if (!result.ok) {
    const status = ['RESIDENT_NOT_ELIGIBLE', 'CARE_PROFILE_NOT_ELIGIBLE'].includes(result.code) ? 404
      : result.code === 'CENTER_MANAGER_REQUIRED' ? 403
        : result.code === 'CENTER_NOT_ELIGIBLE' ? 402 : 409;
    return res.status(status).json({ error:result.code || 'FAMILY_GROUP_CODE_UNAVAILABLE', message:result.reason,
      expiresAt:result.expiresAt || null });
  }
  res.status(201).json({ code:result.code, expiresAt:result.expiresAt });
}));

// รายละเอียดสุขภาพเปิดให้เฉพาะ owner/manager เท่านั้น พนักงานทั่วไปไม่มี endpoint สำหรับอ่านข้อมูลนี้
router.get('/residents/:residentId/care-profile', requireCenterStaff(['owner', 'manager']), asyncHandler(async (req, res) => {
  const { Residents, CareProfiles, audit } = require('../db');
  const resident = await Residents.findOne(
    (r) => r.resident_id === req.params.residentId && r.center_id === req.centerId && r.status === 'active'
  );
  if (!resident) return res.status(404).json({ error: 'not_found', message: 'ไม่พบผู้พักในสาขานี้' });
  if (!resident.care_profile_id) return res.status(404).json({ error: 'not_linked', message: 'ผู้พักยังไม่ได้ผูก Care Profile' });
  const profile = await CareProfiles.findOne(
    (p) => p.care_profile_id === resident.care_profile_id && p.center_id === req.centerId && p.status === 'linked'
  );
  if (!profile) return res.status(403).json({ error: 'forbidden', message: 'ศูนย์ไม่มีสิทธิ์เข้าถึง Care Profile นี้' });
  const medicationHistory = await familyService.getMedicationHistory(profile.care_profile_id);
  await audit('care_profile.viewed_by_center', req.user.lineUserId, { centerId: req.centerId, residentId: resident.resident_id, careProfileId: profile.care_profile_id });
  res.json({ profile, medicationHistory });
}));

router.get('/residents/:residentId/care-profile/health-history', requireCenterStaff(['owner', 'manager']), asyncHandler(async (req, res) => {
  const { Residents } = require('../db');
  const resident = await Residents.findOne(
    (item) => item.resident_id === req.params.residentId && item.center_id === req.centerId && item.status === 'active'
  );
  if (!resident?.care_profile_id) return res.status(404).json({ error:'not_found', message:'ไม่พบผู้พักที่เชื่อม Care Profile ในสาขานี้' });
  try {
    const result = await healthHistoryService.getCareProfileHealthHistory({
      careProfileId: resident.care_profile_id,
      lineUserId: req.user.lineUserId,
      centerId: req.centerId,
      audience: 'center',
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

// ข้อมูลจำเป็นต่อการดูแลประจำวัน: staff เห็นเฉพาะ summary ไม่เห็นประวัติฉบับเต็ม
router.get('/residents/:residentId/clinical-summary', requireCenterStaff(['owner', 'manager', 'staff']), asyncHandler(async (req, res) => {
  const { Residents, CareProfiles, MedicationSnapshots, Appointments, Vitals, audit } = require('../db');
  const resident = await Residents.findOne((r) => r.resident_id === req.params.residentId && r.center_id === req.centerId && r.status === 'active');
  if (!resident?.care_profile_id) return res.status(404).json({ error: 'not_linked', message: 'ผู้พักยังไม่ได้ผูก Care Profile' });
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === resident.care_profile_id && p.center_id === req.centerId && p.status === 'linked');
  if (!profile) return res.status(403).json({ error: 'forbidden', message: 'ศูนย์ไม่มีสิทธิ์เข้าถึง Care Profile นี้' });
  const snapshots = await MedicationSnapshots.findWhere((s) => s.care_profile_id === profile.care_profile_id);
  const latestMedication = snapshots.sort((a,b) => new Date(b.recorded_at) - new Date(a.recorded_at))[0] || null;
  const appointments = await Appointments.findWhere((a) => a.care_profile_id === profile.care_profile_id && a.status !== 'cancelled' && new Date(a.datetime) > new Date());
  const vitals = await Vitals.findWhere((v) => v.care_profile_id === profile.care_profile_id);
  const latestVitals = vitals.sort((a,b) => new Date(b.recorded_at) - new Date(a.recorded_at))[0] || null;
  const summary = {
    residentId: resident.resident_id, patientName: profile.patient_name, room: resident.room,
    gender: profile.gender || null, bloodType: profile.blood_type || null,
    chronicConditions: profile.chronic_conditions || [], drugAllergies: profile.drug_allergies || '',
    foodAllergies: profile.food_allergies || '', mobilityLimitations: profile.mobility_limitations || '',
    emergencyContactName: profile.emergency_contact_name || '', emergencyContactPhone: profile.emergency_contact_phone || resident.family_phone || '',
    currentMedications: latestMedication?.items || [], medicationUpdatedAt: latestMedication?.recorded_at || null,
    upcomingAppointments: appointments.sort((a,b) => new Date(a.datetime)-new Date(b.datetime)).slice(0,3), latestVitals,
    profileUpdatedAt: profile._updatedAt || profile.updated_at || null,
  };
  await audit('clinical_summary.viewed', req.user.lineUserId, { centerId:req.centerId, residentId:resident.resident_id, role:req.staffRole });
  res.json({ summary });
}));

router.patch('/center/appointments/:appointmentId', requireCenterStaff(['owner', 'manager']), asyncHandler(async (req, res) => {
  const result = await centerService.updateAppointment({ centerId:req.centerId, appointmentId:req.params.appointmentId, patch:req.body, requesterLineId:req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error:'bad_request', message:result.reason });
  res.json({ ...result.appointment, notificationState:result.notificationState, noChange:result.noChange === true });
}));

router.post('/center/appointments/:appointmentId/cancel', requireCenterStaff(['owner', 'manager']), asyncHandler(async (req, res) => {
  const result = await centerService.cancelAppointment({ centerId:req.centerId, appointmentId:req.params.appointmentId, requesterLineId:req.user.lineUserId, reason:req.body.reason });
  if (!result.ok) return res.status(400).json({ error:'bad_request', message:result.reason });
  res.json(result);
}));

router.post('/residents/:residentId/medication-snapshots', requireCenterStaff(['owner', 'manager']), asyncHandler(async (req, res) => {
  const { Residents, CareProfiles } = require('../db');
  const resident = await Residents.findOne(
    (r) => r.resident_id === req.params.residentId && r.center_id === req.centerId && r.status === 'active'
  );
  if (!resident?.care_profile_id) return res.status(404).json({ error: 'not_linked', message: 'ผู้พักยังไม่ได้ผูก Care Profile' });
  const profile = await CareProfiles.findOne(
    (p) => p.care_profile_id === resident.care_profile_id && p.center_id === req.centerId && p.status === 'linked'
  );
  if (!profile) return res.status(403).json({ error: 'forbidden' });
  let items = req.body.items;
  let source = 'center_manual';
  let image = null;
  if (req.body.imageBase64) {
    image = require('../utils/imageUpload').decodeMedicalImage(req.body.imageBase64, req.body.imageMimeType);
    if (!image.ok) return res.status(image.status).json({ error: image.error, message: image.message });
  }
  if ((!Array.isArray(items) || items.length === 0) && req.body.imageBase64) {
    const aiProvider = require('../providers/aiProvider');
    const parsed = await aiProvider.interpretDocument(image.buffer, image.mimeType);
    items = parsed.medications || [];
    source = 'center_image_ai';
    if (!req.body.confirmAi) return res.status(202).json({ status: 'draft_requires_confirmation', items, message: 'กรุณาตรวจสอบและยืนยันรายการยาที่ AI อ่านได้ก่อนบันทึก' });
  }
  if (image && req.body.confirmAi) source = 'center_image_ai';
  const result = await familyService.recordMedicationSnapshot({
    careProfileId: profile.care_profile_id, items, recordedBy: req.user.lineUserId,
    source, sourceImageBase64: req.body.imageBase64 || null,
  });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.status(201).json(result.snapshot);
}));

// PATCH /api/residents/:id — แก้ไขข้อมูลผู้พัก (เจ้าของ/ผู้จัดการ)
router.patch('/residents/:residentId', requireCenterStaff(), asyncHandler(async (req, res) => {
  const updated = await centerService.updateResident(req.centerId, req.params.residentId, req.body);
  if (!updated) return res.status(404).json({ error: 'not_found' });
  res.json(updated);
}));

// POST /api/residents/:id/discharge — จำหน่ายออก (เจ้าของ/ผู้จัดการ)
router.post('/residents/:residentId/discharge', requireCenterStaff(), asyncHandler(async (req, res) => {
  const result = await centerService.dischargeResident(req.centerId, req.params.residentId, req.user.lineUserId);
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json({ ok: true, familyNotice: result.familyNotice });
}));

// POST /api/residents/import — นำเข้าแบบชุด (เจ้าของเท่านั้น — ข้อมูลจำนวนมาก)
router.post('/residents/import', requireCenterStaff(['owner']), asyncHandler(async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'bad_request', message: 'รูปแบบข้อมูลไม่ถูกต้อง' });
  const result = await centerService.importResidentsBulk(req.centerId, rows);
  res.status(201).json(result);
}));

// GET/PUT /api/center/ratecard — ราคาบริการของศูนย์ (เจ้าของ/ผู้จัดการ)
router.get('/center/ratecard', requireCenterStaff(), asyncHandler(async (req, res) => {
  const rc = await transportService.getRateCard(req.centerId);
  res.json(rc);
}));

const saveRateCard = asyncHandler(async (req, res) => {
  const { escortEnabled, escortPrice, vehicleEnabled, vehiclePrice } = req.body;
  const escortAmount = Number(escortPrice || 0);
  const vehicleAmount = Number(vehiclePrice || 0);
  if (!Number.isFinite(escortAmount) || escortAmount < 0 || !Number.isFinite(vehicleAmount) || vehicleAmount < 0) {
    return res.status(400).json({ error:'bad_request', message:'ราคาต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป' });
  }
  const updated = await transportService.updateRateCard(req.centerId, {
    escort_enabled: !!escortEnabled, escort_price: escortAmount,
    vehicle_enabled: !!vehicleEnabled, vehicle_price: vehicleAmount,
  }, req.user.lineUserId);
  if (!updated) return res.status(500).json({ error:'ratecard_not_saved', message:'ระบบไม่สามารถบันทึกราคาบริการได้ กรุณาลองใหม่' });
  res.json(updated);
});

// POST รองรับ LINE in-app browser บางรุ่นที่มีปัญหากับ PUT ส่วน PUT คงไว้เพื่อ backward compatibility
router.post('/center/ratecard', requireCenterStaff(), saveRateCard);
router.put('/center/ratecard', requireCenterStaff(), saveRateCard);

module.exports = router;
