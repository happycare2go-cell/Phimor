const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { createRequirePharmacist } = require('../middleware/pharmacistAuth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { loadConsultationConfig } = require('../config/consultationConfig');
const { createConsultationReadService } = require('../services/consultationReadService');
const { createConsultationCaseService } = require('../services/consultationCaseService');
const { createConsultationMessageService } = require('../services/consultationMessageService');
const { createConsultationRateLimitService } = require('../services/consultationRateLimitService');
const { consultationError } = require('./consultations');
const { createPharmacistAssistantService } = require('../services/pharmacistAssistantService');

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function createPharmacistConsultationsRouter(overrides = {}) {
  const router = express.Router();
  const auth = overrides.requireAuth || requireAuth;
  const requirePharmacist = overrides.requirePharmacist || createRequirePharmacist(overrides.pharmacistAuthDependencies);
  const configLoader = overrides.loadConsultationConfig || loadConsultationConfig;
  const reads = overrides.readService || createConsultationReadService(overrides.readDependencies);
  const cases = overrides.caseService || createConsultationCaseService(overrides.caseDependencies);
  const messages = overrides.messageService || createConsultationMessageService(overrides.messageDependencies);
  const rates = overrides.rateLimitService || createConsultationRateLimitService(overrides.rateLimitDependencies);
  const assistant = overrides.assistantService || createPharmacistAssistantService(overrides.assistantDependencies);

  router.use(auth);
  router.use((req, res, next) => {
    req.consultationConfig = overrides.config || configLoader();
    if (!req.consultationConfig.enabled) {
      return res.status(503).json({ status:'unavailable', errorCode:'CONSULTATION_DISABLED' });
    }
    next();
  });
  router.use(requirePharmacist);

  router.get('/queue', asyncHandler(async (req, res) => {
    try { return res.json(await reads.listQueue({
      pharmacistLineUserId:req.user.lineUserId,cursor:req.query.cursor,limit:req.query.limit,
      minQueuedMinutes:req.query.minQueuedMinutes,topicCategory:req.query.topicCategory,
      triageCategory:req.query.triageCategory,
    })); }
    catch (error) { return consultationError(res, error); }
  }));

  router.get('/active', asyncHandler(async (req, res) => {
    try { return res.json(await reads.listPharmacistCases({ pharmacistLineUserId:req.user.lineUserId,collection:'active' })); }
    catch (error) { return consultationError(res, error); }
  }));

  router.get('/resolved', asyncHandler(async (req,res)=>{
    try { return res.json(await reads.listPharmacistCases({pharmacistLineUserId:req.user.lineUserId,collection:'resolved'})); }
    catch (error) { return consultationError(res,error); }
  }));

  router.get('/closed', asyncHandler(async (req,res)=>{
    try { return res.json(await reads.listPharmacistCases({pharmacistLineUserId:req.user.lineUserId,collection:'closed'})); }
    catch (error) { return consultationError(res,error); }
  }));

  router.get('/:caseId', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.caseId)) return res.status(400).json({ status:'invalid_request', errorCode:'INVALID_CASE_ID' });
    try { return res.json(await reads.getPharmacistCase({ caseId:req.params.caseId, pharmacistLineUserId:req.user.lineUserId })); }
    catch (error) { return consultationError(res, error); }
  }));

  router.get('/:caseId/messages', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.caseId)) return res.status(400).json({ status:'invalid_request', errorCode:'INVALID_CASE_ID' });
    try {
      return res.json(await reads.listCaseMessages({
        caseId:req.params.caseId, pharmacistLineUserId:req.user.lineUserId,
        afterSequence:req.query.afterSequence, limit:req.query.limit,
      }));
    } catch (error) { return consultationError(res, error); }
  }));

  router.post('/:caseId/accept', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.caseId)) return res.status(400).json({ status:'invalid_request', errorCode:'INVALID_CASE_ID' });
    try {
      rates.requirePharmacistAccept(req.pharmacist.pharmacistId,req.consultationConfig);
      await cases.acceptCase({ caseId:req.params.caseId, pharmacistLineUserId:req.user.lineUserId });
      return res.json(await reads.getPharmacistCase({ caseId:req.params.caseId, pharmacistLineUserId:req.user.lineUserId }));
    } catch (error) { return consultationError(res, error); }
  }));

  router.post('/:caseId/resolve',asyncHandler(async(req,res)=>{
    if (!IDENTIFIER_PATTERN.test(req.params.caseId)) return res.status(400).json({status:'invalid_request',errorCode:'INVALID_CASE_ID'});
    try {
      await cases.resolveCase({caseId:req.params.caseId,pharmacistLineUserId:req.user.lineUserId});
      return res.json(await reads.getPharmacistCase({caseId:req.params.caseId,pharmacistLineUserId:req.user.lineUserId}));
    } catch (error) { return consultationError(res,error); }
  }));

  router.post('/:caseId/assistant',asyncHandler(async(req,res)=>{
    if (!IDENTIFIER_PATTERN.test(req.params.caseId)) return res.status(400).json({status:'invalid_request',errorCode:'INVALID_CASE_ID'});
    const keys=req.body&&typeof req.body==='object'?Object.keys(req.body):[];
    if (keys.some((key)=>key!=='refresh') || (req.body?.refresh!==undefined && req.body.refresh!==true)) {
      return res.status(400).json({status:'invalid_request',errorCode:'UNSUPPORTED_FIELD'});
    }
    try {
      rates.requireAssistant({caseId:req.params.caseId,pharmacistId:req.pharmacist.pharmacistId},req.consultationConfig);
      return res.json(await assistant({caseId:req.params.caseId,pharmacistLineUserId:req.user.lineUserId}));
    } catch(error) { return consultationError(res,error); }
  }));

  router.post('/:caseId/messages', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.caseId)) return res.status(400).json({ status:'invalid_request', errorCode:'INVALID_CASE_ID' });
    const keys = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
    if (keys.some((key) => !['body', 'idempotencyKey'].includes(key))) {
      return res.status(400).json({ status:'invalid_request', errorCode:'UNSUPPORTED_FIELD' });
    }
    try {
      rates.requireMessage({caseId:req.params.caseId,actorType:'pharmacist',actorId:req.pharmacist.pharmacistId},req.consultationConfig);
      const result = await messages.sendMessage({
        caseId:req.params.caseId,
        actor:{ type:'pharmacist', lineUserId:req.user.lineUserId },
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

module.exports = createPharmacistConsultationsRouter();
module.exports.createPharmacistConsultationsRouter = createPharmacistConsultationsRouter;
