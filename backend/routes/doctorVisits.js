const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { createDoctorVisitService } = require('../services/doctorVisitService');
const { createDoctorVisitOrganizationService } = require('../services/doctorVisitOrganizationService');
const { DoctorVisitDomainError, IDENTIFIER_PATTERN } = require('../domain/doctorVisit');
const { CareProfileAuthorizationError } = require('../services/careProfileAuthorizationService');
const { PlusEntitlementError } = require('../services/plusEntitlementService');
const rateLimiter = require('../utils/rateLimiter');

const QUERY_FIELDS = new Set(['centerId']);
const LIST_QUERY_FIELDS = new Set(['centerId', 'includeDrafts', 'includeHistory', 'limit', 'cursor']);

function parseBoolean(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new DoctorVisitDomainError('INVALID_INPUT');
}

function parseRateLimit(value, fallback = 10) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : fallback;
}

function onlyFields(value, allowlist) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((field) => allowlist.has(field));
}

function doctorVisitError(res, error) {
  const expected = error instanceof DoctorVisitDomainError
    || error instanceof CareProfileAuthorizationError
    || error instanceof PlusEntitlementError;
  const status = expected && Number.isInteger(error.status) ? error.status : 503;
  const errorCode = expected && /^[A-Z][A-Z0-9_]+$/.test(error.code || '')
    ? error.code : 'DOCTOR_VISIT_UNAVAILABLE';
  return res.status(status).json({
    status: 'unavailable', errorCode,
    message: expected ? error.message : 'ระบบบันทึกจากการพบแพทย์ยังไม่พร้อม กรุณาลองใหม่ภายหลัง',
  });
}

function createDoctorVisitsRouter(overrides = {}) {
  const router = express.Router();
  const auth = overrides.requireAuth || requireAuth;
  const service = overrides.doctorVisitService || createDoctorVisitService(overrides.serviceDependencies);
  const organize = overrides.organizationService || createDoctorVisitOrganizationService({
    ...(overrides.organizationDependencies || {}), doctorVisitService: service,
  });
  const limiter = overrides.rateLimiter || rateLimiter;
  const limit = parseRateLimit(overrides.rateLimit ?? process.env.PLUS_RATE_LIMIT_PER_5_MINUTES);
  const windowMs = overrides.rateWindowMs || 5 * 60 * 1000;

  router.use(auth);
  router.use('/:careProfileId/doctor-visits', (req, res, next) => {
    if (!IDENTIFIER_PATTERN.test(req.params.careProfileId)) {
      return res.status(400).json({ status: 'unavailable', errorCode: 'INVALID_IDENTIFIER' });
    }
    return next();
  });

  router.get('/:careProfileId/doctor-visits', asyncHandler(async (req, res) => {
    if (!onlyFields(req.query, LIST_QUERY_FIELDS)) {
      return res.status(400).json({ status: 'unavailable', errorCode: 'INVALID_INPUT' });
    }
    try {
      return res.json(await service.listRecords({
        careProfileId: req.params.careProfileId, lineUserId: req.user.lineUserId,
        centerId: req.query.centerId || null,
        includeDrafts: parseBoolean(req.query.includeDrafts),
        includeHistory: parseBoolean(req.query.includeHistory),
        limit: req.query.limit || 20, cursor: req.query.cursor || null,
      }));
    } catch (error) { return doctorVisitError(res, error); }
  }));

  router.post('/:careProfileId/doctor-visits/drafts', asyncHandler(async (req, res) => {
    if (!onlyFields(req.query, QUERY_FIELDS)) {
      return res.status(400).json({ status: 'unavailable', errorCode: 'INVALID_INPUT' });
    }
    try {
      const record = await service.createDraft({
        careProfileId: req.params.careProfileId, lineUserId: req.user.lineUserId,
        centerId: req.query.centerId || null, input: req.body || {},
      });
      return res.status(201).json(record);
    } catch (error) { return doctorVisitError(res, error); }
  }));

  router.get('/:careProfileId/doctor-visits/:visitRecordId', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.visitRecordId) || !onlyFields(req.query, QUERY_FIELDS)) {
      return res.status(400).json({ status: 'unavailable', errorCode: 'INVALID_INPUT' });
    }
    try {
      return res.json(await service.getRecord({
        careProfileId: req.params.careProfileId, visitRecordId: req.params.visitRecordId,
        lineUserId: req.user.lineUserId, centerId: req.query.centerId || null,
      }));
    } catch (error) { return doctorVisitError(res, error); }
  }));

  router.patch('/:careProfileId/doctor-visits/:visitRecordId/draft', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.visitRecordId) || !onlyFields(req.query, QUERY_FIELDS)) {
      return res.status(400).json({ status: 'unavailable', errorCode: 'INVALID_INPUT' });
    }
    try {
      return res.json(await service.updateDraft({
        careProfileId: req.params.careProfileId, visitRecordId: req.params.visitRecordId,
        lineUserId: req.user.lineUserId, centerId: req.query.centerId || null,
        patch: req.body || {},
      }));
    } catch (error) { return doctorVisitError(res, error); }
  }));

  router.post('/:careProfileId/doctor-visits/:visitRecordId/organize', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.visitRecordId) || !onlyFields(req.query, QUERY_FIELDS)
      || !onlyFields(req.body || {}, new Set())) {
      return res.status(400).json({ status: 'unavailable', errorCode: 'INVALID_INPUT' });
    }
    let decision;
    try {
      decision = await limiter.checkAndRecord(
        `doctor-visit-ai:${req.user.lineUserId}`, limit, windowMs, { domain:'doctor_visit_ai' }
      );
    } catch (_) { return doctorVisitError(res, new Error('rate limit unavailable')); }
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
      return res.status(429).json({
        status: 'unavailable', errorCode: 'PLUS_RATE_LIMITED',
        message: 'เรียกใช้ระบบช่วยจัดระเบียบบันทึกถี่เกินไป กรุณารอสักครู่',
      });
    }
    try {
      const result = await organize({
        careProfileId: req.params.careProfileId, visitRecordId: req.params.visitRecordId,
        lineUserId: req.user.lineUserId, centerId: req.query.centerId || null,
      });
      return res.status(result.status === 'unavailable' ? 503 : 200).json(result);
    } catch (error) { return doctorVisitError(res, error); }
  }));

  router.post('/:careProfileId/doctor-visits/:visitRecordId/confirm', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.visitRecordId) || !onlyFields(req.query, QUERY_FIELDS)
      || !onlyFields(req.body || {}, new Set())) {
      return res.status(400).json({ status: 'unavailable', errorCode: 'INVALID_INPUT' });
    }
    try {
      return res.json(await service.confirmDraft({
        careProfileId: req.params.careProfileId, visitRecordId: req.params.visitRecordId,
        lineUserId: req.user.lineUserId, centerId: req.query.centerId || null,
      }));
    } catch (error) { return doctorVisitError(res, error); }
  }));

  router.post('/:careProfileId/doctor-visits/:visitRecordId/corrections', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.visitRecordId) || !onlyFields(req.query, QUERY_FIELDS)
      || !onlyFields(req.body || {}, new Set(['reason']))) {
      return res.status(400).json({ status: 'unavailable', errorCode: 'INVALID_INPUT' });
    }
    try {
      return res.status(201).json(await service.createCorrectionDraft({
        careProfileId: req.params.careProfileId, visitRecordId: req.params.visitRecordId,
        lineUserId: req.user.lineUserId, centerId: req.query.centerId || null,
        reason: req.body.reason,
      }));
    } catch (error) { return doctorVisitError(res, error); }
  }));

  router.post('/:careProfileId/doctor-visits/:visitRecordId/void', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.visitRecordId) || !onlyFields(req.query, QUERY_FIELDS)
      || !onlyFields(req.body || {}, new Set(['reason']))) {
      return res.status(400).json({ status: 'unavailable', errorCode: 'INVALID_INPUT' });
    }
    try {
      return res.json(await service.voidRecord({
        careProfileId: req.params.careProfileId, visitRecordId: req.params.visitRecordId,
        lineUserId: req.user.lineUserId, centerId: req.query.centerId || null,
        reason: req.body.reason,
      }));
    } catch (error) { return doctorVisitError(res, error); }
  }));

  return router;
}

module.exports = createDoctorVisitsRouter();
module.exports.createDoctorVisitsRouter = createDoctorVisitsRouter;
module.exports.doctorVisitError = doctorVisitError;
module.exports.parseRateLimit = parseRateLimit;
