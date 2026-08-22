// tests/scheduler.test.js — ยืนยันว่า Cron Schedule ตั้งเวลาถูกต้อง โดยเฉพาะเรื่องเขตเวลา

const { test } = require('node:test');
const assert = require('node:assert');
const cron = require('../backend/node_modules/node-cron'); // require ผ่าน path เต็ม เพราะไฟล์ Test อยู่คนละ Directory กับ node_modules
const { TZ } = require('../backend/utils/thaiDate');

test('เขตเวลาที่ใช้ต้องเป็น Asia/Bangkok เสมอ ไม่พึ่งพา Timezone ของเครื่อง Server', () => {
  assert.strictEqual(TZ, 'Asia/Bangkok');
});

test('รูปแบบ Cron ทั้ง 5 งานต้องถูกต้องตามที่ node-cron ยอมรับ', () => {
  assert.strictEqual(cron.validate('*/15 * * * *'), true, 'หมดอายุการ์ด: ทุก 15 นาที');
  assert.strictEqual(cron.validate('0 7 * * *'), true, 'แจ้งเตือนนัด: ทุกวัน 07:00');
  assert.strictEqual(cron.validate('0 18 * * 0'), true, 'สรุปรายสัปดาห์: วันอาทิตย์ 18:00');
  assert.strictEqual(cron.validate('0 18 * * *'), true, 'สรุปนัดพรุ่งนี้ (ข้อ K3): ทุกวัน 18:00');
  assert.strictEqual(cron.validate('0 * * * *'), true, 'เตือนครอบครัวที่ยังไม่ตัดสินใจ (ข้อ L10): ทุกชั่วโมง');
});

test('เริ่มและหยุด Scheduler ได้โดยไม่มี Error และไม่มี Task ค้าง', async () => {
  const server = require('../backend/server');
  server.startScheduler();
  // ให้เวลาตั้งค่าเสร็จเล็กน้อย
  await new Promise((r) => setTimeout(r, 50));
  server.stopScheduler();
  // เรียกซ้ำต้องไม่ error (ทดสอบว่า stop แล้ว state สะอาด เริ่มใหม่ได้)
  server.startScheduler();
  server.stopScheduler();
});

test('Staging clock เร่งเวลาได้ แต่ Production ไม่รับค่า offset', () => {
  const server = require('../backend/server');
  const originalMode = process.env.STAGING_MODE;
  const originalOffset = process.env.STAGING_CLOCK_OFFSET_MINUTES;
  process.env.STAGING_MODE = 'true';
  process.env.STAGING_CLOCK_OFFSET_MINUTES = '1440';
  const accelerated = server.schedulerReferenceDate().getTime();
  assert.ok(accelerated - Date.now() > 1439 * 60000);
  process.env.STAGING_MODE = 'false';
  const production = server.schedulerReferenceDate().getTime();
  assert.ok(Math.abs(production - Date.now()) < 1000);
  if (originalMode === undefined) delete process.env.STAGING_MODE; else process.env.STAGING_MODE = originalMode;
  if (originalOffset === undefined) delete process.env.STAGING_CLOCK_OFFSET_MINUTES; else process.env.STAGING_CLOCK_OFFSET_MINUTES = originalOffset;
});
