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
const { Centers, Residents, CareProfiles, AuditLog, DataSubjectRequests, audit, now } = require('../db');
const subscriptionService = require('../services/subscriptionService');

router.use(requireAdminKey);

// POST /api/admin/centers — สร้างบัญชีศูนย์ใหม่ (ข้อ FR-A1)
// ใช้ระหว่างทีมงานคุยกับเจ้าของศูนย์ตัวต่อตัวตอน Onboarding
router.post('/centers', asyncHandler(async (req, res) => {
  const { name, ownerLineId, subscriptionStartAt, subscriptionEndAt, packageType } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'bad_request', message: 'กรุณาระบุชื่อศูนย์' });
  }
  if (!ownerLineId || !ownerLineId.trim()) {
    return res.status(400).json({ error: 'bad_request', message: 'กรุณาระบุ LINE User ID ของเจ้าของศูนย์' });
  }
  if (process.env.NODE_ENV !== 'test' && !/^U[0-9a-f]{32}$/i.test(ownerLineId.trim())) {
    return res.status(400).json({ error: 'bad_request', message: 'LINE User ID ไม่ถูกต้อง ต้องขึ้นต้นด้วย U และมีอักขระตามหลัง 32 ตัว' });
  }

  const center = await centerService.createCenter({ name: name.trim(), ownerLineId: ownerLineId.trim() });
  let subscription = subscriptionService.entitlement(center);
  if (subscriptionStartAt && subscriptionEndAt) {
    const configured = await subscriptionService.setSubscription({ centerId: center.center_id, startsAt: subscriptionStartAt, expiresAt: subscriptionEndAt, packageType: packageType || 'custom', actor: 'admin' });
    if (!configured.ok) return res.status(400).json({ error: 'bad_request', message: configured.reason });
    subscription = configured.entitlement;
  }
  res.status(201).json({
    centerId: center.center_id,
    name: center.name,
    ownerLineId: center.owner_line_id,
    status: center.status,
    subscription,
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
  const rows = [];
  for (const c of centers) {
    const residents = await Residents.findWhere((r) => r.center_id === c.center_id && r.status === 'active');
    rows.push({
      centerId: c.center_id, name: c.name, ownerLineId: c.owner_line_id,
      status: c.status, groupBound: !!c.group_id, createdAt: c.created_at,
      address: c.address || '', contactPhone: c.contact_phone || '', activeResidentCount: residents.length,
      subscriptionStartAt: c.subscription_start_at || null, subscriptionEndAt: c.subscription_end_at || null,
      packageType: c.subscription_package_type || null, subscription: subscriptionService.entitlement(c),
    });
  }
  res.json({
    centers: rows,
  });
}));

router.get('/centers/:centerId', asyncHandler(async (req, res) => {
  const details = await subscriptionService.getAdminCenterDetails(req.params.centerId);
  if (!details) return res.status(404).json({ error: 'not_found', message: 'ไม่พบศูนย์นี้' });
  await audit('admin.center_details_viewed', 'admin', { centerId: req.params.centerId });
  res.json(details);
}));

router.patch('/centers/:centerId/subscription', asyncHandler(async (req, res) => {
  try {
    const result = await subscriptionService.setSubscription({
      centerId: req.params.centerId, startsAt: req.body.startsAt, expiresAt: req.body.expiresAt,
      packageType: req.body.packageType || 'custom', note: req.body.note || '', actor: 'admin',
    });
    if (!result.ok) return res.status(400).json({ error: 'bad_request', message: result.reason });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: 'bad_request', message: error.message });
  }
}));

router.post('/centers/:centerId/transfer-owner', asyncHandler(async (req, res) => {
  const newOwnerLineId = String(req.body.newOwnerLineId || '').trim();
  if (!newOwnerLineId) return res.status(400).json({ error:'bad_request', message:'กรุณาระบุ LINE User ID เจ้าของคนใหม่' });
  const result = await centerService.transferOwner({ centerId:req.params.centerId, newOwnerLineId, actor:'admin', keepPreviousAsManager:!!req.body.keepPreviousAsManager });
  if (!result.ok) return res.status(400).json({ error:'bad_request', message:result.reason });
  res.json(result);
}));

router.get('/centers/:centerId/care-profiles', asyncHandler(async (req, res) => {
  const center = await Centers.findOne((c) => c.center_id === req.params.centerId);
  if (!center) return res.status(404).json({ error: 'not_found', message: 'ไม่พบศูนย์นี้' });
  const residents = await Residents.findWhere((r) => r.center_id === center.center_id);
  const rows = [];
  for (const resident of residents) {
    const profile = resident.care_profile_id && await CareProfiles.findOne((p) => p.care_profile_id === resident.care_profile_id);
    rows.push({ resident, profile: profile || null });
  }
  await audit('admin.care_profiles_viewed', 'admin', { centerId: center.center_id, count: rows.length });
  res.json({ center: { centerId: center.center_id, name: center.name }, rows });
}));

router.get('/audit', asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const logs = await AuditLog.findAll();
  res.json({ logs: logs.slice(0, limit) });
}));

router.get('/data-requests', asyncHandler(async (req, res) => {
  res.json({ requests: await DataSubjectRequests.findAll() });
}));

router.patch('/data-requests/:requestId', asyncHandler(async (req, res) => {
  if (!['in_progress', 'completed', 'rejected'].includes(req.body.status)) return res.status(400).json({ error: 'bad_request' });
  const request = await DataSubjectRequests.update((r) => r.request_id === req.params.requestId, { status: req.body.status, admin_note: String(req.body.note || '').slice(0, 1000), updated_at: now(), updated_by: 'admin' });
  if (!request) return res.status(404).json({ error: 'not_found' });
  await audit('privacy.data_request_updated', 'admin', { requestId: request.request_id, status: request.status });
  res.json(request);
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
