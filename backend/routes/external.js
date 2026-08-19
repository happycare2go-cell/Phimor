// routes/external.js — Endpoint สำหรับระบบภายนอกของศูนย์ (ข้อ J4)
// ป้องกันด้วย X-Center-Api-Key ไม่ใช่ LINE ID Token — ดู middleware/externalAuth.js
//
// ⚠️ เป็นทางเลือก ไม่ใช่ข้อบังคับ — ศูนย์ที่ไม่มีระบบเดิมต้องใช้พี่หมอได้ครบทุกฟีเจอร์
//    โดยไม่ต้องส่งข้อมูลผ่าน Endpoint นี้เลย (ตามข้อ J4)

const express = require('express');
const router = express.Router();
const { requireCenterApiKey } = require('../middleware/externalAuth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { Vitals, Residents, id, now } = require('../db');

router.use(requireCenterApiKey);

// POST /api/external/vitals — รับสัญญาณชีพจากระบบของศูนย์
router.post('/vitals', asyncHandler(async (req, res) => {
  const { residentId, recordedAt, systolic, diastolic, pulse, temperature, source } = req.body;

  if (!residentId) return res.status(400).json({ error: 'bad_request', message: 'กรุณาระบุ residentId' });

  // ต้องเป็นผู้พักของศูนย์เจ้าของ API Key นี้เท่านั้น (กันข้ามศูนย์)
  const resident = await Residents.findOne((r) => r.resident_id === residentId && r.center_id === req.center.center_id);
  if (!resident) {
    return res.status(404).json({ error: 'not_found', message: 'ไม่พบผู้พักนี้ในศูนย์ของท่าน' });
  }

  // ข้อ J5: บันทึกที่มาของข้อมูลให้ครบ ว่ามาจากศูนย์ใด ระบบใด เมื่อใด
  const record = await Vitals.insert({
    vital_id: id('VT'),
    resident_id: residentId,
    care_profile_id: resident.care_profile_id || null,
    recorded_at: recordedAt || now(),
    systolic: systolic ?? null, diastolic: diastolic ?? null, pulse: pulse ?? null, temperature: temperature ?? null,
    source_center_id: req.center.center_id,
    source_system: source || 'unknown',
    ingested_at: now(),
  });

  res.status(201).json({ ok: true, vitalId: record.vital_id });
}));

module.exports = router;
