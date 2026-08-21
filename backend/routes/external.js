const express = require('express');
const router = express.Router();
const { requireCenterApiKey } = require('../middleware/externalAuth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { Vitals, Residents, Centers, id, now } = require('../db');
const centerService = require('../services/centerService');

router.post('/register-center', asyncHandler(async (req, res) => {
  const { centerName, address, contactPhone, idToken } = req.body;
  const { verifyLineIdToken } = require('../middleware/auth');
  const identity = await verifyLineIdToken(idToken);
  if (!centerName || !identity) return res.status(401).json({ error: 'ไม่สามารถยืนยันบัญชี LINE ได้' });
  const lineUserId = identity.lineUserId;
  const duplicate = await Centers.findOne((c) => c.owner_line_id === lineUserId && c.name.trim() === centerName.trim() && c.status === 'active');
  if (duplicate) return res.status(409).json({ error: 'ศูนย์ชื่อนี้ถูกลงทะเบียนกับบัญชีของคุณแล้ว', center: duplicate });
  const newCenter = await centerService.createCenter({ name: centerName, ownerLineId: lineUserId, address, contactPhone });
  res.status(201).json({ success: true, message: 'ลงทะเบียนศูนย์สำเร็จ รอผู้ดูแลระบบกำหนดสิทธิแพ็กเกจ', center: newCenter, subscription: require('../services/subscriptionService').entitlement(newCenter) });
}));

router.post('/vitals', requireCenterApiKey, asyncHandler(async (req, res) => {
  const { residentId, recordedAt, systolic, diastolic, pulse, temperature, source } = req.body;
  if (!residentId) return res.status(400).json({ error: 'bad_request', message: 'กรุณาระบุ residentId' });
  const resident = await Residents.findOne((r) => r.resident_id === residentId && r.center_id === req.center.center_id);
  if (!resident) return res.status(404).json({ error: 'not_found', message: 'ไม่พบผู้พักนี้ในศูนย์ของท่าน' });

  const record = await Vitals.insert({
    vital_id: id('VT'), resident_id: residentId, care_profile_id: resident.care_profile_id || null,
    recorded_at: recordedAt || now(), systolic: systolic ?? null, diastolic: diastolic ?? null, pulse: pulse ?? null, temperature: temperature ?? null,
    source_center_id: req.center.center_id, source_system: source || 'unknown', ingested_at: now(),
  });
  res.status(201).json({ ok: true, vitalId: record.vital_id });
}));

module.exports = router;
