// middleware/adminAuth.js
// ตรวจสอบสิทธิ์สำหรับ Endpoint ภายในที่ทีมงาน Care2Go ใช้เท่านั้น (ไม่ใช่ศูนย์หรือครอบครัว)
//
// ⚠️ จงใจแยกกลไกออกจาก middleware/auth.js (LINE ID Token) โดยสิ้นเชิง เพราะ:
// ① ทีมงานภายในไม่มี LINE User ID ที่เกี่ยวข้องกับระบบนี้เสมอไป
// ② การสร้างศูนย์ (FR-A1) เป็นสิทธิ์ระดับทีมงาน ไม่ควรปนกับสิทธิ์ของศูนย์/ครอบครัวเด็ดขาด
//    ถ้าปนกัน เสี่ยงต่อการที่ Bug ในสิทธิ์ฝั่งศูนย์จะลามมาถึงสิทธิ์สร้างศูนย์ใหม่ได้
//
// ใช้ Static API Key ผ่าน Environment Variable ง่ายที่สุดสำหรับทีมขนาดเล็กในเฟส 1
// เมื่อทีมโตขึ้นควรอัปเกรดเป็นระบบ Login จริงพร้อม Audit ราย Staff

function requireAdminKey(req, res, next) {
  const key = req.header('X-Admin-Key');
  const expected = process.env.ADMIN_API_KEY;

  if (!expected) {
    // ป้องกันความผิดพลาดร้ายแรง: ถ้า Deploy จริงแล้วลืมตั้งค่า ต้องปิดกั้นทันที ห้ามเปิดช่องให้ผ่านฟรี
    return res.status(503).json({ error: 'not_configured', message: 'ยังไม่ได้ตั้งค่า ADMIN_API_KEY บน Server' });
  }
  const crypto = require('crypto');
  const provided = Buffer.from(String(key || ''));
  const configured = Buffer.from(String(expected));
  const valid = provided.length === configured.length && crypto.timingSafeEqual(provided, configured);
  if (!valid) {
    return res.status(401).json({ error: 'unauthorized', message: 'ไม่มีสิทธิ์เข้าถึง Endpoint นี้' });
  }
  next();
}

module.exports = { requireAdminKey };
