const { parseBoolean } = require('./featureFlags');
const { parseInteger } = require('./v2Config');

const OMISE_API_BASE_URL = 'https://api.omise.co';

function loadConsultationPaymentConfig(env = process.env) {
  return Object.freeze({
    provider:String(env.CONSULTATION_PAYMENT_PROVIDER || '').trim().toLowerCase() || null,
    testMode:parseBoolean(env.CONSULTATION_PAYMENT_TEST_MODE,true),
    omise:Object.freeze({
      publicKey:String(env.OMISE_PUBLIC_KEY || '').trim() || null,
      secretKey:String(env.OMISE_SECRET_KEY || '').trim() || null,
      webhookSecret:String(env.OMISE_WEBHOOK_SECRET || '').trim() || null,
      timeoutMs:parseInteger(env.OMISE_TIMEOUT_MS,15000,{min:1000,max:30000}),
      apiBaseUrl:OMISE_API_BASE_URL,
    }),
  });
}

module.exports={OMISE_API_BASE_URL,loadConsultationPaymentConfig};
