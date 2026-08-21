const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const familyService = require('../services/familyService');
const { verifyPdfToken } = require('../utils/pdfDownloadToken');
router.get('/', asyncHandler(async (req, res) => {
  const payload = verifyPdfToken(req.query.token);
  if (!payload) return res.status(401).json({ error: 'invalid_or_expired_link', message: 'ลิงก์ดาวน์โหลดหมดอายุ กรุณาสร้างใหม่จาก Family LIFF' });
  if (!await familyService.canAccessProfile(payload.careProfileId, payload.lineUserId)) return res.status(403).json({ error: 'forbidden', message: 'ไม่มีสิทธิ์เข้าถึง Care Profile นี้' });
  const result = await familyService.exportHistoryToPdf(payload.careProfileId, { fromDate: payload.fromDate, toDate: payload.toDate });
  if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
  const disposition = req.query.download === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', disposition + '; filename="' + result.asciiFilename + '"; filename*=UTF-8' + "''" + encodeURIComponent(result.filename));
  res.send(result.pdfBuffer);
}));
module.exports = router;
