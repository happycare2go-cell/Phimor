const { PaymentProvider } = require('./PaymentProvider');
const { ConsultationDomainError } = require('../domain/consultation');

const EVENT_TYPE_MAP = Object.freeze({
  success:'payment_succeeded',
  failed:'payment_failed',
  pending:'payment_pending',
  unknown:'payment_unknown',
});

class FakePaymentProvider extends PaymentProvider {
  constructor({ providerName = 'fake_payment', now = () => new Date() } = {}) {
    super();
    this.providerName = providerName;
    this.now = now;
    this.checkouts = new Map();
    this.payments = new Map();
    this.calls = { createCheckout:0, verifyWebhook:0, retrievePayment:0 };
  }

  async createCheckout({ orderId, amountMinor, currency, durationMinutes }) {
    this.calls.createCheckout += 1;
    if (!orderId) throw new ConsultationDomainError('FAKE_ORDER_REQUIRED');
    const checkoutId = `FCHK-${orderId}`;
    const record = {
      provider:this.providerName, checkoutId, orderId, amountMinor, currency,
      durationMinutes, status:'payment_pending', paymentDueAt:null,
    };
    this.checkouts.set(checkoutId, record);
    return Object.freeze({...record});
  }

  async verifyWebhook(envelope = {}) {
    this.calls.verifyWebhook += 1;
    const scenario = EVENT_TYPE_MAP[envelope.scenario] ? envelope.scenario : 'unknown';
    const delayed = envelope.availableAt
      && this.now().getTime() < new Date(envelope.availableAt).getTime();
    const eventType = EVENT_TYPE_MAP[delayed ? 'pending' : scenario];
    const result = Object.freeze({
      verified:envelope.signatureValid !== false,
      signatureVerified:envelope.signatureValid !== false,
      provider:this.providerName,
      providerEventId:String(envelope.eventId || ''),
      providerPaymentId:envelope.paymentId ? String(envelope.paymentId) : null,
      providerCheckoutId:envelope.checkoutId ? String(envelope.checkoutId) : null,
      orderId:String(envelope.orderId || ''),
      amountMinor:envelope.amountMinor,
      currency:envelope.currency,
      eventType,
      paidAt:envelope.paidAt || (scenario === 'success' && !delayed ? this.now().toISOString() : null),
      payloadHash:typeof envelope.payloadHash === 'string' ? envelope.payloadHash : null,
    });
    if (result.providerPaymentId) this.payments.set(result.providerPaymentId, result);
    return result;
  }

  async retrievePayment({ providerPaymentId = null, orderId = null } = {}) {
    this.calls.retrievePayment += 1;
    let result = providerPaymentId ? this.payments.get(providerPaymentId) : null;
    if (!result && orderId) result = [...this.payments.values()].find((item) => item.orderId === orderId);
    if (!result) throw new ConsultationDomainError('FAKE_PAYMENT_NOT_FOUND', 404);
    return Object.freeze({...result});
  }

  setPayment(result) {
    if (!result?.providerPaymentId) throw new ConsultationDomainError('FAKE_PAYMENT_ID_REQUIRED');
    const normalized = Object.freeze({
      ...result,
      verified:true, signatureVerified:true, provider:this.providerName,
    });
    this.payments.set(normalized.providerPaymentId, normalized);
    return normalized;
  }
}

module.exports = { FakePaymentProvider, EVENT_TYPE_MAP };
