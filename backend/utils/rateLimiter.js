// utils/rateLimiter.js — จำกัดอัตราการส่งรูปต่อกลุ่ม (ข้อ C5)
//
// เหตุผล: ทุกรูปที่ส่งเข้ามาเรียก AI ซึ่งมีต้นทุนจริงต่อครั้ง หากไม่จำกัดอัตรา
// อาจเกิดการส่งรูปรัว (ตั้งใจหรือไม่ตั้งใจก็ตาม) ทำให้ต้นทุน AI บานปลายได้ในเวลาสั้นๆ
//
// ใช้ In-memory Sliding Window ต่อ Key (ปกติคือ groupId) — เพียงพอสำหรับ Instance เดียว
// ถ้าอนาคตขยายเป็นหลาย Instance ต้องย้ายไป Redis หรือ Store กลางแทน

const windows = new Map(); // key -> array of timestamps (ms)

/**
 * ตรวจสอบและบันทึกการเรียกใหม่ 1 ครั้ง
 * @param {string} key เช่น groupId
 * @param {number} limit จำนวนครั้งสูงสุดในหน้าต่างเวลา
 * @param {number} windowMs ความยาวหน้าต่างเวลา (มิลลิวินาที)
 * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
 */
function checkAndRecord(key, limit, windowMs) {
  const now = Date.now();
  const timestamps = (windows.get(key) || []).filter((t) => now - t < windowMs);

  if (timestamps.length >= limit) {
    const oldestInWindow = Math.min(...timestamps);
    const retryAfterMs = windowMs - (now - oldestInWindow);
    windows.set(key, timestamps); // ยังไม่บันทึกครั้งนี้ เพราะถูกปฏิเสธ
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, retryAfterMs) };
  }

  timestamps.push(now);
  windows.set(key, timestamps);
  return { allowed: true, remaining: limit - timestamps.length, retryAfterMs: 0 };
}

function reset() {
  windows.clear();
}

module.exports = { checkAndRecord, reset };
