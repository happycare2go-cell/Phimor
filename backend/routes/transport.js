// routes/transport.js — Endpoint ตาม Technical Design หมวด 6.4

const express = require('express');
const router = express.Router();
const { requireAuth, requireCenterStaff } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const transportService = require('../services/transportService');
const { TransportPlans, CareProfiles, Appointments } = require('../db');

router.use(requireAuth);

const loadAuthoritativeTransportPlan = asyncHandler(async (req, res, next) => {
  const plan = await TransportPlans.findOne((item) => item.plan_id === req.params.planId);
  if (!plan?.center_id) return res.status(404).json({ error: 'not_found', message: 'ไม่พบข้อมูล' });
  req.transportPlan = plan;
  req.authoritativeCenterId = plan.center_id;
  next();
});

const loadAuthoritativeBillContext = asyncHandler(async (req, res, next) => {
  const { centerId, careProfileId, appointmentId } = req.body || {};
  const context = await transportService.resolveBillContext({ centerId, careProfileId, appointmentId });
  if (!context) {
    return res.status(404).json({ error: 'not_found', message: 'ไม่พบข้อมูลสำหรับออกใบแจ้งค่าใช้จ่าย' });
  }
  req.authoritativeCenterId = context.centerId;
  req.billContext = context;
  next();
});

router.get('/transport/family/pending', asyncHandler(async (req, res) => {
  const { CareProfileMembers } = require('../db');
  const owned = await CareProfiles.findWhere((p) => p.owner_line_id === req.user.lineUserId);
  const memberships = await CareProfileMembers.findWhere((m) => m.line_user_id === req.user.lineUserId && m.status === 'active');
  const ids = [...new Set([...owned.map((p) => p.care_profile_id), ...memberships.map((m) => m.care_profile_id)])];
  res.json({ pending:await transportService.getPendingFamilyPlans(ids) });
}));

// Keep named collection routes before /transport/:planId. Otherwise Express
// treats the word "pending" as a plan id and this screen receives a 404.
router.get('/transport/pending', requireCenterStaff(), asyncHandler(async (req, res) => {
  const pending = await TransportPlans.findWhere((p) => p.center_id === req.centerId && p.status === 'awaiting_center');
  res.json({ pending });
}));

// GET /api/transport/:id — ดูสถานะและประวัติการตัดสินใจ
router.get('/transport/:planId', asyncHandler(async (req, res) => {
  const plan = await TransportPlans.findOne((p) => p.plan_id === req.params.planId);
  if (!plan) return res.status(404).json({ error: 'not_found' });
  const familyAllowed = await require('../services/familyService').canAccessProfile(plan.care_profile_id, req.user.lineUserId);
  const centerAllowed = plan.center_id && await require('../db').CenterStaff.findOne((s) => s.center_id === plan.center_id && s.line_user_id === req.user.lineUserId && (!s.status || s.status === 'active'));
  if (!familyAllowed && !centerAllowed) return res.status(403).json({ error: 'forbidden', message: 'ไม่มีสิทธิ์ดูแผนการเดินทางนี้' });
  res.json(plan);
}));

// POST /api/transport/:id/family-choice — ครอบครัวเลือกชั้นที่ 1 (ข้อ L1, L2, L3)
router.post('/transport/:planId/family-choice', asyncHandler(async (req, res) => {
  const plan = await TransportPlans.findOne((p) => p.plan_id === req.params.planId);
  if (!plan) return res.status(404).json({ error: 'not_found' });
  if (!await require('../services/familyService').hasPermission(plan.care_profile_id, req.user.lineUserId, 'decide_transport')) {
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
router.post(
  '/transport/:planId/care2go-unavailable',
  loadAuthoritativeTransportPlan,
  requireCenterStaff(['owner', 'manager'], { maskUnauthorized: true }),
  asyncHandler(async (req, res) => {
    const plan = req.transportPlan;
    const appt = await Appointments.findOne((a) => a.appointment_id === plan.appointment_id);
    const result = await transportService.markCare2goUnavailable(req.params.planId, appt?.datetime);
    res.json(result);
  })
);

// POST /api/bills — ออกใบแจ้งค่าใช้จ่าย (เจ้าของ/ผู้จัดการ)
router.post(
  '/bills',
  loadAuthoritativeBillContext,
  requireCenterStaff(['owner', 'manager'], { maskUnauthorized: true }),
  asyncHandler(async (req, res) => {
    const { careProfileId, appointmentId, items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'bad_request', message: 'กรุณาระบุรายการค่าใช้จ่าย' });
    }
    const bill = await transportService.createBill({
      centerId: req.centerId, careProfileId, appointmentId, items, createdBy: req.user.lineUserId,
    });
    if (!bill) return res.status(404).json({ error:'not_found', message:'ไม่พบข้อมูลสำหรับออกใบแจ้งค่าใช้จ่าย' });
    res.status(201).json(bill);
  })
);

module.exports = router;
