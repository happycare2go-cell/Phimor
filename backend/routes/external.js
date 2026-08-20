const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/asyncHandler');
const centerService = require('../services/centerService');

// POST /api/external/register-center (สำหรับสร้างศูนย์ผ่านหน้า LIFF)
router.post('/register-center', asyncHandler(async (req, res) => {
  const { centerName, lineUserId } = req.body;

  if (!centerName || !lineUserId) {
    return res.status(400).json({ error: 'กรุณาระบุชื่อศูนย์และ LINE ID' });
  }

  // เรียกใช้ Service สร้างศูนย์
  const newCenter = await centerService.createCenter(centerName, lineUserId);

  res.status(201).json({ 
    success: true, 
    message: 'สร้างศูนย์สำเร็จ', 
    center: newCenter 
  });
}));

module.exports = router;
