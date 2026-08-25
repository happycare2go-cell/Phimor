const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { loadConsultationConfig, isInternalConsultationUser } = require('../config/consultationConfig');
const { createConsultationEligibilityService } = require('../services/consultationEligibilityService');
const { createConsultationReadService } = require('../services/consultationReadService');
const { createConsultationMessageService } = require('../services/consultationMessageService');

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function consultationError(res, error) {
  const code = error?.code || 'CONSULTATION_UNAVAILABLE';
  const status = Number.isInteger(error?.status) ? error.status : 400;
  return res.status(status >= 500 ? 503 : status).json({
    status:status === 401 ? 'unauthenticated' : status === 403 ? 'denied' : 'unavailable',
    errorCode:code,
    message:status >= 500 ? 'ระบบคำปรึกษายังไม่พร้อม กรุณาลองใหม่ภายหลัง' : 'ไม่สามารถดำเนินการคำขอนี้ได้',
  });
}

function createConsultationsRouter(overrides = {}) {
  const router = express.Router();
  const auth = overrides.requireAuth || requireAuth;
  const configLoader = overrides.loadConsultationConfig || loadConsultationConfig;
  const eligibility = overrides.eligibilityService || createConsultationEligibilityService(overrides.eligibilityDependencies);
  const reads = overrides.readService || createConsultationReadService(overrides.readDependencies);
  const messages = overrides.messageService || createConsultationMessageService(overrides.messageDependencies);

  router.use(auth);
  router.use((req, res, next) => {
    req.consultationConfig = overrides.config || configLoader();
    next();
  });

  router.get('/eligibility', asyncHandler(async (req, res) => {
    const result = await eligibility.checkEligibility({
      lineUserId:req.user.lineUserId,
      careProfileId:req.query.careProfileId,
      config:req.consultationConfig,
    });
    const status = result.availability === 'eligible' ? 200
      : result.reasonCode === 'CONSULTATION_DISABLED' ? 503 : 403;
    return res.status(status).json(result);
  }));

  router.use((req, res, next) => {
    if (!req.consultationConfig.enabled) {
      return res.status(503).json({ status:'unavailable', errorCode:'CONSULTATION_DISABLED' });
    }
    if (!isInternalConsultationUser(req.user.lineUserId, req.consultationConfig)) {
      return res.status(403).json({ status:'unavailable', errorCode:'INTERNAL_ACCESS_REQUIRED' });
    }
    next();
  });

  router.get('/', asyncHandler(async (req, res) => {
    try { return res.json(await reads.listFamilyCases({ lineUserId:req.user.lineUserId })); }
    catch (error) { return consultationError(res, error); }
  }));

  router.get('/:caseId', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.caseId)) return res.status(400).json({ status:'invalid_request', errorCode:'INVALID_CASE_ID' });
    try { return res.json(await reads.getFamilyCase({ caseId:req.params.caseId, lineUserId:req.user.lineUserId })); }
    catch (error) { return consultationError(res, error); }
  }));

  router.get('/:caseId/messages', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.caseId)) return res.status(400).json({ status:'invalid_request', errorCode:'INVALID_CASE_ID' });
    try {
      return res.json(await reads.listCaseMessages({
        caseId:req.params.caseId, lineUserId:req.user.lineUserId,
        afterSequence:req.query.afterSequence, limit:req.query.limit,
      }));
    } catch (error) { return consultationError(res, error); }
  }));

  router.post('/:caseId/messages', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.caseId)) return res.status(400).json({ status:'invalid_request', errorCode:'INVALID_CASE_ID' });
    const keys = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
    if (keys.some((key) => !['body', 'idempotencyKey'].includes(key))) {
      return res.status(400).json({ status:'invalid_request', errorCode:'UNSUPPORTED_FIELD' });
    }
    try {
      const result = await messages.sendMessage({
        caseId:req.params.caseId,
        actor:{ type:'customer', lineUserId:req.user.lineUserId },
        body:req.body?.body, idempotencyKey:req.body?.idempotencyKey,
      });
      return res.status(result.duplicate ? 200 : 201).json({
        duplicate:result.duplicate,
        message:{
          messageId:result.message.message_id,
          sequence:Number(result.message.message_sequence),
          senderType:result.message.sender_type,
          body:result.message.body,
          createdAt:result.message.created_at,
        },
      });
    } catch (error) { return consultationError(res, error); }
  }));

  return router;
}

module.exports = createConsultationsRouter();
module.exports.createConsultationsRouter = createConsultationsRouter;
module.exports.consultationError = consultationError;
