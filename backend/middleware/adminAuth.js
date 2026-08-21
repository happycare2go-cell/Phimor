// middleware/adminAuth.js
// ตรวจสอบสิทธิ์สำหรับ Endpoint ภายในที่ทีมงาน Care2Go ใช้เท่านั้น (ไม่ใช่ศูนย์หรือครอบครัว)
//
// ⚠️ จงใจแยกกลไกออกจาก middleware/auth.js (LINE ID Token) โดยสิ้นเชิง เพราะ:
// ① ทีมงานภายในไม่มี LINE User ID ที่เกี่ยวข้องกับระบบนี้เสมอไป
// ② การสร้างศูนย์ (FR-A1) เป็นสิทธิ์ระดับทีมงาน ไม่ควรปนกับสิทธิ์ของศูนย์/ครอบครัวเด็ดขาด
//    ถ้าปนกัน เสี่ยงต่อการที่ Bug ในสิทธิ์ฝั่งศูนย์จะลามมาถึงสิทธิ์สร้างศูนย์ใหม่ได้
//
// API Key ใช้ bootstrap/break-glass; งานปกติใช้ LINE ID Token ที่ผูกใน AdminUsers
// เพื่อระบุตัวผู้ดูแลแต่ละคนใน Audit Log ได้

const { AdminUsers } = require('../db');
const { identify } = require('./auth');

function validAdminKey(value) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return false;
  const crypto = require('crypto');
  const provided = Buffer.from(String(value || ''));
  const configured = Buffer.from(String(expected));
  return provided.length === configured.length && crypto.timingSafeEqual(provided, configured);
}

async function identifyAdmin(req) {
  if (validAdminKey(req.header('X-Admin-Key'))) {
    return { actor: 'admin:key', authMethod: 'api_key' };
  }
  const identity = await identify(req);
  if (!identity) return null;
  const admin = await AdminUsers.findOne((row) => row.line_user_id === identity.lineUserId && row.status === 'active');
  if (!admin) return null;
  return { actor: `admin:${identity.lineUserId}`, authMethod: 'line', lineUserId: identity.lineUserId, admin };
}

async function requireAdminKey(req, res, next) {
  const key = req.header('X-Admin-Key');
  const expected = process.env.ADMIN_API_KEY;

  if (!expected) {
    // ป้องกันความผิดพลาดร้ายแรง: ถ้า Deploy จริงแล้วลืมตั้งค่า ต้องปิดกั้นทันที ห้ามเปิดช่องให้ผ่านฟรี
    return res.status(503).json({ error: 'not_configured', message: 'ยังไม่ได้ตั้งค่า ADMIN_API_KEY บน Server' });
  }
  try {
    const identity = await identifyAdmin(req);
    if (!identity) {
      return res.status(401).json({ error: 'unauthorized', message: 'ไม่มีสิทธิ์เข้าถึง Endpoint นี้' });
    }
    req.admin = identity;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { requireAdminKey, validAdminKey };
