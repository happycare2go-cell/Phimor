// routes/admin.js — Endpoint สำหรับทีมงาน Care2Go เท่านั้น (ตาม FR-A1)
// ป้องกันด้วย ADMIN_API_KEY ไม่ใช่ LINE ID Token — ดู middleware/adminAuth.js
//
// ⚠️ Mount ที่ /api/admin (Path Prefix แยกจาก /api ของ Router อื่นทั้งหมด) โดยตั้งใจ
//    เพราะ centersRouter.use(requireAuth) จับทุก Path ที่ขึ้นต้นด้วย /api ไปตรวจ LINE Auth ก่อนเสมอ
//    ถ้า mount adminRouter รวมกับ Router อื่นที่ /api เหมือนกัน จะโดน requireAuth ของ Router อื่น
//    ปฏิเสธก่อนถึง Route ของ Admin เอง (เจอ Bug นี้จริงตอนเขียน Test — ดู tests/adminRoutes.test.js)

const express = require('express');
const router = express.Router();
const { requireAdminKey } = require('../middleware/adminAuth');
const { asyncHandler } = require('../middleware/asyncHandler');
const centerService = require('../services/centerService');
const { Centers, audit } = require('../db');

router.use(requireAdminKey);

// POST /api/admin/centers — สร้างบัญชีศูนย์ใหม่ (ข้อ FR-A1)
// ใช้ระหว่างทีมงานคุยกับเจ้าของศูนย์ตัวต่อตัวตอน Onboarding
router.post('/centers', asyncHandler(async (req, res) => {
  const { name, ownerLineId } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'bad_request', message: 'กรุณาระบุชื่อศูนย์' });
  }
  if (!ownerLineId || !ownerLineId.trim()) {
    return res.status(400).json({ error: 'bad_request', message: 'กรุณาระบุ LINE User ID ของเจ้าของศูนย์' });
  }

  const center = await centerService.createCenter({ name: name.trim(), ownerLineId: ownerLineId.trim() });
  res.status(201).json({
    centerId: center.center_id,
    name: center.name,
    ownerLineId: center.owner_line_id,
    status: center.status,
    nextSteps: [
      'ให้เจ้าของศูนย์เพิ่มเพื่อน LINE OA ของพี่หมอก่อน (ถ้ายังไม่ได้เพิ่ม)',
      'ให้เจ้าของศูนย์สร้างกลุ่มไลน์งานศูนย์ แล้วเชิญพี่หมอเข้ากลุ่ม — ระบบจะผูกกลุ่มให้อัตโนมัติ',
      'นำเข้ารายชื่อผู้พักผ่าน POST /api/residents/import หรือให้เจ้าของศูนย์เพิ่มเองผ่าน LIFF',
    ],
  });
}));

// GET /api/admin/centers — รายชื่อศูนย์ทั้งหมดในระบบ (ใช้ตรวจสอบ/ค้นหา)
router.get('/centers', asyncHandler(async (req, res) => {
  const centers = await Centers.findAll();
  res.json({
    centers: centers.map((c) => ({
      centerId: c.center_id, name: c.name, ownerLineId: c.owner_line_id,
      status: c.status, groupBound: !!c.group_id, createdAt: c.created_at,
    })),
  });
}));

// GET /api/admin/centers/:centerId/staff — ดูรายชื่อทีมงานของศูนย์
// ใช้ตอนเจ้าของศูนย์ขอให้ทีมงานช่วยหา LINE User ID เพื่อแต่งตั้งผู้จัดการ
router.get('/centers/:centerId/staff', asyncHandler(async (req, res) => {
  const center = await Centers.findOne((c) => c.center_id === req.params.centerId);
  if (!center) return res.status(404).json({ error: 'not_found', message: 'ไม่พบศูนย์นี้' });

  const staff = await centerService.listStaff(req.params.centerId);
  res.json({
    centerId: center.center_id, centerName: center.name,
    staff: staff.map((s) => ({
      lineUserId: s.line_user_id,
      role: s.role,
      roleLabel: { owner: 'เจ้าของศูนย์', manager: 'ผู้จัดการ', staff: 'พนักงาน' }[s.role] || s.role,
      autoRegistered: !!s.auto_registered,
      assignedAt: s.assigned_at,
    })),
  });
}));

// POST /api/admin/centers/:centerId/rotate-key — หมุน API Key ของระบบภายนอกใหม่
// ใช้เมื่อสงสัยว่า Key รั่ว หรือศูนย์เปลี่ยนผู้ดูแลระบบ
router.post('/centers/:centerId/rotate-key', asyncHandler(async (req, res) => {
  const center = await Centers.findOne((c) => c.center_id === req.params.centerId);
  if (!center) return res.status(404).json({ error: 'not_found', message: 'ไม่พบศูนย์นี้' });

  const newKey = await centerService.rotateExternalApiKey(req.params.centerId, 'admin:manual_rotate');
  res.json({
    ok: true, centerId: center.center_id, newApiKey: newKey,
    warning: 'กุญแจเดิมถูกเพิกถอนทันที ต้องแจ้งศูนย์ให้เปลี่ยนค่าในระบบของเขาโดยเร็ว',
  });
}));

// POST /api/admin/centers/:centerId/status — เปิดหรือปิดใช้งานศูนย์
// ปิดใช้งานเมื่อศูนย์เลิกใช้บริการ โดยข้อมูลยังอยู่ครบ ไม่ได้ลบทิ้ง
router.post('/centers/:centerId/status', asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'bad_request', message: 'status ต้องเป็น active หรือ suspended เท่านั้น' });
  }
  const center = await Centers.findOne((c) => c.center_id === req.params.centerId);
  if (!center) return res.status(404).json({ error: 'not_found', message: 'ไม่พบศูนย์นี้' });

  await Centers.update((c) => c.center_id === req.params.centerId, { status });
  await audit('center.status_changed', 'admin', { centerId: req.params.centerId, status });

  res.json({
    ok: true, centerId: center.center_id, status,
    note: status === 'suspended'
      ? 'ศูนย์ถูกปิดใช้งานแล้ว พนักงานส่งรูปไม่ได้ และระบบภายนอกส่งข้อมูลไม่ได้ แต่ข้อมูลเดิมยังอยู่ครบ'
      : 'ศูนย์กลับมาใช้งานได้ตามปกติแล้ว',
  });
}));

module.exports = router;
