require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const webhookRouter = require('./routes/webhook');
const centersRouter = require('./routes/centers');
const cardsRouter = require('./routes/cards');
const familyRouter = require('./routes/family');
const pdfDownloadRouter = require('./routes/pdfDownload');
const transportRouter = require('./routes/transport');
const accessRouter = require('./routes/access');
const groupsRouter = require('./routes/groups');
const adminRouter = require('./routes/admin');
const externalRouter = require('./routes/external');
const plusRouter = require('./routes/plus');
const consultationsRouter = require('./routes/consultations');
const omiseWebhookRouter = require('./routes/omiseWebhook');
const pharmacistConsultationsRouter = require('./routes/pharmacistConsultations');
const labsRouter = require('./routes/labs');
const doctorQuestionsRouter = require('./routes/doctorQuestions');
const doctorVisitsRouter = require('./routes/doctorVisits');
const { createVitalSignsRouter } = require('./routes/vitalSigns');
const { createDailyCareRouter } = require('./routes/dailyCare');
const { createIntegrationEventsRouter } = require('./routes/integrationEvents');
const { integrationEventService } = require('./services/integrationEventService');
const reminderService = require('./services/reminderService');
const cardService = require('./services/cardService');
const transportService = require('./services/transportService');
const subscriptionService = require('./services/subscriptionService');
const notificationService = require('./services/notificationService');
const db = require('./db');
const { TZ } = require('./utils/thaiDate');
const { missingRuntimeEnvironment, buildPublicLiffConfig } = require('./config/runtimeCapabilities');

const app = express();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  next();
});

const configuredOrigins = (process.env.ALLOWED_ORIGINS || 'https://phimor-liff.onrender.com').split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || process.env.NODE_ENV === 'test' || configuredOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Line-User-Id', 'X-Admin-Key', 'X-Center-Api-Key']
}));

app.use(webhookRouter);
app.use('/api/payments/omise/webhook', express.raw({ type:'application/json', limit:'256kb' }), omiseWebhookRouter);
app.use(express.json({ limit: '10mb' }));

app.use('/api', (req, res, next) => {
  const limit = process.env.NODE_ENV === 'test' ? 2000 : Number(process.env.API_RATE_LIMIT_PER_5_MINUTES || 300);
  const key = `${req.ip}:${req.path.startsWith('/admin') ? 'admin' : 'api'}`;
  const result = require('./utils/rateLimiter').checkAndRecord(key, limit, 5 * 60000);
  if (!result.allowed) {
    res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
    return res.status(429).json({ error:'rate_limited', message:'เรียกใช้งานถี่เกินไป กรุณารอสักครู่' });
  }
  next();
});

app.use('/api/admin', adminRouter);
app.use('/api/external', externalRouter);
app.use('/api/plus', plusRouter);
app.use('/api/consultations', consultationsRouter);
app.use('/api/pharmacist/consultations', pharmacistConsultationsRouter);
app.use('/api/export/pdf/download', pdfDownloadRouter);
app.use('/api/care-profile', labsRouter);
app.use('/api/care-profile', doctorQuestionsRouter);
app.use('/api/care-profile', doctorVisitsRouter);
app.use('/api', createVitalSignsRouter());
app.use('/api', createDailyCareRouter());
app.use('/api/integrations/v1', createIntegrationEventsRouter());
app.use('/api', centersRouter);
app.use('/api', cardsRouter);
app.use('/api', familyRouter);
app.use('/api', transportRouter);
app.use('/api', accessRouter);
app.use('/api', groupsRouter);

let schedulerHeartbeatAt = null;
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'phimor-backend', now: new Date().toISOString() }));
app.get('/ready', async (req, res) => {
  const missing = missingRuntimeEnvironment();
  let database = true; let databaseError = null;
  try { await db.pingDatabase(); } catch (error) { database = false; databaseError = error.message; }
  const notifications = await notificationService.getHealth().catch(() => ({ unavailable: true }));
  const ready = database && missing.length === 0;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', database, databaseError, missingEnvironment: missing, schedulerHeartbeatAt, notifications });
});
app.get('/config/liff', (req, res) => res.json(buildPublicLiffConfig()));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error', message: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง' });
});

let scheduledTasks = [];
function schedulerReferenceDate() {
  if (process.env.STAGING_MODE !== 'true') return new Date();
  const offsetMinutes = Number(process.env.STAGING_CLOCK_OFFSET_MINUTES || 0);
  return new Date(Date.now() + (Number.isFinite(offsetMinutes) ? offsetMinutes : 0) * 60000);
}
function startScheduler() {
  const heartbeat = () => { schedulerHeartbeatAt = new Date().toISOString(); };
  scheduledTasks.push(cron.schedule('*/15 * * * *', () => { cardService.expireOldCards().catch(console.error); }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('*/15 * * * *', () => { cardService.sendPendingCardReminders().catch(console.error); }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('0 7 * * *', () => { reminderService.sendAppointmentReminders().catch(console.error); }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('0 18 * * 0', () => { reminderService.sendWeeklySummary().catch(console.error); }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('0 18 * * *', () => { reminderService.sendTomorrowSummaryToCenters().catch(console.error); }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('*/30 * * * *', () => { transportService.remindPendingFamilyChoices().catch(console.error); }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('0 9 * * *', () => { heartbeat(); subscriptionService.sendExpiryReminders().catch(console.error); }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('*/2 * * * *', () => { heartbeat(); notificationService.processPending().catch(console.error); }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('*/1 * * * *', () => { heartbeat(); webhookRouter.processPendingWebhookEvents?.().catch(console.error); }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('*/1 * * * *', () => {
    heartbeat(); integrationEventService.processDue().catch(() => console.error('integration inbox processing unavailable'));
  }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('15 2 * * *', () => { heartbeat(); require('./services/centerService').reconcileAllCenterStaff().catch(console.error); }, { timezone: TZ }));
  scheduledTasks.push(cron.schedule('45 2 * * *', () => { heartbeat(); require('./services/retentionService').purgeExpiredSourceImages().catch(console.error); }, { timezone: TZ }));
  // Staging only: run time-sensitive jobs every minute with an optional clock
  // offset. Production never enters this branch.
  if (process.env.STAGING_MODE === 'true') {
    scheduledTasks.push(cron.schedule('* * * * *', () => {
      const referenceDate = schedulerReferenceDate();
      heartbeat();
      Promise.all([
        reminderService.sendAppointmentReminders(referenceDate),
        reminderService.sendTomorrowSummaryToCenters(referenceDate),
        subscriptionService.sendExpiryReminders(referenceDate),
      ]).catch(console.error);
    }, { timezone: TZ }));
  }
  heartbeat();
  console.log(`ตั้งเวลางานประจำแล้ว ${scheduledTasks.length} งาน (เขตเวลา ${TZ})`);
}
function stopScheduler() { scheduledTasks.forEach((t) => t.stop()); scheduledTasks = []; }

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  db.initializeDatabase().then(() => {
    app.listen(PORT, () => {
      console.log(`พี่หมอ Backend กำลังทำงานที่พอร์ต ${PORT}`);
      startScheduler();
    });
  }).catch((error) => {
    console.error('เริ่มระบบไม่ได้เพราะฐานข้อมูลไม่พร้อม:', error);
    process.exitCode = 1;
  });
}
module.exports = app;
module.exports.startScheduler = startScheduler;
module.exports.stopScheduler = stopScheduler;
module.exports.schedulerReferenceDate = schedulerReferenceDate;
