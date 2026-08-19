// middleware/externalAuth.js — ตรวจสอบสิทธิ์ระบบภายนอกที่ส่งข้อมูลสัญญาณชีพเข้ามา (ข้อ J4)
//
// แยกกลไกจากทั้ง LINE Auth (middleware/auth.js) และ Admin Auth (middleware/adminAuth.js)
// เพราะผู้เรียกเป็น "ระบบของศูนย์" ไม่ใช่คนที่มี LINE User ID และไม่ใช่ทีมงานภายใน
// กุญแจแยกต่อศูนย์ (Centers.external_api_key) ทำให้เพิกถอนสิทธิ์เป็นรายศูนย์ได้โดยไม่กระทบศูนย์อื่น

const centerService = require('../services/centerService');

async function requireCenterApiKey(req, res, next) {
  const apiKey = req.header('X-Center-Api-Key');
  if (!apiKey) {
    return res.status(401).json({ error: 'unauthorized', message: 'ไม่พบ API Key' });
  }
  const center = await centerService.findCenterByApiKey(apiKey);
  if (!center) {
    return res.status(401).json({ error: 'unauthorized', message: 'API Key ไม่ถูกต้องหรือถูกเพิกถอนแล้ว' });
  }
  req.center = center;
  next();
}

module.exports = { requireCenterApiKey };
