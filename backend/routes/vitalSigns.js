const express = require('express');
const { requireAuth, requireCenterStaff } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { vitalSignService: defaultService } = require('../services/vitalSignService');

function serviceFor(req) { return req.app.locals.vitalSignService || defaultService; }

function safeError(res, error) {
  const status = Number(error?.status) || 500;
  return res.status(status).json({
    error: status >= 500 ? 'internal_error' : status === 404 ? 'not_found'
      : status === 403 ? 'forbidden' : status === 409 ? 'conflict' : 'bad_request',
    errorCode: error?.code || 'VITAL_OPERATION_FAILED',
    message: status >= 500 ? 'ดำเนินการข้อมูลสัญญาณชีพไม่สำเร็จ' : error.message,
  });
}

function action(handler) {
  return asyncHandler(async (req, res) => {
    try { return await handler(req, res, serviceFor(req)); }
    catch (error) { return safeError(res, error); }
  });
}

function createVitalSignsRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/care-profile/:careProfileId/vital-signs', action(async (req, res, service) => {
    res.json(await service.listHistory({
      lineUserId:req.user.lineUserId, careProfileId:req.params.careProfileId,
      centerId:req.query.centerId || null, from:req.query.from || null,
      to:req.query.to || null, cursor:req.query.cursor || null, limit:req.query.limit,
    }));
  }));

  router.post('/center/:centerId/residents/:residentId/vital-signs', requireCenterStaff(['owner','manager','staff']), action(async (req, res, service) => {
    const result = await service.recordNative({
      lineUserId:req.user.lineUserId, centerId:req.params.centerId,
      residentId:req.params.residentId, occurredAt:req.body.occurredAt,
      observations:req.body.observations,
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  }));

  router.get('/center/:centerId/vital-signs/history', requireCenterStaff(['owner','manager','staff']), action(async (req, res, service) => {
    res.json(await service.listCenterHistory({lineUserId:req.user.lineUserId,centerId:req.params.centerId,
      residentId:req.query.residentId || null,limit:req.query.limit}));
  }));

  router.post('/center/:centerId/vital-signs/:vitalSetId/void', requireCenterStaff(['owner','manager']), action(async (req, res, service) => {
    res.json({ item:await service.voidVitalSet({
      lineUserId:req.user.lineUserId, centerId:req.params.centerId,
      vitalSetId:req.params.vitalSetId, reason:req.body.reason,
    }) });
  }));

  return router;
}

module.exports = { createVitalSignsRouter, safeError };
