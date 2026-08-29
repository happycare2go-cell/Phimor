// routes/access.js — Endpoint สำหรับ FR-O คำขอเชื่อมต่อ

const express = require('express');
const router = express.Router();
const { requireAuth, requireCenterStaff } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const accessService = require('../services/accessService');

router.use(requireAuth);

router.get('/access-requests', asyncHandler(async (req, res) => {
  const requests = await accessService.listPendingRequestsForOwner(req.user.lineUserId);
  res.json({ requests });
}));

// Authenticated bootstrap for an anonymous Center link. The first LINE actor
// is bound internally; the bearer token is never returned in the projection.
router.post('/access-links/:token/open', asyncHandler(async (req, res) => {
  const result = await accessService.openAnonymousLink({ token:req.params.token, lineUserId:req.user.lineUserId });
  if (!result.ok) return res.status(result.status || 400).json({ error:result.code || 'link_unavailable', message:result.reason });
  res.json(result.request);
}));

// POST /api/access-requests/:id/respond — ครอบครัวตอบรับหรือปฏิเสธ (ข้อ O2 — ไม่ต้องให้เหตุผล)
router.post('/access-requests/:requestId/respond', asyncHandler(async (req, res) => {
  const { approved, careProfileId } = req.body;
  const result = await accessService.respondAccessRequest(req.params.requestId, !!approved, req.user.lineUserId, careProfileId || null);
  if (!result.ok) {
    const status = ['OWNER_REQUIRED'].includes(result.code) ? 403
      : ['REQUEST_NOT_FOUND'].includes(result.code) ? 404
        : ['REQUEST_NOT_PENDING','REQUEST_ALREADY_USED'].includes(result.code) ? 409 : 400;
    return res.status(status).json({ error:result.code || 'bad_request', message:result.reason });
  }
  res.json(result);
}));

// GET /api/access-requests/:id — ศูนย์เช็คสถานะ (เห็นแค่สถานะ ไม่เห็นเหตุผล — ข้อ O2)
router.get('/access-requests/:requestId', requireCenterStaff(['owner', 'manager']), asyncHandler(async (req, res) => {
  const status = await accessService.getRequestStatusForCenter(req.params.requestId, req.centerId);
  if (!status) return res.status(404).json({ error: 'not_found' });
  res.json(status);
}));

module.exports = router;
