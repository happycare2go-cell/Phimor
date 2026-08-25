const {createHash}=require('node:crypto');
const {createConsultationPaymentProvider}=require('../providers/consultationPaymentProviderFactory');
const {createConsultationPaymentIngestionService}=require('./consultationPaymentIngestionService');
const {ConsultationDomainError}=require('../domain/consultation');

function createConsultationOmiseWebhookService({provider=null,ingestionService=null}={}){
  const paymentProvider=provider||createConsultationPaymentProvider();
  const ingestion=ingestionService||createConsultationPaymentIngestionService();
  async function handle({rawBody,headers}={}){
    const event=await paymentProvider.verifyWebhook({rawBody,headers});
    if(!event.providerEventId)throw new ConsultationDomainError('OMISE_EVENT_ID_REQUIRED',400);
    if(event.eventKey!=='charge.complete')return {status:'ignored',acknowledged:true,reasonCode:'UNRELATED_OMISE_EVENT'};
    if(!event.providerPaymentId)return {status:'ignored',acknowledged:true,reasonCode:'OMISE_CHARGE_REFERENCE_MISSING'};
    const retrieved=await paymentProvider.retrievePayment({providerPaymentId:event.providerPaymentId});
    if(retrieved.eventType!=='payment_succeeded')return {status:'ignored',acknowledged:true,reasonCode:'PAYMENT_NOT_SUCCESSFUL'};
    const normalized={...retrieved,providerEventId:event.providerEventId,payloadHash:event.payloadHash||createHash('sha256').update(rawBody).digest('hex'),verified:true,signatureVerified:true};
    const durable=await ingestion.ingestVerifiedEvent(normalized);const result=await ingestion.processIngestedEvent(durable);
    return {status:result.status,acknowledged:result.status!=='retry_required',duplicate:Boolean(result.duplicate),errorCode:result.errorCode||null,orderId:result.order?.order_id||normalized.orderId,caseId:result.consultationCase?.case_id||null};
  }
  return {handle};
}
module.exports={createConsultationOmiseWebhookService};
