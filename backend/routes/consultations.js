const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { loadConsultationConfig, isInternalConsultationUser } = require('../config/consultationConfig');
const { createConsultationEligibilityService } = require('../services/consultationEligibilityService');
const { createConsultationReadService } = require('../services/consultationReadService');
const { createConsultationMessageService } = require('../services/consultationMessageService');
const { createConsultationRateLimitService } = require('../services/consultationRateLimitService');
const { classifyConsultationSafety } = require('../services/consultationSafetyService');
const { createConsultationCheckoutService } = require('../services/consultationCheckoutService');
const { createConsultationPaymentStatusService } = require('../services/consultationPaymentStatusService');
const { createConsultationPaymentProvider } = require('../providers/consultationPaymentProviderFactory');
const { recordConsultationWriteFailure } = require('../services/consultationOperationalDiagnostics');
const { createConsultationRealtimeAccessService } = require('../services/consultationRealtimeAccessService');
const { createConsultationReadReceiptService } = require('../services/consultationReadReceiptService');

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_CONSULTATION_ERROR_CODE = /^(?:CONSULTATION|CASE|MESSAGE|QUESTION|PHARMACIST|CARE_PROFILE|PAYMENT|ORDER|TERMS|INTERNAL|UNAUTHENTICATED|INVALID|IDEMPOTENCY|RATE_LIMIT|EMERGENCY|RECONCILIATION|REALTIME|READ|TRUSTED|UNSUPPORTED|ACCESS|MEMBERSHIP|CENTER)_[A-Z0-9_]+$/;

function consultationError(res, error, diagnostics = {}) {
  const rawCode = error?.code || 'CONSULTATION_UNAVAILABLE';
  const code = rawCode.startsWith('OMISE_') ? 'PAYMENT_PROVIDER_UNAVAILABLE'
    : SAFE_CONSULTATION_ERROR_CODE.test(rawCode) ? rawCode : 'CONSULTATION_UNAVAILABLE';
  const status = code==='CONSULTATION_UNAVAILABLE' ? 503
    : Number.isInteger(error?.status) ? error.status : 400;
  if (status===429 && Number.isFinite(error?.retryAfterMs)) {
    res.setHeader('Retry-After',Math.max(1,Math.ceil(error.retryAfterMs/1000)));
  }
  const responseStatus=status===401 ? 'unauthenticated' : status===403 ? 'denied'
    : status===429 ? 'rate_limited'
      : ['CONSULTATION_EXPIRED','CONSULTATION_CLOSED'].includes(code) ? 'closed' : 'unavailable';
  const correlationId = status >= 500 && diagnostics.action
    ? recordConsultationWriteFailure(error, diagnostics) : null;
  return res.status(status >= 500 ? 503 : status).json({
    status:responseStatus,
    errorCode:code,
    message:status >= 500 ? 'ระบบคำปรึกษายังไม่พร้อม กรุณาลองใหม่ภายหลัง' : 'ไม่สามารถดำเนินการคำขอนี้ได้',
    ...(correlationId ? { correlationId } : {}),
  });
}

function createConsultationsRouter(overrides = {}) {
  const router = express.Router();
  const auth = overrides.requireAuth || requireAuth;
  const configLoader = overrides.loadConsultationConfig || loadConsultationConfig;
  const eligibility = overrides.eligibilityService || createConsultationEligibilityService(overrides.eligibilityDependencies);
  const reads = overrides.readService || createConsultationReadService(overrides.readDependencies);
  const messages = overrides.messageService || createConsultationMessageService(overrides.messageDependencies);
  const rates = overrides.rateLimitService || createConsultationRateLimitService(overrides.rateLimitDependencies);
  const checkout = overrides.checkoutService || createConsultationCheckoutService(overrides.checkoutDependencies);
  const paymentStatus = overrides.paymentStatusService || createConsultationPaymentStatusService(overrides.paymentStatusDependencies);
  const realtimeAccess = overrides.realtimeAccessService
    || createConsultationRealtimeAccessService(overrides.realtimeAccessDependencies);
  const readReceipts = overrides.readReceiptService
    || createConsultationReadReceiptService(overrides.readReceiptDependencies);
  const writeDiagnostics = (action) => ({
    action, logger:overrides.operationalLogger,
    correlationIdFactory:overrides.correlationIdFactory,
  });

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
    if (req.query.careProfileId && !IDENTIFIER_PATTERN.test(req.query.careProfileId)) {
      return res.status(400).json({ status:'invalid_request', errorCode:'INVALID_CARE_PROFILE_ID' });
    }
    try {
      return res.json(await reads.listFamilyCases({
        lineUserId:req.user.lineUserId,
        careProfileId:req.query.careProfileId || null,
      }));
    }
    catch (error) { return consultationError(res, error); }
  }));

  router.post('/safety', asyncHandler(async (req, res) => {
    const keys = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
    if (keys.some((key) => !['careProfileId', 'question'].includes(key))) {
      return res.status(400).json({ status:'invalid_request', errorCode:'UNSUPPORTED_FIELD' });
    }
    if (!IDENTIFIER_PATTERN.test(req.body?.careProfileId || '')) {
      return res.status(400).json({ status:'invalid_request', errorCode:'INVALID_CARE_PROFILE_ID' });
    }
    if (typeof req.body?.question !== 'string' || !req.body.question.trim() || req.body.question.length > 4000) {
      return res.status(400).json({ status:'invalid_request', errorCode:'INVALID_QUESTION' });
    }
    const eligibilityResult = await eligibility.checkEligibility({
      lineUserId:req.user.lineUserId,
      careProfileId:req.body?.careProfileId,
      config:req.consultationConfig,
    });
    if (eligibilityResult.availability !== 'eligible') {
      return res.status(403).json({
        action:'unavailable', reasonCode:eligibilityResult.reasonCode || 'ACCESS_DENIED',
      });
    }
    return res.json(classifyConsultationSafety(req.body?.question));
  }));

  router.post('/checkout', asyncHandler(async (req,res)=>{
    const keys=req.body&&typeof req.body==='object'?Object.keys(req.body):[];
    if(keys.some((key)=>!['careProfileId','question','termsAccepted','termsVersion'].includes(key)))return res.status(400).json({status:'invalid_request',errorCode:'UNSUPPORTED_FIELD'});
    if(!IDENTIFIER_PATTERN.test(req.body?.careProfileId||''))return res.status(400).json({status:'invalid_request',errorCode:'INVALID_CARE_PROFILE_ID'});
    if(typeof req.body?.question!=='string'||!req.body.question.trim()||req.body.question.length>4000)return res.status(400).json({status:'invalid_request',errorCode:'INVALID_QUESTION'});
    if(req.body?.termsAccepted!==true)return res.status(400).json({status:'invalid_request',errorCode:'TERMS_NOT_ACCEPTED'});
    const safety=classifyConsultationSafety(req.body.question);
    if(safety.action!=='pharmacist_consultation_eligible')return res.status(403).json(safety);
    try{
      await rates.requireCheckout(req.user.lineUserId,req.consultationConfig);
      const provider=overrides.paymentProvider||createConsultationPaymentProvider(overrides.paymentProviderOptions);
      const result=await checkout.prepareCheckout({lineUserId:req.user.lineUserId,careProfileId:req.body.careProfileId,initialQuestion:req.body.question,termsAccepted:true,termsVersion:req.body.termsVersion,provider,config:req.consultationConfig});
      return res.status(result.resumed ? 200 : 201).json({status:result.status,orderId:result.orderId,amountMinor:result.amountMinor,currency:result.currency,durationMinutes:result.durationMinutes,termsVersion:result.termsVersion,payment:result.paymentInstructions,resumed:result.resumed===true});
    }catch(error){return consultationError(res,error);}
  }));

  router.get('/orders/current',asyncHandler(async(req,res)=>{
    if(!IDENTIFIER_PATTERN.test(req.query.careProfileId||''))return res.status(400).json({status:'invalid_request',errorCode:'INVALID_CARE_PROFILE_ID'});
    try{return res.json(await paymentStatus.getCurrent({careProfileId:req.query.careProfileId,lineUserId:req.user.lineUserId}));}
    catch(error){return consultationError(res,error);}
  }));

  router.get('/orders/:orderId/status',asyncHandler(async(req,res)=>{
    if(!IDENTIFIER_PATTERN.test(req.params.orderId))return res.status(400).json({status:'invalid_request',errorCode:'INVALID_ORDER_ID'});
    try{return res.json(await paymentStatus.getStatus({orderId:req.params.orderId,lineUserId:req.user.lineUserId}));}
    catch(error){return consultationError(res,error);}
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
        afterSequence:req.query.afterSequence, beforeSequence:req.query.beforeSequence,
        limit:req.query.limit,
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
      await rates.requireMessage({caseId:req.params.caseId,actorType:'customer',actorId:req.user.lineUserId},req.consultationConfig);
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
    } catch (error) { return consultationError(res, error, writeDiagnostics('family_message_send')); }
  }));

  router.post('/:caseId/realtime-ticket', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.caseId)) return res.status(400).json({ status:'invalid_request', errorCode:'INVALID_CASE_ID' });
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
      return res.status(400).json({ status:'invalid_request', errorCode:'UNSUPPORTED_FIELD' });
    }
    try {
      return res.json(await realtimeAccess.issueFamilyTicket({
        caseId:req.params.caseId,
        lineUserId:req.user.lineUserId,
      }));
    } catch (error) { return consultationError(res, error); }
  }));

  router.post('/:caseId/read', asyncHandler(async (req, res) => {
    if (!IDENTIFIER_PATTERN.test(req.params.caseId)) return res.status(400).json({ status:'invalid_request', errorCode:'INVALID_CASE_ID' });
    const keys = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
    if (keys.some((key) => key !== 'sequence')) {
      return res.status(400).json({ status:'invalid_request', errorCode:'UNSUPPORTED_FIELD' });
    }
    try {
      return res.json(await readReceipts.markRead({
        caseId:req.params.caseId,
        actor:{type:'customer',lineUserId:req.user.lineUserId},
        sequence:req.body?.sequence,
      }));
    } catch (error) { return consultationError(res, error); }
  }));

  return router;
}

module.exports = createConsultationsRouter();
module.exports.createConsultationsRouter = createConsultationsRouter;
module.exports.consultationError = consultationError;
