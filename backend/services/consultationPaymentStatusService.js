const {createConsultationRepository}=require('./consultationRepository');
const {authorizeCareProfileAccess}=require('./careProfileAuthorizationService');
const {ConsultationDomainError}=require('../domain/consultation');

function createConsultationPaymentStatusService({repository=createConsultationRepository(),authorize=authorizeCareProfileAccess}={}){
  async function getStatus({orderId,lineUserId}={}){
    if(!orderId||!lineUserId)throw new ConsultationDomainError('PAYMENT_STATUS_INPUT_REQUIRED',400);
    const order=await repository.findOrder(orderId);if(!order||order.customer_line_user_id!==lineUserId)throw new ConsultationDomainError('ORDER_NOT_FOUND',404);
    await authorize({lineUserId,careProfileId:order.care_profile_id,permission:'view',requireActiveCenter:true});
    const consultationCase=await repository.findCaseByOrderId(order.order_id);
    const status=order.status==='paid'&&order.provisioning_status==='provisioned'&&consultationCase?'queued':order.status==='paid'?'payment_confirming':order.status;
    return {orderId:order.order_id,status,caseId:status==='queued'?consultationCase.case_id:null,amountMinor:order.amount_minor,currency:order.currency,paymentExpiresAt:order.payment_due_at||null};
  }
  return {getStatus};
}
module.exports={createConsultationPaymentStatusService};
