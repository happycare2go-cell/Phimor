const express=require('express');
const {requireAuth,requireCenterStaff}=require('../middleware/auth');
const {asyncHandler}=require('../middleware/asyncHandler');
const {dailyCareService:defaultService}=require('../services/dailyCareService');
function serviceFor(req){return req.app.locals.dailyCareService||defaultService;}
function safeError(res,error){const status=Number(error?.status)||500;return res.status(status).json({
  error:status>=500?'internal_error':status===404?'not_found':status===403?'forbidden':status===409?'conflict':'bad_request',
  errorCode:error?.code||'DAILY_CARE_OPERATION_FAILED',message:status>=500?'ดำเนินการข้อมูลการดูแลประจำวันไม่สำเร็จ':error.message});}
function action(handler){return asyncHandler(async(req,res)=>{try{return await handler(req,res,serviceFor(req));}catch(error){return safeError(res,error);}});}
function createDailyCareRouter(){const router=express.Router();router.use(requireAuth);
  router.get('/care-profile/:careProfileId/daily-care',action(async(req,res,service)=>res.json(await service.listHistory({
    lineUserId:req.user.lineUserId,careProfileId:req.params.careProfileId,centerId:req.query.centerId||null,
    from:req.query.from||null,to:req.query.to||null,cursor:req.query.cursor||null,limit:req.query.limit}))));
  router.post('/center/:centerId/residents/:residentId/daily-care',requireCenterStaff(['owner','manager','staff']),action(async(req,res,service)=>{
    const result=await service.recordNative({lineUserId:req.user.lineUserId,centerId:req.params.centerId,residentId:req.params.residentId,
      occurredAt:req.body.occurredAt,careDate:req.body.careDate||null,shift:req.body.shift||null,
      items:req.body.items,vitalSigns:req.body.vitalSigns||null});return res.status(result.duplicate?200:201).json(result);}));
  router.get('/center/:centerId/daily-care/review',requireCenterStaff(['owner','manager','staff']),action(async(req,res,service)=>res.json(await service.listCenterWorkflow({
    lineUserId:req.user.lineUserId,centerId:req.params.centerId,status:req.query.status||'submitted',limit:req.query.limit}))));
  router.post('/center/:centerId/daily-care/:dailyReportId/return',requireCenterStaff(['owner','manager']),action(async(req,res,service)=>res.json({item:await service.returnForCorrection({
    lineUserId:req.user.lineUserId,centerId:req.params.centerId,dailyReportId:req.params.dailyReportId,reason:req.body.reason})})));
  router.post('/center/:centerId/daily-care/:dailyReportId/resubmit',requireCenterStaff(['owner','manager','staff']),action(async(req,res,service)=>{
    const result=await service.resubmitReport({lineUserId:req.user.lineUserId,centerId:req.params.centerId,dailyReportId:req.params.dailyReportId,
      occurredAt:req.body.occurredAt,careDate:req.body.careDate||null,shift:req.body.shift||null,
      items:req.body.items,vitalSigns:req.body.vitalSigns||null});return res.status(201).json(result);}));
  router.post('/center/:centerId/daily-care/:dailyReportId/finalize',requireCenterStaff(['owner','manager']),action(async(req,res,service)=>res.json(await service.finalizeReport({
    lineUserId:req.user.lineUserId,centerId:req.params.centerId,dailyReportId:req.params.dailyReportId}))));
  router.post('/center/:centerId/daily-care/:dailyReportId/corrections',requireCenterStaff(['owner','manager']),action(async(req,res,service)=>{
    const result=await service.createCorrectionVersion({lineUserId:req.user.lineUserId,centerId:req.params.centerId,
      dailyReportId:req.params.dailyReportId,reason:req.body.reason});return res.status(result.duplicate?200:201).json(result);}));
  router.post('/center/:centerId/daily-care/:dailyReportId/void',requireCenterStaff(['owner','manager']),action(async(req,res,service)=>res.json({item:await service.voidReport({
    lineUserId:req.user.lineUserId,centerId:req.params.centerId,dailyReportId:req.params.dailyReportId,reason:req.body.reason})})));
  return router;}
module.exports={createDailyCareRouter,safeError};
