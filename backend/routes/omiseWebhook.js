const express=require('express');
const {createOmiseWebhookDispatchService}=require('../services/omiseWebhookDispatchService');

function createOmiseWebhookRouter(overrides={}){
  const router=express.Router();
  router.post('/',async(req,res)=>{
    try{
      const service=overrides.webhookService||createOmiseWebhookDispatchService(overrides.dependencies);
      const result=await service.handle({rawBody:req.body,headers:req.headers});
      if(!result.acknowledged)return res.status(503).json({status:'retry_required'});
      return res.status(200).json({status:result.status==='processed'?'accepted':'acknowledged',duplicate:result.duplicate||false});
    }catch(error){
      const status=Number.isInteger(error?.status)?error.status:503;
      return res.status(status===401||status===403?status:status>=500?503:400).json({status:'rejected',errorCode:status>=500?'PAYMENT_WEBHOOK_UNAVAILABLE':'PAYMENT_WEBHOOK_REJECTED'});
    }
  });
  return router;
}
module.exports=createOmiseWebhookRouter();module.exports.createOmiseWebhookRouter=createOmiseWebhookRouter;
