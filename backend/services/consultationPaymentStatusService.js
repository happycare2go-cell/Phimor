const {createConsultationRepository}=require('./consultationRepository');
const {authorizeCareProfileAccess}=require('./careProfileAuthorizationService');
const {ConsultationDomainError}=require('../domain/consultation');
const {safePaymentResumeData}=require('./consultationCheckoutService');

function projectedPaymentStatus(order, consultationCase=null, referenceTime=new Date()) {
  if (!order) return 'none';
  if (order.status==='draft') return 'checkout_preparing';
  if (order.status==='payment_pending') {
    const due=order.payment_due_at ? new Date(order.payment_due_at) : null;
    if (due && !Number.isNaN(due.getTime()) && due.getTime()<=new Date(referenceTime).getTime()) return 'expired';
    return 'payment_pending';
  }
  if (order.status==='paid' && order.provisioning_status!=='provisioned') return 'payment_confirming';
  if (order.status==='paid' && order.provisioning_status==='provisioned' && consultationCase) {
    return consultationCase.state || 'queued';
  }
  return order.status;
}

function projectOrder(order, consultationCase=null) {
  const status=projectedPaymentStatus(order,consultationCase,order?.database_now || new Date());
  return {
    orderId:order.order_id,
    paymentReference:order.order_id,
    status,
    caseId:consultationCase?.case_id || order.case_id || null,
    amountMinor:order.amount_minor,
    currency:order.currency,
    paymentExpiresAt:order.payment_due_at||null,
    payment:status==='payment_pending' ? safePaymentResumeData(order.payment_resume_data) : null,
  };
}

function createConsultationPaymentStatusService({repository=createConsultationRepository(),authorize=authorizeCareProfileAccess}={}){
  async function getStatus({orderId,lineUserId}={}){
    if(!orderId||!lineUserId)throw new ConsultationDomainError('PAYMENT_STATUS_INPUT_REQUIRED',400);
    const order=await repository.findOrder(orderId);
    if(!order||order.customer_line_user_id!==lineUserId)throw new ConsultationDomainError('ORDER_NOT_FOUND',404);
    await authorize({lineUserId,careProfileId:order.care_profile_id,permission:'view',requireActiveCenter:true});
    return projectOrder(order,await repository.findCaseByOrderId(order.order_id));
  }

  async function getCurrent({careProfileId,lineUserId}={}) {
    if (!careProfileId || !lineUserId) throw new ConsultationDomainError('PAYMENT_STATUS_INPUT_REQUIRED',400);
    await authorize({lineUserId,careProfileId,permission:'view',requireActiveCenter:true});
    const order=await repository.findCurrentCheckout(lineUserId,careProfileId);
    if (!order) return {status:'none'};
    const consultationCase=order.case_id ? {
      case_id:order.case_id,state:order.case_state,accepted_at:order.accepted_at,
      expires_at:order.expires_at,closed_at:order.closed_at,close_reason:order.close_reason,
    } : null;
    return projectOrder(order,consultationCase);
  }

  return {getStatus,getCurrent};
}
module.exports={projectedPaymentStatus,projectOrder,createConsultationPaymentStatusService};
