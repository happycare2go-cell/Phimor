const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { createDoctorQuestionService } = require('../services/doctorQuestionService');
const { DoctorQuestionError } = require('../services/doctorQuestionContextBuilder');
const { CareProfileAuthorizationError } = require('../services/careProfileAuthorizationService');
const { PlusEntitlementError } = require('../services/plusEntitlementService');
const { EMERGENCY_PATTERNS } = require('../services/consultationSafetyService');
const rateLimiter = require('../utils/rateLimiter');

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BODY_FIELDS = new Set(['appointmentId', 'focus']);
const QUERY_FIELDS = new Set(['centerId']);

function parseRateLimit(value, fallback = 10) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : fallback;
}

function isEmergencyFocus(value) {
  return typeof value === 'string' && EMERGENCY_PATTERNS.some((pattern) => pattern.test(value.normalize('NFC').trim()));
}

function errorResponse(res, error) {
  const expected = error instanceof DoctorQuestionError
    || error instanceof CareProfileAuthorizationError
    || error instanceof PlusEntitlementError;
  const status = expected && Number.isInteger(error.status) ? error.status : 503;
  const errorCode = expected && /^[A-Z][A-Z0-9_]+$/.test(error.code || '')
    ? error.code : 'DOCTOR_QUESTIONS_UNAVAILABLE';
  return res.status(status).json({
    status: 'unavailable', errorCode,
    message: status === 403
      ? 'บัญชีนี้ยังไม่มีสิทธิ์ใช้การช่วยเตรียมคำถาม'
      : 'ระบบช่วยเตรียมคำถามยังไม่พร้อม กรุณาลองใหม่ภายหลัง',
  });
}

function createDoctorQuestionsRouter(overrides = {}) {
  const router = express.Router();
  const auth = overrides.requireAuth || requireAuth;
  const generate = overrides.doctorQuestionService || createDoctorQuestionService(overrides.serviceDependencies);
  const limiter = overrides.rateLimiter || rateLimiter;
  const limit = parseRateLimit(overrides.rateLimit ?? process.env.PLUS_RATE_LIMIT_PER_5_MINUTES);
  const windowMs = overrides.rateWindowMs || 5 * 60 * 1000;

  router.use(auth);
  router.post('/:careProfileId/doctor-questions', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.careProfileId)
      || Object.keys(req.query).some((field) => !QUERY_FIELDS.has(field))) {
      return res.status(400).json({ status: 'unavailable', errorCode: 'INVALID_INPUT' });
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((field) => !BODY_FIELDS.has(field))
      || (body.appointmentId !== undefined && body.appointmentId !== null
        && (typeof body.appointmentId !== 'string' || !IDENTIFIER_PATTERN.test(body.appointmentId)))
      || (body.focus !== undefined && typeof body.focus !== 'string')) {
      return res.status(400).json({ status: 'unavailable', errorCode: 'INVALID_INPUT' });
    }
    if (!isEmergencyFocus(body.focus)) {
      let decision;
      try {
        decision = await limiter.checkAndRecord(
          `doctor-questions:${req.user.lineUserId}`, limit, windowMs, { domain:'doctor_questions' }
        );
      } catch (_) { return errorResponse(res, new Error('rate limit unavailable')); }
      res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
      if (!decision.allowed) {
        res.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
        return res.status(429).json({
          status: 'unavailable', errorCode: 'PLUS_RATE_LIMITED',
          message: 'เรียกใช้ระบบช่วยเตรียมคำถามถี่เกินไป กรุณารอสักครู่',
        });
      }
    }
    try {
      const result = await generate({
        careProfileId: req.params.careProfileId,
        lineUserId: req.user.lineUserId,
        centerId: req.query.centerId || null,
        appointmentId: body.appointmentId || null,
        focus: body.focus || '',
      });
      return res.status(result.status === 'unavailable' ? 503 : 200).json(result);
    } catch (error) {
      return errorResponse(res, error);
    }
  }));
  return router;
}

module.exports = createDoctorQuestionsRouter();
module.exports.createDoctorQuestionsRouter = createDoctorQuestionsRouter;
module.exports.parseRateLimit = parseRateLimit;
module.exports.isEmergencyFocus = isEmergencyFocus;
module.exports.errorResponse = errorResponse;
