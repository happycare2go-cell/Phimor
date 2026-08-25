const {loadConsultationPaymentConfig}=require('../config/consultationPaymentConfig');
const {OmisePaymentProvider}=require('./OmisePaymentProvider');
const {ConsultationDomainError}=require('../domain/consultation');

function createConsultationPaymentProvider({config=loadConsultationPaymentConfig(),fetchImpl=globalThis.fetch,now}={}){
  if(config.provider!=='omise')throw new ConsultationDomainError('CONSULTATION_PAYMENT_PROVIDER_UNAVAILABLE',503);
  return new OmisePaymentProvider({config:{...config.omise,testMode:config.testMode},fetchImpl,now});
}
module.exports={createConsultationPaymentProvider};
