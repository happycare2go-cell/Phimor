const { ConsultationDomainError } = require('../domain/consultation');

class PaymentProvider {
  async createCheckout() {
    throw new ConsultationDomainError('PAYMENT_PROVIDER_NOT_IMPLEMENTED', 501);
  }

  async verifyWebhook() {
    throw new ConsultationDomainError('PAYMENT_PROVIDER_NOT_IMPLEMENTED', 501);
  }

  async retrievePayment() {
    throw new ConsultationDomainError('PAYMENT_PROVIDER_NOT_IMPLEMENTED', 501);
  }
}

// A verified payment result passed to the domain layer must be provider-neutral:
// {
//   verified: true, provider, providerEventId, providerPaymentId, orderId,
//   amountMinor, currency, eventType: 'payment_succeeded', paidAt, payloadHash
// }
// Reconciliation calls retrievePayment() and sends the same normalized result
// through the idempotent provisioning service; it never provisions from a
// browser redirect or an unverified frontend value.

module.exports = { PaymentProvider };
