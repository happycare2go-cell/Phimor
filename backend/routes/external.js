const express = require('express');
const router = express.Router();
const { requireCenterApiKey } = require('../middleware/externalAuth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { Vitals, Residents, Centers, id, now } = require('../db');
const centerService = require('../services/centerService');
const { projectCenter } = require('../services/centerProjection');
const rateLimiter = require('../utils/rateLimiter');

const requireLegacyCenterRateLimit = asyncHandler(async (req, res, next) => {
  try {
    const limit = process.env.NODE_ENV === 'test' ? 2000
      : Math.max(1, Number(process.env.LEGACY_CENTER_API_RATE_LIMIT_PER_MINUTE || 120));
    const decision = await rateLimiter.checkAndRecord(
      req.center.center_id, limit, 60000, { domain:'legacy_center_api' }
    );
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
      return res.status(429).json({ error:'rate_limited', message:'เรียกใช้งานถี่เกินไป กรุณารอสักครู่' });
    }
    return next();
  } catch (_) {
    return res.status(503).json({ error:'rate_limit_unavailable', message:'ระบบจำกัดอัตราการใช้งานไม่พร้อม กรุณาลองใหม่ภายหลัง' });
  }
});

router.post('/register-center', asyncHandler(async (req, res) => {
  const { centerName, address, contactPhone, idToken } = req.body;
  const { verifyLineIdToken } = require('../middleware/auth');
  const identity = await verifyLineIdToken(idToken);
  if (!centerName || !identity) return res.status(401).json({ error: 'ไม่สามารถยืนยันบัญชี LINE ได้' });
  const lineUserId = identity.lineUserId;
  const duplicate = await Centers.findOne((c) => c.owner_line_id === lineUserId && c.name.trim() === centerName.trim() && c.status === 'active');
  if (duplicate) return res.status(409).json({ error: 'ศูนย์ชื่อนี้ถูกลงทะเบียนกับบัญชีของคุณแล้ว', center: projectCenter(duplicate) });
  const newCenter = await centerService.createCenter({ name: centerName, ownerLineId: lineUserId, address, contactPhone });
  res.status(201).json({ success: true, message: 'ลงทะเบียนศูนย์สำเร็จ รอผู้ดูแลระบบกำหนดสิทธิแพ็กเกจ', center: projectCenter(newCenter), subscription: require('../services/subscriptionService').entitlement(newCenter) });
}));

router.post('/vitals', requireCenterApiKey, requireLegacyCenterRateLimit, asyncHandler(async (req, res) => {
  const { residentId, recordedAt, systolic, diastolic, pulse, temperature, source } = req.body;
  res.setHeader('Deprecation', 'true');
  if (!residentId) return res.status(400).json({ error: 'bad_request', message: 'กรุณาระบุ residentId' });
  const resident = await Residents.findOne((r) => r.resident_id === residentId && r.center_id === req.center.center_id);
  if (!resident) return res.status(404).json({ error: 'not_found', message: 'ไม่พบผู้พักนี้ในศูนย์ของท่าน' });

  const record = await Vitals.insert({
    vital_id: id('VT'), resident_id: residentId, care_profile_id: resident.care_profile_id || null,
    recorded_at: recordedAt || now(), systolic: systolic ?? null, diastolic: diastolic ?? null, pulse: pulse ?? null, temperature: temperature ?? null,
    source_center_id: req.center.center_id,
    source_system: 'legacy_center_api_key',
    legacy_reported_source: typeof source === 'string' ? source.slice(0, 100) : null,
    ingested_at: now(),
  });
  res.status(201).json({ ok: true, vitalId: record.vital_id });
}));

module.exports = router;
