// routes/access.js — Endpoint สำหรับ FR-O คำขอเชื่อมต่อ

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const accessService = require('../services/accessService');

router.use(requireAuth);

// POST /api/access-requests/:id/respond — ครอบครัวตอบรับหรือปฏิเสธ (ข้อ O2 — ไม่ต้องให้เหตุผล)
router.post('/access-requests/:requestId/respond', asyncHandler(async (req, res) => {
  const { approved } = req.body;
  const result = await accessService.respondAccessRequest(req.params.requestId, !!approved, req.user.lineUserId);
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  res.json(result);
}));

// GET /api/access-requests/:id — ศูนย์เช็คสถานะ (เห็นแค่สถานะ ไม่เห็นเหตุผล — ข้อ O2)
router.get('/access-requests/:requestId', asyncHandler(async (req, res) => {
  const status = await accessService.getRequestStatusForCenter(req.params.requestId);
  if (!status) return res.status(404).json({ error: 'not_found' });
  res.json(status);
}));

module.exports = router;
