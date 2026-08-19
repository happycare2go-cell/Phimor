// routes/cards.js — Endpoint ตาม Technical Design หมวด 5.3

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { centerCanAccessResident } = require('../middleware/auth');
const cardService = require('../services/cardService');
const lineClient = require('../providers/lineClient');

router.use(requireAuth);

// ตรวจว่าผู้เรียกเป็นพนักงานของศูนย์เจ้าของการ์ดนี้จริง (ผ่านกลุ่มงานศูนย์ที่ผูกไว้)
const assertCardBelongsToRequesterCenter = asyncHandler(async (req, res, next) => {
  const { PendingCards, Centers, CenterStaff } = require('../db');
  const card = await PendingCards.findOne((c) => c.card_id === req.params.cardId);
  if (!card) return res.status(404).json({ error: 'not_found', message: 'ไม่พบการ์ด' });

  // อนุญาตทั้งพนักงานทั่วไป (ผ่านกลุ่ม — ระบุมาใน Header สำหรับต้นแบบนี้) และเจ้าของ/ผู้จัดการ
  const asStaff = await CenterStaff.findOne((s) => s.center_id === card.center_id && s.line_user_id === req.user.lineUserId);
  const viaGroup = req.header('X-Line-Group-Id');
  let groupOk = false;
  if (viaGroup) {
    const center = await Centers.findOne((c) => c.center_id === card.center_id);
    groupOk = center && center.group_id === viaGroup;
  }
  if (!asStaff && !groupOk) return res.status(403).json({ error: 'forbidden', message: 'ไม่มีสิทธิ์เข้าถึงการ์ดนี้' });

  req.card = card;
  next();
});

// GET /api/cards/:id — ข้อมูลการ์ดสำหรับหน้าแก้ไข
router.get('/cards/:cardId', assertCardBelongsToRequesterCenter, asyncHandler(async (req, res) => {
  const result = await cardService.getCardForEdit(req.params.cardId);
  res.json(result);
}));

// PATCH /api/cards/:id — บันทึกข้อมูลที่แก้ไข
router.patch('/cards/:cardId', assertCardBelongsToRequesterCenter, asyncHandler(async (req, res) => {
  const { residentId, appointment, medications, doctorNote, editedFields } = req.body;
  const result = await cardService.patchCard(req.params.cardId, { residentId, appointment, medications, doctorNote, editedFields });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json(result.card);
}));

// POST /api/cards/:id/confirm — ยืนยันและส่งให้ครอบครัว
router.post('/cards/:cardId/confirm', assertCardBelongsToRequesterCenter, asyncHandler(async (req, res) => {
  const profile = await lineClient.getProfile(req.user.lineUserId);
  const result = await cardService.confirmCard(req.params.cardId, req.user.lineUserId, profile.displayName);
  if (!result.ok) {
    const statusCode = result.alreadyConfirmed || result.expired ? 409 : 400;
    return res.status(statusCode).json({ error: 'bad_request', message: result.reason });
  }
  res.json(result);
}));

// POST /api/cards/:id/select-resident — เลือกผู้พักเมื่อ AI ไม่มั่นใจ (ข้อ D3)
router.post('/cards/:cardId/select-resident', assertCardBelongsToRequesterCenter, asyncHandler(async (req, res) => {
  const { residentId } = req.body;
  const ok = await centerCanAccessResident(req.card.center_id, residentId);
  if (!ok) return res.status(400).json({ error: 'bad_request', message: 'ผู้พักนี้ไม่ได้อยู่ในศูนย์เดียวกับการ์ด' });
  const result = await cardService.selectResidentForCard(req.params.cardId, residentId);
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json({ ok: true });
}));

module.exports = router;
