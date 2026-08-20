// backend/routes/centerApi.js
const express = require('express');
const router = express.Router();
const { CenterStaff, Centers } = require('../db');

// รองรับทั้งเส้นทาง /api/center/me และ /api/center-profile
router.get(['/center/me', '/center-profile'], async (req, res) => {
  try {
    const lineUserId = req.query.line_user_id || req.headers['x-line-user-id'];
    
    if (!lineUserId) {
      return res.status(400).json({ error: 'ไม่พบข้อมูล LINE User ID ของผู้ใช้งาน' });
    }

    const staffRecords = await CenterStaff.findWhere(s => s.line_user_id === lineUserId);
    
    if (!staffRecords || staffRecords.length === 0) {
      return res.status(404).json({ error: 'ไม่พบข้อมูลพนักงานหรือศูนย์ที่สังกัด' });
    }

    const userCenterId = staffRecords[0].center_id;
    const userRole = staffRecords[0].role;

    const centerRecords = await Centers.findWhere(c => c.center_id === userCenterId);
    
    if (!centerRecords || centerRecords.length === 0) {
      return res.status(404).json({ error: 'ไม่พบข้อมูลศูนย์ในระบบ' });
    }

    const centerData = centerRecords[0];

    // ส่งโครงสร้างข้อมูลให้ตรงกับที่หน้าเว็บ LIFF รอรับ (me.centers[0])
    return res.json({
      success: true,
      centers: [{
        center_id: centerData.center_id,
        name: centerData.name,
        status: centerData.status,
        myRole: userRole
      }]
    });

  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการประมวลผลหลังบ้าน' });
  }
});

module.exports = router;
