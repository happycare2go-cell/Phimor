const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { loadFeatureFlags } = require('../config/featureFlags');
const { getPlusEntitlement } = require('../services/plusEntitlementService');
const { PLUS_CAPABILITY_REGISTRY } = require('../services/plusEntitlementService');
const { createPlusPaymentOrderService, paymentAvailable } = require('../services/plusPaymentOrderService');
const { PLUS_PLAN_ID, PLUS_PRICE_MINOR, PLUS_CURRENCY, PLUS_DURATION_DAYS, PLUS_RETURN_TARGETS } = require('../domain/plusPayment');
const { authorizeCareProfileAccess } = require('../services/careProfileAuthorizationService');
const { handlePlusRequest, PURPOSES } = require('../services/plusOrchestrationService');
const { getUpcomingAppointmentById } = require('../services/appointmentSummaryService');
const rateLimiter = require('../utils/rateLimiter');

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ASK_FIELDS = new Set(['question', 'purposeHint']);
const PREPARE_FIELDS = new Set(['question']);
const CHECKOUT_FIELDS = new Set(['returnTarget', 'idempotencyKey', 'renew']);

function parseRateLimit(value, fallback = 10) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : fallback;
}

function unavailable(res, errorCode, status = 503) {
  return res.status(status).json({ status: 'unavailable', errorCode, message: 'Phimor Plus ยังไม่พร้อมใช้งานสำหรับบัญชีนี้' });
}

function paymentError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 503;
  const code = /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.code || '') ? error.code : 'PLUS_PAYMENT_UNAVAILABLE';
  const messages = {
    PLUS_ALREADY_ACTIVE: 'พี่หมอ Plus ยังใช้งานได้ หากต้องการต่ออายุกรุณาเลือกต่ออายุโดยตรง',
    PLUS_ORDER_NOT_FOUND: 'ไม่พบรายการพี่หมอ Plus นี้',
    PLUS_PAYMENT_DISABLED: 'การสมัครพี่หมอ Plus ยังไม่พร้อมใช้งาน',
    INVALID_RETURN_TARGET: 'ไม่สามารถกลับไปยังฟีเจอร์ที่ขอได้',
    INVALID_IDEMPOTENCY_KEY: 'ไม่สามารถสร้างรายการซ้ำได้ กรุณาลองใหม่',
  };
  return res.status(status).json({
    status: status >= 500 ? 'unavailable' : 'rejected',
    errorCode: code,
    message: messages[code] || 'ดำเนินการพี่หมอ Plus ไม่สำเร็จ กรุณาลองใหม่',
  });
}

function validateIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function validateBody(body, allowedFields, { questionRequired }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, errorCode: 'INVALID_BODY' };
  const unsupported = Object.keys(body).find((field) => !allowedFields.has(field));
  if (unsupported) return { ok: false, errorCode: 'UNSUPPORTED_FIELD' };
  if (questionRequired && (typeof body.question !== 'string' || !body.question.trim())) return { ok: false, errorCode: 'QUESTION_REQUIRED' };
  if (body.question !== undefined && (typeof body.question !== 'string' || body.question.trim().length > 4000)) {
    return { ok: false, errorCode: 'INVALID_QUESTION' };
  }
  if (body.purposeHint !== undefined && body.purposeHint !== null
      && (typeof body.purposeHint !== 'string' || !PURPOSES.includes(body.purposeHint))) {
    return { ok: false, errorCode: 'INVALID_PURPOSE_HINT' };
  }
  return { ok: true };
}

function mapOrchestrationResult(result) {
  if (result.action === 'answer') {
    return { statusCode: 200, body: { status: 'answer', intent: result.intent, purpose: result.purpose, data: result.content } };
  }
  if (result.action === 'escalation') {
    return {
      statusCode: 200,
      body: {
        status: 'escalation',
        type: result.escalationType === 'pharmacist_escalation' ? 'pharmacist' : 'medical',
        intent: result.intent, reasonCode: result.reasonCode, message: result.message,
      },
    };
  }
  if (result.action === 'needs_review') {
    return { statusCode: 200, body: { status: 'needs_review', intent: result.intent, purpose: result.purpose || null, reasonCode: result.reasonCode, message: result.message } };
  }
  return {
    statusCode: 503,
    body: { status: 'unavailable', errorCode: result.errorCode || 'PLUS_UNAVAILABLE', message: result.message || 'ระบบช่วยอธิบายยังไม่พร้อม กรุณาลองใหม่ภายหลัง' },
  };
}

function createPlusRouter(overrides = {}) {
  const router = express.Router();
  const auth = overrides.requireAuth || requireAuth;
  const flagsLoader = overrides.loadFeatureFlags || loadFeatureFlags;
  const entitlementGetter = overrides.getPlusEntitlement || getPlusEntitlement;
  const authorize = overrides.authorizeCareProfileAccess || authorizeCareProfileAccess;
  const appointmentGetter = overrides.getUpcomingAppointmentById || getUpcomingAppointmentById;
  const orchestrate = overrides.handlePlusRequest || handlePlusRequest;
  const limiter = overrides.rateLimiter || rateLimiter;
  const plusPayments = overrides.plusPaymentService || createPlusPaymentOrderService(overrides.plusPaymentDependencies);
  const limit = parseRateLimit(overrides.rateLimit ?? process.env.PLUS_RATE_LIMIT_PER_5_MINUTES);
  const windowMs = overrides.rateWindowMs || 5 * 60 * 1000;

  router.use(auth);
  router.use((req, res, next) => {
    req.plusFlags = overrides.flags || flagsLoader();
    if (!req.plusFlags.plus.enabled) return unavailable(res, 'PLUS_DISABLED');
    next();
  });
  router.use(asyncHandler(async (req, res, next) => {
    let decision;
    try { decision = await limiter.checkAndRecord(`plus:${req.user.lineUserId}`, limit, windowMs, { domain:'plus_api' }); }
    catch (_) { return unavailable(res, 'RATE_LIMIT_UNAVAILABLE'); }
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
      return res.status(429).json({ status: 'unavailable', errorCode: 'PLUS_RATE_LIMITED', message: 'เรียกใช้ Phimor Plus ถี่เกินไป กรุณารอสักครู่' });
    }
    next();
  }));

  router.get('/offer', (req, res) => {
    const liveCapabilities = Object.entries(PLUS_CAPABILITY_REGISTRY)
      .filter(([, value]) => value.status === 'LIVE')
      .map(([capability]) => capability);
    return res.json({
      status: 'available', planId: PLUS_PLAN_ID, name: 'พี่หมอ Plus',
      amountMinor: PLUS_PRICE_MINOR, currency: PLUS_CURRENCY, durationDays: PLUS_DURATION_DAYS,
      renewal: 'manual', automaticRenewal: false,
      paymentAvailable: paymentAvailable(req.plusFlags), liveCapabilities,
    });
  });

  router.get('/orders/current', asyncHandler(async (req, res) => {
    try { return res.json(await plusPayments.getCurrent({ lineUserId: req.user.lineUserId })); }
    catch (error) { return paymentError(res, error); }
  }));

  router.get('/orders/history', asyncHandler(async (req, res) => {
    const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : null;
    if (before && Number.isNaN(new Date(before).getTime())) {
      return res.status(400).json({ status: 'rejected', errorCode: 'INVALID_HISTORY_CURSOR' });
    }
    try {
      return res.json(await plusPayments.getHistory({
        lineUserId: req.user.lineUserId, limit: req.query.limit, before,
      }));
    } catch (error) { return paymentError(res, error); }
  }));

  router.get('/orders/:orderId/status', asyncHandler(async (req, res) => {
    if (!validateIdentifier(req.params.orderId)) {
      return res.status(400).json({ status: 'rejected', errorCode: 'INVALID_PLUS_ORDER_ID' });
    }
    try { return res.json(await plusPayments.getStatus({ lineUserId: req.user.lineUserId, orderId: req.params.orderId })); }
    catch (error) { return paymentError(res, error); }
  }));

  router.post('/orders', asyncHandler(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((field) => !CHECKOUT_FIELDS.has(field))
      || !PLUS_RETURN_TARGETS.includes(body.returnTarget)
      || typeof body.idempotencyKey !== 'string'
      || (body.renew !== undefined && typeof body.renew !== 'boolean')) {
      return res.status(400).json({ status: 'rejected', errorCode: 'INVALID_PLUS_CHECKOUT' });
    }
    try {
      const result = await plusPayments.createCheckout({
        lineUserId: req.user.lineUserId, returnTarget: body.returnTarget,
        idempotencyKey: body.idempotencyKey, renew: body.renew === true,
      });
      return res.status(result.resumed ? 200 : 201).json(result);
    } catch (error) { return paymentError(res, error); }
  }));

  async function loadEntitlement(req) {
    return entitlementGetter({ lineUserId: req.user.lineUserId, flags: req.plusFlags, queryFn: overrides.entitlementQueryFn });
  }

  const requireInternalEntitlement = asyncHandler(async (req, res, next) => {
    const entitlement = await loadEntitlement(req);
    if (!entitlement.allowed) {
      if (['NO_PLUS_ENTITLEMENT', 'ENTITLEMENT_INACTIVE', 'ENTITLEMENT_EXPIRED'].includes(entitlement.reasonCode)) {
        return res.status(403).json({
          status: 'upgrade_required',
          planCode: 'family_basic',
          reasonCode: entitlement.reasonCode,
          errorCode: entitlement.reasonCode,
          upgradeAvailable: paymentAvailable(req.plusFlags),
        });
      }
      return unavailable(res, entitlement.reasonCode, 403);
    }
    if (req.plusFlags.plus.internalEntitlementOnly && entitlement.source !== 'internal') {
      return unavailable(res, 'INTERNAL_ENTITLEMENT_REQUIRED', 403);
    }
    req.plusEntitlement = entitlement;
    next();
  });

  const validateProfileId = (req, res, next) => {
    if (!validateIdentifier(req.params.careProfileId)) return res.status(400).json({ status: 'invalid_request', errorCode: 'INVALID_CARE_PROFILE_ID' });
    next();
  };

  const requireProfileAccess = asyncHandler(async (req, res, next) => {
    try {
      req.plusAccess = await authorize({
        lineUserId: req.user.lineUserId, careProfileId: req.params.careProfileId,
        permission: 'view', requireActiveCenter: true,
      });
      next();
    } catch (error) {
      const status = error?.code === 'UNAUTHENTICATED' ? 401 : 403;
      return res.status(status).json({ status: 'denied', errorCode: status === 401 ? 'UNAUTHENTICATED' : 'ACCESS_DENIED', message: 'ไม่มีสิทธิ์เข้าถึง Care Profile นี้' });
    }
  });

  const requireAppointmentAccess = asyncHandler(async (req, res, next) => {
    const appointment = await appointmentGetter({
      lineUserId: req.user.lineUserId,
      careProfileId: req.params.careProfileId,
      appointmentId: req.params.appointmentId,
      requester: { lineUserId: req.user.lineUserId },
    });
    if (!appointment) return res.status(404).json({ status: 'denied', errorCode: 'APPOINTMENT_NOT_FOUND', message: 'ไม่พบนัดหมายที่ใช้งานได้ใน Care Profile นี้' });
    req.plusAppointment = appointment;
    next();
  });

  router.get('/entitlement', asyncHandler(async (req, res) => {
    const entitlement = await loadEntitlement(req);
    if (!entitlement.allowed) {
      if (['NO_PLUS_ENTITLEMENT', 'ENTITLEMENT_INACTIVE', 'ENTITLEMENT_EXPIRED'].includes(entitlement.reasonCode)) {
        return res.json({ status: entitlement.reasonCode === 'ENTITLEMENT_EXPIRED' ? 'expired' : 'basic', planCode: 'family_basic', plus: false, upgradeAvailable: paymentAvailable(req.plusFlags), reasonCode: entitlement.reasonCode });
      }
      return unavailable(res, entitlement.reasonCode, 403);
    }
    if (req.plusFlags.plus.internalEntitlementOnly && entitlement.source !== 'internal') {
      return unavailable(res, 'INTERNAL_ENTITLEMENT_REQUIRED', 403);
    }
    return res.json({
      status: 'active', planCode: entitlement.planCode, plus: true,
      source: entitlement.source, startsAt: entitlement.startsAt, expiresAt: entitlement.expiresAt,
      features: entitlement.features,
    });
  }));

  router.post('/care-profiles/:careProfileId/ask', validateProfileId, (req, res, next) => {
    const valid = validateBody(req.body, ASK_FIELDS, { questionRequired: true });
    if (!valid.ok) return res.status(400).json({ status: 'invalid_request', errorCode: valid.errorCode });
    next();
  }, requireInternalEntitlement, requireProfileAccess, asyncHandler(async (req, res) => {
    const result = await orchestrate({
      lineUserId: req.user.lineUserId, careProfileId: req.params.careProfileId,
      question: req.body.question, purposeHint: req.body.purposeHint || null,
    });
    const mapped = mapOrchestrationResult(result);
    return res.status(mapped.statusCode).json(mapped.body);
  }));

  router.post('/care-profiles/:careProfileId/appointments/:appointmentId/prepare', validateProfileId, (req, res, next) => {
    if (!validateIdentifier(req.params.appointmentId)) return res.status(400).json({ status: 'invalid_request', errorCode: 'INVALID_APPOINTMENT_ID' });
    const valid = validateBody(req.body || {}, PREPARE_FIELDS, { questionRequired: false });
    if (!valid.ok) return res.status(400).json({ status: 'invalid_request', errorCode: valid.errorCode });
    next();
  }, requireInternalEntitlement, requireProfileAccess, requireAppointmentAccess, asyncHandler(async (req, res) => {
    const result = await orchestrate({
      lineUserId: req.user.lineUserId, careProfileId: req.params.careProfileId,
      appointmentId: req.params.appointmentId,
      question: req.body.question?.trim() || 'ช่วยเตรียมคำถามก่อนไปพบแพทย์',
      purposeHint: 'doctor_visit_preparation',
    });
    const mapped = mapOrchestrationResult(result);
    return res.status(mapped.statusCode).json(mapped.body);
  }));

  return router;
}

module.exports = createPlusRouter();
module.exports.createPlusRouter = createPlusRouter;
module.exports.validateIdentifier = validateIdentifier;
module.exports.validateBody = validateBody;
module.exports.mapOrchestrationResult = mapOrchestrationResult;
module.exports.parseRateLimit = parseRateLimit;
