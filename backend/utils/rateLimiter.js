// utils/rateLimiter.js — จำกัดอัตราการส่งรูปต่อกลุ่ม (ข้อ C5)
//
// เหตุผล: ทุกรูปที่ส่งเข้ามาเรียก AI ซึ่งมีต้นทุนจริงต่อครั้ง หากไม่จำกัดอัตรา
// อาจเกิดการส่งรูปรัว (ตั้งใจหรือไม่ตั้งใจก็ตาม) ทำให้ต้นทุน AI บานปลายได้ในเวลาสั้นๆ
//
// PostgreSQL is the shared authority in production. Tests intentionally use one
// module-scoped memory repository so independent service instances still share
// the same deterministic limiter state.
const { createSharedRateLimitService } = require('../services/sharedRateLimitService');
const service = createSharedRateLimitService();

/**
 * ตรวจสอบและบันทึกการเรียกใหม่ 1 ครั้ง
 * @param {string} key เช่น groupId
 * @param {number} limit จำนวนครั้งสูงสุดในหน้าต่างเวลา
 * @param {number} windowMs ความยาวหน้าต่างเวลา (มิลลิวินาที)
 * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
 */
async function checkAndRecord(key, limit, windowMs, options) {
  return service.checkAndRecord(key, limit, windowMs, options);
}

async function cleanupExpired(limit) { return service.cleanupExpired(limit); }
async function getHealth() { return service.getHealth(); }
function reset() { service.reset(); }

module.exports = { checkAndRecord, cleanupExpired, getHealth, reset };
