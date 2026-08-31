const express=require('express');
const {requireAuth,requireCenterStaff}=require('../middleware/auth');
const {asyncHandler}=require('../middleware/asyncHandler');
const {dailyCareService:defaultService}=require('../services/dailyCareService');
function serviceFor(req){return req.app.locals.dailyCareService||defaultService;}
function safeError(res,error){const status=Number(error?.status)||500;return res.status(status).json({
  error:status>=500?'internal_error':status===404?'not_found':status===403?'forbidden':status===409?'conflict':'bad_request',
  errorCode:error?.code||'DAILY_CARE_OPERATION_FAILED',message:status>=500?'ดำเนินการข้อมูลการดูแลประจำวันไม่สำเร็จ':error.message});}
function action(handler){return asyncHandler(async(req,res)=>{try{return await handler(req,res,serviceFor(req));}catch(error){return safeError(res,error);}});}
const NATIVE_HEALTH_REPORT_FIELDS=new Set(['occurredAt','careDate','shift','items','vitalSigns']);
const NATIVE_HEALTH_VITAL_TYPES=new Set(['temperature','blood_pressure_systolic','blood_pressure_diastolic','pulse','spo2']);
const NATIVE_HEALTH_ITEM_FIELDS=new Set(['itemType','valueType','textValue','sourceValueText']);
const NATIVE_HEALTH_VITAL_FIELDS=new Set(['occurredAt','observations']);
const NATIVE_HEALTH_OBSERVATION_FIELDS=new Set(['measurementType','numericValue','sourceValueText','sourceUnit','context']);
const NATIVE_HEALTH_SHIFT_FIELDS=new Set(['code','sourceLabel','source_label']);
function validateNativeHealthReportBody(body={}){
  if(!body||typeof body!=='object'||Array.isArray(body)) {
    throw Object.assign(new Error('คำขอรายงานสุขภาพไม่ถูกต้อง'),{code:'INVALID_HEALTH_REPORT_BODY',status:400});
  }
  const unknown=Object.keys(body).filter((key)=>!NATIVE_HEALTH_REPORT_FIELDS.has(key));
  if(unknown.length)throw Object.assign(new Error('คำขอรายงานสุขภาพมีข้อมูลที่ไม่รองรับ'),{code:'UNKNOWN_HEALTH_REPORT_FIELD',status:400});
  if(body.shift!==undefined&&body.shift!==null&&(!body.shift||typeof body.shift!=='object'||Array.isArray(body.shift)
    ||Object.keys(body.shift).some((key)=>!NATIVE_HEALTH_SHIFT_FIELDS.has(key)))) {
    throw Object.assign(new Error('ข้อมูลช่วงเวรมีช่องข้อมูลที่ไม่รองรับ'),{code:'UNKNOWN_HEALTH_REPORT_SHIFT_FIELD',status:400});
  }
  const items=body.items===undefined?[]:body.items;
  if(!Array.isArray(items)||items.some((item)=>String(item?.itemType||item?.item_type||'').trim()!=='symptom_note')) {
    throw Object.assign(new Error('รายงานสุขภาพใหม่รองรับเฉพาะอาการหรือรายงานทั่วไปเพิ่มเติม'),{code:'UNSUPPORTED_NATIVE_HEALTH_REPORT_ITEM',status:400});
  }
  if(items.some((item)=>!item||typeof item!=='object'||Array.isArray(item)
    ||Object.keys(item).some((key)=>!NATIVE_HEALTH_ITEM_FIELDS.has(key)))) {
    throw Object.assign(new Error('ข้อมูลอาการหรือรายงานทั่วไปมีช่องข้อมูลที่ไม่รองรับ'),{code:'UNKNOWN_HEALTH_REPORT_ITEM_FIELD',status:400});
  }
  const observations=body.vitalSigns?.observations;
  if(body.vitalSigns!==undefined&&body.vitalSigns!==null&&(!body.vitalSigns||typeof body.vitalSigns!=='object'
    ||Array.isArray(body.vitalSigns)||Object.keys(body.vitalSigns).some((key)=>!NATIVE_HEALTH_VITAL_FIELDS.has(key))
    ||!Array.isArray(observations)||observations.some((item)=>!item||typeof item!=='object'||Array.isArray(item)
      ||Object.keys(item).some((key)=>!NATIVE_HEALTH_OBSERVATION_FIELDS.has(key))
      ||!NATIVE_HEALTH_VITAL_TYPES.has(String(item.measurementType||'').trim())))) {
    throw Object.assign(new Error('รายงานสุขภาพมีประเภทสัญญาณชีพที่ไม่รองรับ'),{code:'UNSUPPORTED_NATIVE_HEALTH_REPORT_VITAL',status:400});
  }
  if(items.length===0&&(!Array.isArray(observations)||observations.length===0)) {
    throw Object.assign(new Error('กรุณากรอกสัญญาณชีพอย่างน้อย 1 ค่า หรืออาการ/รายงานทั่วไป'),{code:'HEALTH_REPORT_CONTENT_REQUIRED',status:400});
  }
  return {...body,items};
}
function createDailyCareRouter(){const router=express.Router();
  router.get('/care-profile/:careProfileId/daily-care',requireAuth,action(async(req,res,service)=>res.json(await service.listHistory({
    lineUserId:req.user.lineUserId,careProfileId:req.params.careProfileId,centerId:req.query.centerId||null,
    from:req.query.from||null,to:req.query.to||null,cursor:req.query.cursor||null,limit:req.query.limit}))));
  router.post('/center/:centerId/residents/:residentId/daily-care',requireAuth,requireCenterStaff(['owner','manager','staff']),action(async(req,res,service)=>{
    const body=validateNativeHealthReportBody(req.body);
    const result=await service.recordNative({lineUserId:req.user.lineUserId,centerId:req.params.centerId,residentId:req.params.residentId,
      occurredAt:body.occurredAt,careDate:body.careDate||null,shift:body.shift||null,
      items:body.items,vitalSigns:body.vitalSigns||null});return res.status(result.duplicate?200:201).json(result);}));
  router.get('/center/:centerId/daily-care/review',requireAuth,requireCenterStaff(['owner','manager','staff']),action(async(req,res,service)=>res.json(await service.listCenterWorkflow({
    lineUserId:req.user.lineUserId,centerId:req.params.centerId,status:req.query.status||'submitted',limit:req.query.limit}))));
  router.post('/center/:centerId/daily-care/:dailyReportId/return',requireAuth,requireCenterStaff(['owner','manager']),action(async(req,res,service)=>res.json({item:await service.returnForCorrection({
    lineUserId:req.user.lineUserId,centerId:req.params.centerId,dailyReportId:req.params.dailyReportId,reason:req.body.reason})})));
  router.post('/center/:centerId/daily-care/:dailyReportId/resubmit',requireAuth,requireCenterStaff(['owner','manager','staff']),action(async(req,res,service)=>{
    const result=await service.resubmitReport({lineUserId:req.user.lineUserId,centerId:req.params.centerId,dailyReportId:req.params.dailyReportId,
      occurredAt:req.body.occurredAt,careDate:req.body.careDate||null,shift:req.body.shift||null,
      items:req.body.items,vitalSigns:req.body.vitalSigns||null});return res.status(201).json(result);}));
  router.post('/center/:centerId/daily-care/:dailyReportId/finalize',requireAuth,requireCenterStaff(['owner','manager']),action(async(req,res,service)=>res.json(await service.finalizeReport({
    lineUserId:req.user.lineUserId,centerId:req.params.centerId,dailyReportId:req.params.dailyReportId}))));
  router.post('/center/:centerId/daily-care/:dailyReportId/corrections',requireAuth,requireCenterStaff(['owner','manager']),action(async(req,res,service)=>{
    const result=await service.createCorrectionVersion({lineUserId:req.user.lineUserId,centerId:req.params.centerId,
      dailyReportId:req.params.dailyReportId,reason:req.body.reason});return res.status(result.duplicate?200:201).json(result);}));
  router.post('/center/:centerId/daily-care/:dailyReportId/void',requireAuth,requireCenterStaff(['owner','manager']),action(async(req,res,service)=>res.json({item:await service.voidReport({
    lineUserId:req.user.lineUserId,centerId:req.params.centerId,dailyReportId:req.params.dailyReportId,reason:req.body.reason})})));
  return router;}
module.exports={createDailyCareRouter,safeError,validateNativeHealthReportBody,NATIVE_HEALTH_VITAL_TYPES};
