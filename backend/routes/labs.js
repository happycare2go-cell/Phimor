const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { createLabResultService } = require('../services/labResultService');
const { createLabTrendService } = require('../services/labTrendService');
const { createLabExplanationService } = require('../services/labExplanationService');
const { LabDomainError, IDENTIFIER_PATTERN } = require('../domain/lab');
const { CareProfileAuthorizationError } = require('../services/careProfileAuthorizationService');
const { PlusEntitlementError } = require('../services/plusEntitlementService');
const rateLimiter = require('../utils/rateLimiter');

function labError(res, error) {
  const expected = error instanceof LabDomainError || error instanceof CareProfileAuthorizationError
    || error instanceof PlusEntitlementError;
  const status = expected && Number.isInteger(error.status) ? error.status : 503;
  const code = expected && /^[A-Z][A-Z0-9_]+$/.test(error.code || '')
    ? error.code : 'LAB_UNAVAILABLE';
  return res.status(status).json({
    status: status === 401 ? 'unauthenticated' : status === 403 ? 'denied'
      : status === 404 ? 'not_found' : status === 409 ? 'conflict'
        : status >= 500 ? 'unavailable' : 'invalid_request',
    errorCode: code,
    message: status >= 500 ? 'ระบบผลตรวจยังไม่พร้อม กรุณาลองใหม่ภายหลัง' : error.message,
  });
}

function validIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  const error = new LabDomainError('INVALID_INPUT');
  throw error;
}

function parseTrendIdentity(input = {}) {
  const supplied = ['loincCode', 'comparisonKey'].filter((field) => input[field] !== undefined);
  if (supplied.length !== 1) throw new LabDomainError('INVALID_INPUT');
  return { [supplied[0]]: input[supplied[0]] };
}

function parseRateLimit(value, fallback = 10) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : fallback;
}

function createLabsRouter(overrides = {}) {
  const router = express.Router();
  const auth = overrides.requireAuth || requireAuth;
  const labs = overrides.labService || createLabResultService(overrides.labDependencies);
  const trends = overrides.labTrendService || createLabTrendService(overrides.trendDependencies);
  const explain = overrides.labExplanationService || createLabExplanationService(overrides.explanationDependencies);
  const limiter = overrides.rateLimiter || rateLimiter;
  const explanationLimit = parseRateLimit(
    overrides.explanationRateLimit ?? process.env.PLUS_RATE_LIMIT_PER_5_MINUTES
  );
  const explanationWindowMs = overrides.explanationRateWindowMs || 5 * 60 * 1000;

  router.use(auth);
  router.use('/:careProfileId/lab-reports', (req, res, next) => {
    if (!validIdentifier(req.params.careProfileId)) {
      return res.status(400).json({ status: 'invalid_request', errorCode: 'INVALID_IDENTIFIER' });
    }
    next();
  });

  router.get('/:careProfileId/lab-reports', asyncHandler(async (req, res) => {
    try {
      return res.json(await labs.listReports({
        careProfileId: req.params.careProfileId,
        lineUserId: req.user.lineUserId,
        centerId: req.query.centerId || null,
        includeDrafts: parseBoolean(req.query.includeDrafts),
        includeHistory: parseBoolean(req.query.includeHistory),
        limit: req.query.limit || 20,
        cursor: req.query.cursor || null,
      }));
    } catch (error) { return labError(res, error); }
  }));

  router.get('/:careProfileId/lab-trends', asyncHandler(async (req, res) => {
    if (!validIdentifier(req.params.careProfileId)) {
      return res.status(400).json({ status: 'invalid_request', errorCode: 'INVALID_IDENTIFIER' });
    }
    const allowedQuery = new Set(['loincCode', 'comparisonKey', 'limit', 'cursor', 'centerId']);
    if (Object.keys(req.query).some((field) => !allowedQuery.has(field))) {
      return res.status(400).json({ status: 'invalid_request', errorCode: 'UNSUPPORTED_FIELD' });
    }
    try {
      return res.json(await trends({
        careProfileId: req.params.careProfileId, lineUserId: req.user.lineUserId,
        centerId: req.query.centerId || null, identity: parseTrendIdentity(req.query),
        limit: req.query.limit || 20, cursor: req.query.cursor || null,
      }));
    } catch (error) { return labError(res, error); }
  }));

  router.post('/:careProfileId/lab-explanations', asyncHandler(async (req, res) => {
    if (!validIdentifier(req.params.careProfileId)) {
      return res.status(400).json({ status: 'invalid_request', errorCode: 'INVALID_IDENTIFIER' });
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((field) => !['identity', 'question'].includes(field))) {
      return res.status(400).json({ status: 'invalid_request', errorCode: 'UNSUPPORTED_FIELD' });
    }
    let identity;
    try { identity = parseTrendIdentity(body.identity); } catch (error) { return labError(res, error); }
    const decision = limiter.checkAndRecord(
      `lab-explanation:${req.user.lineUserId}`, explanationLimit, explanationWindowMs
    );
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
      return res.status(429).json({
        status: 'unavailable', errorCode: 'PLUS_RATE_LIMITED',
        message: 'เรียกใช้ระบบช่วยอธิบายถี่เกินไป กรุณารอสักครู่',
      });
    }
    try {
      const result = await explain({
        careProfileId: req.params.careProfileId, lineUserId: req.user.lineUserId,
        centerId: req.query.centerId || null, identity, question: body.question || '',
      });
      return res.status(result.status === 'unavailable' ? 503 : 200).json(result);
    } catch (error) { return labError(res, error); }
  }));

  router.post('/:careProfileId/lab-reports/drafts', asyncHandler(async (req, res) => {
    try {
      const report = await labs.createDraft({
        careProfileId: req.params.careProfileId,
        lineUserId: req.user.lineUserId,
        centerId: req.query.centerId || null,
        input: req.body,
      });
      return res.status(201).json(report);
    } catch (error) { return labError(res, error); }
  }));

  router.get('/:careProfileId/lab-reports/:reportId', asyncHandler(async (req, res) => {
    if (!validIdentifier(req.params.reportId)) {
      return res.status(400).json({ status: 'invalid_request', errorCode: 'INVALID_IDENTIFIER' });
    }
    try {
      return res.json(await labs.getReport({
        careProfileId: req.params.careProfileId, reportId: req.params.reportId,
        lineUserId: req.user.lineUserId, centerId: req.query.centerId || null,
      }));
    } catch (error) { return labError(res, error); }
  }));

  router.patch('/:careProfileId/lab-reports/:reportId/draft', asyncHandler(async (req, res) => {
    if (!validIdentifier(req.params.reportId)) {
      return res.status(400).json({ status: 'invalid_request', errorCode: 'INVALID_IDENTIFIER' });
    }
    try {
      return res.json(await labs.updateDraft({
        careProfileId: req.params.careProfileId, reportId: req.params.reportId,
        lineUserId: req.user.lineUserId, centerId: req.query.centerId || null,
        patch: req.body,
      }));
    } catch (error) { return labError(res, error); }
  }));

  router.post('/:careProfileId/lab-reports/:reportId/confirm', asyncHandler(async (req, res) => {
    if (!validIdentifier(req.params.reportId)) {
      return res.status(400).json({ status: 'invalid_request', errorCode: 'INVALID_IDENTIFIER' });
    }
    if (req.body && Object.keys(req.body).length > 0) {
      return res.status(400).json({ status: 'invalid_request', errorCode: 'UNSUPPORTED_FIELD' });
    }
    try {
      return res.json(await labs.confirmDraft({
        careProfileId: req.params.careProfileId, reportId: req.params.reportId,
        lineUserId: req.user.lineUserId, centerId: req.query.centerId || null,
      }));
    } catch (error) { return labError(res, error); }
  }));

  router.post('/:careProfileId/lab-reports/:reportId/corrections', asyncHandler(async (req, res) => {
    if (!validIdentifier(req.params.reportId)) {
      return res.status(400).json({ status: 'invalid_request', errorCode: 'INVALID_IDENTIFIER' });
    }
    if (!req.body || Object.keys(req.body).some((key) => key !== 'reason')) {
      return res.status(400).json({ status: 'invalid_request', errorCode: 'UNSUPPORTED_FIELD' });
    }
    try {
      return res.status(201).json(await labs.createCorrectionDraft({
        careProfileId: req.params.careProfileId, reportId: req.params.reportId,
        lineUserId: req.user.lineUserId, centerId: req.query.centerId || null,
        reason: req.body.reason,
      }));
    } catch (error) { return labError(res, error); }
  }));

  router.post('/:careProfileId/lab-reports/:reportId/void', asyncHandler(async (req, res) => {
    if (!validIdentifier(req.params.reportId)) {
      return res.status(400).json({ status: 'invalid_request', errorCode: 'INVALID_IDENTIFIER' });
    }
    if (!req.body || Object.keys(req.body).some((key) => key !== 'reason')) {
      return res.status(400).json({ status: 'invalid_request', errorCode: 'UNSUPPORTED_FIELD' });
    }
    try {
      return res.json(await labs.voidReport({
        careProfileId: req.params.careProfileId, reportId: req.params.reportId,
        lineUserId: req.user.lineUserId, centerId: req.query.centerId || null,
        reason: req.body.reason,
      }));
    } catch (error) { return labError(res, error); }
  }));

  return router;
}

module.exports = createLabsRouter();
module.exports.createLabsRouter = createLabsRouter;
module.exports.labError = labError;
module.exports.parseTrendIdentity = parseTrendIdentity;
module.exports.parseRateLimit = parseRateLimit;
