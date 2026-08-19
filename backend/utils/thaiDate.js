// utils/thaiDate.js — จัดรูปแบบวันที่เป็นภาษาไทย โดยยึดเขตเวลา Asia/Bangkok เสมอ
//
// ⚠️ เหตุผลที่ต้องมีไฟล์นี้: Cloud Hosting ส่วนใหญ่ (Render, Vercel, AWS ฯลฯ) ตั้งค่า
// เขตเวลาเครื่อง Server เป็น UTC โดยปริยาย หากเรียก toLocaleString('th-TH') ตรงๆ
// โดยไม่ระบุ timeZone จะได้เวลาไทยผิดไป 7 ชั่วโมงทุกครั้ง — อันตรายมากเพราะเป็นเวลานัดหมายทางการแพทย์
// ทุกจุดในระบบที่ต้องแสดงวันเวลาให้ผู้ใช้เห็น ต้องเรียกผ่านไฟล์นี้เท่านั้น ห้ามเรียก toLocaleString ตรงๆ

const TZ = 'Asia/Bangkok';

function formatThaiDateTime(iso) {
  try {
    return new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ });
  } catch {
    return iso;
  }
}

function formatThaiDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('th-TH', { dateStyle: 'medium', timeZone: TZ });
  } catch {
    return iso;
  }
}

module.exports = { formatThaiDateTime, formatThaiDate, TZ };
