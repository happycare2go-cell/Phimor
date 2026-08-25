const crypto=require('node:crypto');
const {PaymentProvider}=require('./PaymentProvider');
const {ConsultationDomainError}=require('../domain/consultation');
const {OMISE_API_BASE_URL}=require('../config/consultationPaymentConfig');

const STATUS_EVENT=Object.freeze({successful:'payment_succeeded',failed:'payment_failed',expired:'payment_failed',pending:'payment_pending'});
const CHARGE_ID=/^chrg_test_[0-9a-z]+$/;

function providerError(code,status=502){return new ConsultationDomainError(code,status,'ระบบชำระเงินยังไม่พร้อมใช้งาน');}
function validBase64Secret(value){if(typeof value!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))return false;try{return Buffer.from(value,'base64').length>=16;}catch(_){return false;}}
function assertTestConfig(config={}){
  if(config.testMode!==true)throw providerError('OMISE_TEST_MODE_REQUIRED',503);
  if(!/^pkey_test_[0-9a-z]+$/.test(config.publicKey||'')||!/^skey_test_[0-9a-z]+$/.test(config.secretKey||''))throw providerError('OMISE_TEST_KEYS_REQUIRED',503);
  if(!validBase64Secret(config.webhookSecret))throw providerError('OMISE_WEBHOOK_SECRET_REQUIRED',503);
  if(config.apiBaseUrl&&config.apiBaseUrl!==OMISE_API_BASE_URL)throw providerError('OMISE_API_ENDPOINT_INVALID',503);
  return config;
}
function safeQrUrl(charge){const value=charge?.source?.scannable_code?.image?.download_uri;if(typeof value!=='string')return null;try{const url=new URL(value);return url.protocol==='https:'?url.toString():null;}catch(_){return null;}}
function mapCharge(charge,{providerEventId=null,payloadHash=null}={}){
  if(!charge||charge.object!=='charge'||typeof charge.id!=='string')throw providerError('OMISE_INVALID_CHARGE_RESPONSE');
  if(charge.livemode!==false||!CHARGE_ID.test(charge.id))throw providerError('OMISE_LIVE_CHARGE_REJECTED',409);
  const status=String(charge.status||'').toLowerCase();
  return Object.freeze({
    verified:true,signatureVerified:true,provider:'omise',
    providerEventId:providerEventId||`reconcile:${charge.id}:${status||'unknown'}`,
    providerPaymentId:charge.id,providerCheckoutId:charge.id,
    orderId:typeof charge.metadata?.order_id==='string'?charge.metadata.order_id:'',
    amountMinor:charge.amount,currency:String(charge.currency||'').toUpperCase(),
    eventType:STATUS_EVENT[status]||'payment_unknown',
    paidAt:charge.paid_at||null,payloadHash,
  });
}

class OmisePaymentProvider extends PaymentProvider{
  constructor({config,fetchImpl=globalThis.fetch,now=()=>new Date()}={}){
    super();this.config=assertTestConfig(config);if(typeof fetchImpl!=='function')throw providerError('OMISE_HTTP_CLIENT_REQUIRED',503);this.fetchImpl=fetchImpl;this.now=now;
  }
  async request(path,{method='GET',form=null}={}){
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),this.config.timeoutMs||15000);
    try{
      const response=await this.fetchImpl(`${OMISE_API_BASE_URL}${path}`,{method,headers:{Authorization:`Basic ${Buffer.from(`${this.config.secretKey}:`).toString('base64')}`,...(form?{'Content-Type':'application/x-www-form-urlencoded'}:{})},body:form?form.toString():undefined,signal:controller.signal});
      const data=await response.json().catch(()=>null);if(!response.ok)throw providerError(response.status===429?'OMISE_RATE_LIMITED':'OMISE_API_ERROR',response.status===429?503:502);return data;
    }catch(error){if(error instanceof ConsultationDomainError)throw error;if(error?.name==='AbortError')throw providerError('OMISE_TIMEOUT',503);throw providerError('OMISE_UNAVAILABLE',503);}finally{clearTimeout(timeout);}
  }
  async createCheckout({orderId,amountMinor,currency,durationMinutes}){
    if(typeof orderId!=='string'||!orderId)throw providerError('OMISE_ORDER_REQUIRED',400);
    const form=new URLSearchParams();form.set('amount',String(amountMinor));form.set('currency',String(currency).toLowerCase());form.set('source[type]','promptpay');form.set('metadata[order_id]',orderId);form.set('metadata[purpose]','phimor_consultation');
    const charge=await this.request('/charges',{method:'POST',form});const mapped=mapCharge(charge);const qrImageUrl=safeQrUrl(charge);
    if(charge.status!=='pending'||charge.source?.type!=='promptpay'||!qrImageUrl)throw providerError('OMISE_PROMPTPAY_CHECKOUT_INVALID');
    if(mapped.orderId!==orderId||mapped.amountMinor!==amountMinor||mapped.currency!==currency)throw providerError('OMISE_CHECKOUT_MISMATCH',409);
    return Object.freeze({provider:'omise',checkoutId:charge.id,providerPaymentId:charge.id,orderId,amountMinor,currency,durationMinutes,status:'payment_pending',paymentDueAt:charge.expires_at||null,paymentInstructions:Object.freeze({method:'promptpay',qrImageUrl,expiresAt:charge.expires_at||null})});
  }
  async verifyWebhook({rawBody,headers={}}={}){
    const body=Buffer.isBuffer(rawBody)?rawBody:Buffer.from(rawBody||'');const signature=String(headers['omise-signature']||headers['Omise-Signature']||'');const timestamp=String(headers['omise-signature-timestamp']||headers['Omise-Signature-Timestamp']||'');
    if(!body.length||!signature||!/^\d{10,}$/.test(timestamp))throw providerError('OMISE_WEBHOOK_SIGNATURE_INVALID',401);
    const age=Math.abs(this.now().getTime()-Number(timestamp)*1000);if(!Number.isFinite(age)||age>5*60*1000)throw providerError('OMISE_WEBHOOK_TIMESTAMP_INVALID',401);
    const expected=crypto.createHmac('sha256',Buffer.from(this.config.webhookSecret,'base64')).update(`${timestamp}.${body.toString('utf8')}`).digest();
    const valid=signature.split(',').some((item)=>{try{const candidate=Buffer.from(item.trim(),'hex');return candidate.length===expected.length&&crypto.timingSafeEqual(candidate,expected);}catch(_){return false;}});
    if(!valid)throw providerError('OMISE_WEBHOOK_SIGNATURE_INVALID',401);
    let event;try{event=JSON.parse(body.toString('utf8'));}catch(_){throw providerError('OMISE_WEBHOOK_PAYLOAD_INVALID',400);}
    if(event?.livemode===true||event?.data?.livemode===true)throw providerError('OMISE_LIVE_EVENT_REJECTED',403);
    return Object.freeze({verified:true,signatureVerified:true,provider:'omise',providerEventId:String(event?.id||''),eventKey:String(event?.key||''),providerPaymentId:typeof event?.data?.id==='string'?event.data.id:null,payloadHash:crypto.createHash('sha256').update(body).digest('hex')});
  }
  async retrievePayment({providerPaymentId=null,providerCheckoutId=null}={}){
    const chargeId=providerPaymentId||providerCheckoutId;if(!CHARGE_ID.test(chargeId||''))throw providerError('OMISE_CHARGE_ID_INVALID',400);return mapCharge(await this.request(`/charges/${encodeURIComponent(chargeId)}`));
  }
}

module.exports={OmisePaymentProvider,STATUS_EVENT,CHARGE_ID,assertTestConfig,safeQrUrl,mapCharge};
