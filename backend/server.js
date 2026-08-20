require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const webhookRouter = require('./routes/webhook');
const centersRouter = require('./routes/centers');
const cardsRouter = require('./routes/cards');
const familyRouter = require('./routes/family');
const transportRouter = require('./routes/transport');
const accessRouter = require('./routes/access');
const adminRouter = require('./routes/admin');
const externalRouter = require('./routes/external');
const centerApiRouter = require('./routes/centerApi'); // <-- เพิ่มเข้ามาใหม่
const reminderService = require('./services/reminderService');
const cardService = require('./services/cardService');
const transportService = require('./services/transportService');
const { TZ } = require('./utils/thaiDate');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Line-User-Id', 'X-Admin-Key', 'X-Center-Api-Key']
}));

app.use(webhookRouter);
app.use(express.json({ limit: '10mb' }));

app.use('/api/admin', adminRouter);
app.use('/api/external', externalRouter);
app.use('/api', centersRouter);
app.use('/api', cardsRouter);
app.use('/api', familyRouter);
app.use('/api', transportRouter);
app.use('/api', accessRouter);
app.use('/api', centerApiRouter); // <-- เพิ่มเข้ามาใหม่

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'phimor-backend' }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error', message: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง' });
});

let scheduledTasks = [];
function startScheduler() {
  scheduledTasks.push(cron.schedule('*/15 * * * *', () => { cardService.expireOldCards().catch(console.error); }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('0 7 * * *', () => { reminderService.sendAppointmentReminders().catch(console.error); }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('0 18 * * 0', () => { reminderService.sendWeeklySummary().catch(console.error); }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('0 18 * * *', () => { reminderService.sendTomorrowSummaryToCenters().catch(console.error); }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('*/30 * * * *', () => { transportService.remindPendingFamilyChoices().catch(console.error); }, { timezone: TZ }));
  console.log(`ตั้งเวลางานประจำแล้ว ${scheduledTasks.length} งาน (เขตเวลา ${TZ})`);
}
function stopScheduler() { scheduledTasks.forEach((t) => t.stop()); scheduledTasks = []; }

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
