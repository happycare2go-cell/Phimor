// routes/centers.js — Endpoint ตาม Technical Design หมวด 5.2 และ 6.3

const express = require('express');
const router = express.Router();
const { requireAuth, requireCenterStaff } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const centerService = require('../services/centerService');
const transportService = require('../services/transportService');
const { CenterStaff, Centers } = require('../db');

router.use(requireAuth);

// GET /api/center/me — ข้อมูลศูนย์ของผู้ใช้ปัจจุบัน
router.get('/center/me', asyncHandler(async (req, res) => {
  const staffRows = await CenterStaff.findWhere((s) => s.line_user_id === req.user.lineUserId);
  if (staffRows.length === 0) return res.status(404).json({ error: 'not_found', message: 'ไม่พบศูนย์ที่ท่านมีสิทธิ์' });
  const centers = await Promise.all(staffRows.map(async (s) => {
    const c = await Centers.findOne((x) => x.center_id === s.center_id);
    return { ...c, myRole: s.role };
  }));
  res.json({ centers });
}));

// GET /api/center/staff — รายชื่อผู้มีสิทธิ์จัดการ (เจ้าของเท่านั้น)
router.get('/center/staff', requireCenterStaff(['owner']), asyncHandler(async (req, res) => {
  const staff = await centerService.listStaff(req.centerId);
  res.json({ staff });
}));

// POST /api/center/staff — แต่งตั้งผู้จัดการ (เจ้าของเท่านั้น)
router.post('/center/staff', requireCenterStaff(['owner']), asyncHandler(async (req, res) => {
  const { targetLineId } = req.body;
  if (!targetLineId) return res.status(400).json({ error: 'bad_request', message: 'ไม่ระบุผู้ใช้ที่จะแต่งตั้ง' });
  const result = await centerService.appointManager({ centerId: req.centerId, targetLineId, requesterLineId: req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.status(201).json(result.staff);
}));

// DELETE /api/center/staff/:id — ถอดถอนผู้จัดการ (เจ้าของเท่านั้น)
router.delete('/center/staff/:targetLineId', requireCenterStaff(['owner']), asyncHandler(async (req, res) => {
  const result = await centerService.removeManager({ centerId: req.centerId, targetLineId: req.params.targetLineId, requesterLineId: req.user.lineUserId });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json({ ok: true });
}));

// GET /api/residents — รายชื่อผู้พักของศูนย์ (เจ้าของ/ผู้จัดการ)
router.get('/residents', requireCenterStaff(), asyncHandler(async (req, res) => {
  const rows = await centerService.listResidents(req.centerId, { search: req.query.search });
  res.json({ residents: rows });
}));

// GET /api/center/appointments — ตารางนัดของทุกผู้พักในศูนย์ (ข้อ K1, K2)
router.get('/center/appointments', requireCenterStaff(), asyncHandler(async (req, res) => {
  const rows = await centerService.getCenterAppointments(req.centerId);
  res.json({ appointments: rows });
}));

// POST /api/residents — เพิ่มผู้พัก คืนลิงก์เชิญ (เจ้าของ/ผู้จัดการ)
router.post('/residents', requireCenterStaff(), asyncHandler(async (req, res) => {
  const { fullName, aliases, room, familyPhone } = req.body;
  if (!fullName || !fullName.trim()) {
    return res.status(400).json({ error: 'bad_request', message: 'กรุณาระบุชื่อ-นามสกุลผู้พัก' });
  }
  const { resident, inviteUrl, inviteExpiresAt } = await centerService.addResident({
    centerId: req.centerId, fullName, aliases, room, familyPhone,
  });
  res.status(201).json({
    residentId: resident.resident_id, status: resident.status, careProfileId: resident.care_profile_id,
    inviteUrl, inviteExpiresAt,
  });
}));

// PATCH /api/residents/:id — แก้ไขข้อมูลผู้พัก (เจ้าของ/ผู้จัดการ)
router.patch('/residents/:residentId', requireCenterStaff(), asyncHandler(async (req, res) => {
  const updated = await centerService.updateResident(req.params.residentId, req.body);
  if (!updated) return res.status(404).json({ error: 'not_found' });
  res.json(updated);
}));

// POST /api/residents/:id/discharge — จำหน่ายออก (เจ้าของ/ผู้จัดการ)
router.post('/residents/:residentId/discharge', requireCenterStaff(), asyncHandler(async (req, res) => {
  const result = await centerService.dischargeResident(req.params.residentId, req.user.lineUserId);
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
router.put('/center/ratecard', requireCenterStaff(), asyncHandler(async (req, res) => {
  const { escortEnabled, escortPrice, vehicleEnabled, vehiclePrice } = req.body;
  const updated = await transportService.updateRateCard(req.centerId, {
    escort_enabled: !!escortEnabled, escort_price: Number(escortPrice) || 0,
    vehicle_enabled: !!vehicleEnabled, vehicle_price: Number(vehiclePrice) || 0,
  }, req.user.lineUserId);
  res.json(updated);
}));

module.exports = router;
