require('dotenv').config();
const http = require('node:http');
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
const { integrationAdapterService } = require('./services/integrationAdapterService');
const reminderService = require('./services/reminderService');
const cardService = require('./services/cardService');
const transportService = require('./services/transportService');
const subscriptionService = require('./services/subscriptionService');
const notificationService = require('./services/notificationService');
const db = require('./db');
const { TZ } = require('./utils/thaiDate');
const { missingRuntimeEnvironment, buildPublicLiffConfig } = require('./config/runtimeCapabilities');
const { createConsultationRealtimeGateway } = require('./realtime/consultationRealtimeGateway');
const { createConsultationLifecycleSchedulerService } = require('./services/consultationLifecycleSchedulerService');
const { createSchedulerCoordinatorService } = require('./services/schedulerCoordinatorService');
const sharedRateLimiter = require('./utils/rateLimiter');
const { createPlusPaymentSchedulerService } = require('./services/plusPaymentSchedulerService');
const { createPlusPaymentRepository } = require('./services/plusPaymentRepository');
const { loadFeatureFlags } = require('./config/featureFlags');
const { paymentAvailable } = require('./services/plusPaymentOrderService');
const { createReadinessService, readinessTimeoutMs } = require('./services/readinessService');

const consultationLifecycleScheduler = createConsultationLifecycleSchedulerService();
const schedulerCoordinator = createSchedulerCoordinatorService();
const plusPaymentScheduler = createPlusPaymentSchedulerService();
const plusPaymentRepository = createPlusPaymentRepository();

const app = express();
app.locals.schedulerHealth = () => schedulerCoordinator.health();
const readinessService = createReadinessService({
  pingDatabase:() => db.pingDatabase(),
  notificationHealth:() => notificationService.getHealth(),
  rateLimitHealth:() => sharedRateLimiter.getHealth(),
  plusPaymentHealth:() => paymentAvailable(loadFeatureFlags())
    ? plusPaymentRepository.getHealth() : Promise.resolve({ available:true, configured:false }),
  plusPaymentConfigured:() => paymentAvailable(loadFeatureFlags()),
  getDatabasePoolMetrics:() => db.getDatabasePoolMetrics(),
  schedulerHealth:() => schedulerCoordinator.health(),
  realtimeHealth:() => app.locals.consultationRealtimeHealth?.() || { configured:false, started:false },
  missingEnvironment:() => missingRuntimeEnvironment(),
  timeoutMs:readinessTimeoutMs(),
});

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

app.use('/api', async (req, res, next) => {
  const limit = process.env.NODE_ENV === 'test' ? 2000 : Number(process.env.API_RATE_LIMIT_PER_5_MINUTES || 300);
  const domain = req.path.startsWith('/admin') ? 'admin_api'
    : req.path.startsWith('/integrations/v1/') ? 'integration_edge' : 'generic_api';
  let result;
  try { result = await sharedRateLimiter.checkAndRecord(req.ip || 'unknown', limit, 5 * 60000, { domain }); }
  catch (error) {
    if (req.path.startsWith('/integrations/v1/')) {
      const { publicIntegrationError } = require('./domain/integrationErrorContract');
      return res.status(503).json({ status:'retrying', error:publicIntegrationError(error, { status:503 }) });
    }
    return res.status(503).json({ error:'rate_limit_unavailable', message:'ระบบจำกัดอัตราการใช้งานไม่พร้อม กรุณาลองใหม่ภายหลัง' });
  }
  if (!result.allowed) {
    res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
    if (req.path.startsWith('/integrations/v1/')) {
      const { publicIntegrationError } = require('./domain/integrationErrorContract');
      return res.status(429).json({ status:'retrying', error:publicIntegrationError('RATE_LIMITED', { status:429 }) });
    }
    return res.status(429).json({ error:'rate_limited', message:'เรียกใช้งานถี่เกินไป กรุณารอสักครู่' });
  }
  return next();
});

// Machine-to-machine Integration authentication must run before interactive
// routers mounted at the broader /api boundary. The route remains behind the
// shared security, CORS, JSON, and rate-limit middleware above.
app.use('/api/integrations/v1', createIntegrationEventsRouter());
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
app.use('/api', centersRouter);
app.use('/api', cardsRouter);
app.use('/api', familyRouter);
app.use('/api', transportRouter);
app.use('/api', accessRouter);
app.use('/api', groupsRouter);

let schedulerHeartbeatAt = null;
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'phimor-backend', now: new Date().toISOString() }));
app.get('/ready', async (req, res) => {
  const { ready, ...details } = await readinessService.check();
  res.status(ready ? 200 : 503).json({
    status:ready ? 'ready' : 'not_ready', ...details, schedulerHeartbeatAt,
  });
});
app.get('/config/liff', (req, res) => res.json(buildPublicLiffConfig()));

app.use((err, req, res, next) => {
  if (String(req.originalUrl || '').startsWith('/api/integrations/v1/')) {
    const { publicIntegrationError } = require('./domain/integrationErrorContract');
    const status = Number(err?.status) >= 400 && Number(err?.status) < 500 ? Number(err.status) : 500;
    const safe = publicIntegrationError(err, { status });
    console.error('[Integration Request]', JSON.stringify({ event:'integration_request_failed', requestId:safe.request_id, code:safe.code, retryable:safe.retryable, httpStatus:status }));
    if (res.headersSent) return next(err);
    return res.status(status).json({ status:status >= 500 ? 'retrying' : 'rejected', error:safe });
  }
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
  const run = (jobName, task) => {
    heartbeat();
    schedulerCoordinator.run(jobName, task).catch(() => {});
  };
  scheduledTasks.push(cron.schedule('*/15 * * * *', () => run('cardExpiry', () => cardService.expireOldCards()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('*/15 * * * *', () => run('pendingCardReminders', () => cardService.sendPendingCardReminders()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('0 7 * * *', () => run('appointmentReminders', () => reminderService.sendAppointmentReminders()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('0 18 * * 0', () => run('appointmentWeeklySummary', () => reminderService.sendWeeklySummary()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('0 18 * * *', () => run('centerTomorrowSummary', () => reminderService.sendTomorrowSummaryToCenters()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('*/30 * * * *', () => run('transportReminders', () => transportService.remindPendingFamilyChoices()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('0 9 * * *', () => run('subscriptionExpiry', () => subscriptionService.sendExpiryReminders()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('*/2 * * * *', () => run('notificationRetry', () => notificationService.processPending()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('*/1 * * * *', () => run('webhookInbox', () => webhookRouter.processPendingWebhookEvents?.()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('*/1 * * * *', () => run('integrationInbox', () => integrationEventService.processDue()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('*/1 * * * *', () => run('consultationLifecycle', () => consultationLifecycleScheduler.runDueWork()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('*/1 * * * *', () => run('plusPaymentReconciliation', () => plusPaymentScheduler.runDueWork()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('15 2 * * *', () => run('centerStaffReconciliation', () => require('./services/centerService').reconcileAllCenterStaff()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('45 2 * * *', () => run('sourceImageRetention', () => require('./services/retentionService').purgeExpiredSourceImages()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('10 * * * *', () => run('sharedRateLimitCleanup', () => sharedRateLimiter.cleanupExpired()), { timezone: TZ }));
  scheduledTasks.push(cron.schedule('25 * * * *', () => run('integrationAdapterRetention', () => integrationAdapterService.purgeExpired()), { timezone: TZ }));
  // Staging only: run time-sensitive jobs every minute with an optional clock
  // offset. Production never enters this branch.
  if (process.env.STAGING_MODE === 'true') {
    scheduledTasks.push(cron.schedule('* * * * *', () => {
      const referenceDate = schedulerReferenceDate();
      run('appointmentReminders', () => reminderService.sendAppointmentReminders(referenceDate));
      run('centerTomorrowSummary', () => reminderService.sendTomorrowSummaryToCenters(referenceDate));
      run('subscriptionExpiry', () => subscriptionService.sendExpiryReminders(referenceDate));
    }, { timezone: TZ }));
  }
  heartbeat();
  console.log(`ตั้งเวลางานประจำแล้ว ${scheduledTasks.length} งาน (เขตเวลา ${TZ})`);
}
function stopScheduler() { scheduledTasks.forEach((t) => t.stop()); scheduledTasks = []; }

const PORT = process.env.PORT || 3000;
function createBackendHttpServer({ realtimeGateway = createConsultationRealtimeGateway() } = {}) {
  const server = http.createServer(app);
  realtimeGateway.attach(server);
  app.locals.consultationRealtimeHealth = () => realtimeGateway.health();
  server.consultationRealtimeGateway = realtimeGateway;
  return server;
}
if (require.main === module) {
  db.initializeDatabase().then(async () => {
    const server = createBackendHttpServer();
    await server.consultationRealtimeGateway.start();
    server.listen(PORT, () => {
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
module.exports.createBackendHttpServer = createBackendHttpServer;
module.exports.schedulerCoordinator = schedulerCoordinator;
