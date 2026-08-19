// routes/transport.js — Endpoint ตาม Technical Design หมวด 6.4

const express = require('express');
const router = express.Router();
const { requireAuth, requireCenterStaff } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const transportService = require('../services/transportService');
const { TransportPlans, CareProfiles } = require('../db');

router.use(requireAuth);

// GET /api/transport/:id — ดูสถานะและประวัติการตัดสินใจ
router.get('/transport/:planId', asyncHandler(async (req, res) => {
  const plan = await TransportPlans.findOne((p) => p.plan_id === req.params.planId);
  if (!plan) return res.status(404).json({ error: 'not_found' });
  res.json(plan);
}));

// POST /api/transport/:id/family-choice — ครอบครัวเลือกชั้นที่ 1 (ข้อ L1, L2, L3)
router.post('/transport/:planId/family-choice', asyncHandler(async (req, res) => {
  const plan = await TransportPlans.findOne((p) => p.plan_id === req.params.planId);
  if (!plan) return res.status(404).json({ error: 'not_found' });
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === plan.care_profile_id);
  if (!profile || profile.owner_line_id !== req.user.lineUserId) {
    return res.status(403).json({ error: 'forbidden', message: 'เฉพาะครอบครัวเจ้าของ Care Profile เท่านั้น' });
  }
  const { choice } = req.body;
  const result = choice === 'self'
    ? await transportService.familyChooseSelf(req.params.planId, req.user.lineUserId)
    : choice === 'request_center'
      ? await transportService.familyRequestCenter(req.params.planId, req.user.lineUserId)
      : { ok: false, reason: 'ตัวเลือกไม่ถูกต้อง' };
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json(result);
}));

// GET /api/transport/pending — รายการที่รอศูนย์ตัดสินใจ (เจ้าของ/ผู้จัดการ)
router.get('/transport/pending', requireCenterStaff(), asyncHandler(async (req, res) => {
  const pending = await TransportPlans.findWhere((p) => p.center_id === req.centerId && p.status === 'awaiting_center');
  res.json({ pending });
}));

// POST /api/transport/:id/center-choice — ศูนย์เลือกชั้นที่ 2 (ข้อ L4-L9) — สองทางเท่านั้น ไม่มีปฏิเสธ
router.post('/transport/:planId/center-choice', requireCenterStaff(), asyncHandler(async (req, res) => {
  const plan = await TransportPlans.findOne((p) => p.plan_id === req.params.planId);
  if (!plan || plan.center_id !== req.centerId) return res.status(404).json({ error: 'not_found' });

  const { choice, needs, note } = req.body;
  const isChange = ['center_handled', 'care2go_requested', 'care2go_confirmed'].includes(plan.status);
  const result = isChange
    ? await transportService.centerChangeChoice(req.params.planId, choice, req.user.lineUserId, { needs, note })
    : await transportService.centerChoose(req.params.planId, choice, req.user.lineUserId, { needs, note });

  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json(result);
}));

// POST /api/transport/:id/care2go-unavailable — Care2Go แจ้งกลับว่าจัดหาไม่ได้ (ข้อ L11 — เรียกจากระบบภายใน)
router.post('/transport/:planId/care2go-unavailable', requireCenterStaff(), asyncHandler(async (req, res) => {
  const plan = await TransportPlans.findOne((p) => p.plan_id === req.params.planId);
  if (!plan) return res.status(404).json({ error: 'not_found' });
  const { Appointments } = require('../db');
  const appt = await Appointments.findOne((a) => a.appointment_id === plan.appointment_id);
  const result = await transportService.markCare2goUnavailable(req.params.planId, appt?.datetime);
  res.json(result);
}));

// POST /api/bills — ออกใบแจ้งค่าใช้จ่าย (เจ้าของ/ผู้จัดการ)
router.post('/bills', requireCenterStaff(), asyncHandler(async (req, res) => {
  const { careProfileId, appointmentId, items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'bad_request', message: 'กรุณาระบุรายการค่าใช้จ่าย' });
  }
  const bill = await transportService.createBill({
    centerId: req.centerId, careProfileId, appointmentId, items, createdBy: req.user.lineUserId,
  });
  res.status(201).json(bill);
}));

module.exports = router;
