// server.js — จุดเริ่มต้นของระบบ พี่หมอ Backend
// อ้างอิงสถาปัตยกรรมจาก Phimor_Technical_Design.docx หมวด 1

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');

const webhookRouter = require('./routes/webhook');
const centersRouter = require('./routes/centers');
const cardsRouter = require('./routes/cards');
const familyRouter = require('./routes/family');
const transportRouter = require('./routes/transport');
const accessRouter = require('./routes/access');
const adminRouter = require('./routes/admin');
const externalRouter = require('./routes/external');
const reminderService = require('./services/reminderService');
const cardService = require('./services/cardService');
const transportService = require('./services/transportService');
const { TZ } = require('./utils/thaiDate');

const app = express();

// Webhook ต้องมาก่อน express.json() ตัวรวม เพราะจัดการ body ของตัวเองแล้ว
app.use(webhookRouter);

app.use(express.json({ limit: '10mb' })); // รองรับ Base64 รูปภาพขนาดเล็กสำหรับทดสอบ

// ⚠️ adminRouter ต้อง Register ก่อน Router อื่นที่ mount ที่ /api เสมอ
// เพราะ centersRouter มี router.use(requireAuth) ซึ่งจับทุก Path ที่ขึ้นต้นด้วย /api
// (รวมถึง /api/admin/*) ถ้า Register หลัง Request จะโดนปฏิเสธด้วย LINE Auth ก่อนถึง Admin Auth เสมอ
app.use('/api/admin', adminRouter);
app.use('/api/external', externalRouter); // ★ ต้อง Register ก่อน centersRouter เหมือน adminRouter — ดูเหตุผลใน routes/admin.js

app.use('/api', centersRouter);
app.use('/api', cardsRouter);
app.use('/api', familyRouter);
app.use('/api', transportRouter);
app.use('/api', accessRouter);

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'phimor-backend' }));

// ── Error handler กลาง — ไม่เปิดเผยรายละเอียดระบบให้ผู้ไม่มีสิทธิ์เห็น ──
// (ทุก Route ห่อด้วย asyncHandler แล้ว ดังนั้น Error ทุกจุดจะไหลมาถึงนี่เสมอ ไม่มี Request ค้าง)
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error', message: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง' });
});

// ── Scheduler งานประจำ ──
// ⚠️ ต้องระบุ timezone: TZ ('Asia/Bangkok') ในทุก Job เสมอ
//    เพราะ Cloud Hosting ส่วนใหญ่ตั้งเครื่อง Server เป็น UTC โดยปริยาย
//    ถ้าไม่ระบุ Job ที่ควรรัน 07:00 เวลาไทย จะไปรันตอน 07:00 UTC (= 14:00 เวลาไทย) แทน
let scheduledTasks = [];

function startScheduler() {
  // ข้อ E10: หมดอายุการ์ดที่เกิน 24 ชม. — เช็คทุก 15 นาที ให้ใกล้เคียงเวลาจริงที่สุด
  scheduledTasks.push(
    cron.schedule('*/15 * * * *', () => {
      cardService.expireOldCards().catch((err) => console.error('expireOldCards error:', err));
    }, { timezone: TZ })
  );

  // ข้อ G1: แจ้งเตือนนัด (ล่วงหน้า 1 วัน + เช้าวันนัด) — รันทุกเช้า 07:00 เวลาไทย
  scheduledTasks.push(
    cron.schedule('0 7 * * *', () => {
      reminderService.sendAppointmentReminders().catch((err) => console.error('sendAppointmentReminders error:', err));
    }, { timezone: TZ })
  );

  // ข้อ I1: สรุปรายสัปดาห์ให้ศูนย์ — เฉพาะวันอาทิตย์ 18:00 เวลาไทย
  scheduledTasks.push(
    cron.schedule('0 18 * * 0', () => {
      reminderService.sendWeeklySummary().catch((err) => console.error('sendWeeklySummary error:', err));
    }, { timezone: TZ })
  );

  // ข้อ K3: สรุปนัดพรุ่งนี้เข้ากลุ่มงานศูนย์ทุกเย็น 18:00 เวลาไทย
  scheduledTasks.push(
    cron.schedule('0 18 * * *', () => {
      reminderService.sendTomorrowSummaryToCenters().catch((err) => console.error('sendTomorrowSummaryToCenters error:', err));
    }, { timezone: TZ })
  );

  // ข้อ L10: เตือนครอบครัวที่ยังไม่ตัดสินใจ 2 จังหวะ (เหลือ 12 ชม. และ 6 ชม.)
  // เช็คทุก 30 นาที เพื่อให้จับจังหวะได้แม่นยำ แต่ระบบส่งจริงแค่ 2 ครั้งต่อนัดเท่านั้น
  scheduledTasks.push(
    cron.schedule('*/30 * * * *', () => {
      transportService.remindPendingFamilyChoices().catch((err) => console.error('remindPendingFamilyChoices error:', err));
    }, { timezone: TZ })
  );

  console.log(`ตั้งเวลางานประจำแล้ว ${scheduledTasks.length} งาน (เขตเวลา ${TZ})`);
}

function stopScheduler() {
  scheduledTasks.forEach((t) => t.stop());
  scheduledTasks = [];
}

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`พี่หมอ Backend กำลังทำงานที่พอร์ต ${PORT}`);
    startScheduler();
  });
}

module.exports = app;
module.exports.startScheduler = startScheduler;
module.exports.stopScheduler = stopScheduler;
