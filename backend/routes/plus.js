const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { loadFeatureFlags } = require('../config/featureFlags');
const { getPlusEntitlement } = require('../services/plusEntitlementService');
const { authorizeCareProfileAccess } = require('../services/careProfileAuthorizationService');
const { handlePlusRequest, PURPOSES } = require('../services/plusOrchestrationService');
const { getUpcomingAppointmentById } = require('../services/appointmentSummaryService');
const rateLimiter = require('../utils/rateLimiter');

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ASK_FIELDS = new Set(['question', 'purposeHint']);
const PREPARE_FIELDS = new Set(['question']);

function parseRateLimit(value, fallback = 10) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : fallback;
}

function unavailable(res, errorCode, status = 503) {
  return res.status(status).json({ status: 'unavailable', errorCode, message: 'Phimor Plus ยังไม่พร้อมใช้งานสำหรับบัญชีนี้' });
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

  async function loadEntitlement(req) {
    return entitlementGetter({ lineUserId: req.user.lineUserId, flags: req.plusFlags, queryFn: overrides.entitlementQueryFn });
  }

  const requireInternalEntitlement = asyncHandler(async (req, res, next) => {
    const entitlement = await loadEntitlement(req);
    if (!entitlement.allowed) {
      if (['NO_PLUS_ENTITLEMENT', 'ENTITLEMENT_INACTIVE'].includes(entitlement.reasonCode)) {
        return res.status(403).json({ status: 'upgrade_required', planCode: 'family_basic', reasonCode: entitlement.reasonCode, upgradeAvailable: false });
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
      if (['NO_PLUS_ENTITLEMENT', 'ENTITLEMENT_INACTIVE'].includes(entitlement.reasonCode)) {
        return res.json({ status: 'basic', planCode: 'family_basic', plus: false, upgradeAvailable: false, reasonCode: entitlement.reasonCode });
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
