const { createConsultationPaymentProvider } = require('../providers/consultationPaymentProviderFactory');
const { createConsultationOmiseWebhookService } = require('./consultationOmiseWebhookService');
const { createPlusPaymentIngestionService } = require('./plusPaymentIngestionService');
const { PlusPaymentError } = require('../domain/plusPayment');

function createOmiseWebhookDispatchService({
  provider = null,
  consultationService = null,
  plusIngestion = null,
} = {}) {
  const paymentProvider = provider || createConsultationPaymentProvider();
  const consultation = consultationService || createConsultationOmiseWebhookService({ provider: paymentProvider });
  const plus = plusIngestion || createPlusPaymentIngestionService();

  async function handle({ rawBody, headers } = {}) {
    const event = await paymentProvider.verifyWebhook({ rawBody, headers });
    if (!event.providerEventId) throw new PlusPaymentError('OMISE_EVENT_ID_REQUIRED', 400);
    if (event.eventKey !== 'charge.complete') {
      return { status: 'ignored', acknowledged: true, reasonCode: 'UNRELATED_OMISE_EVENT' };
    }
    if (!event.providerPaymentId) {
      return { status: 'ignored', acknowledged: true, reasonCode: 'OMISE_CHARGE_REFERENCE_MISSING' };
    }
    const retrieved = await paymentProvider.retrievePayment({ providerPaymentId: event.providerPaymentId });
    if (retrieved.purpose === 'phimor_plus') {
      const result = await plus.ingestAndProcess({
        ...retrieved,
        providerEventId: event.providerEventId,
        payloadHash: event.payloadHash,
        verified: true,
        signatureVerified: true,
      });
      return {
        status: result.status,
        acknowledged: result.status !== 'retry_required',
        duplicate: Boolean(result.duplicate),
        errorCode: result.errorCode || null,
        orderId: result.order?.order_id || retrieved.orderId,
      };
    }
    if (retrieved.purpose === 'phimor_consultation') {
      return consultation.handleVerifiedCharge({ event, retrieved, rawBody });
    }
    return { status: 'ignored', acknowledged: true, reasonCode: 'UNKNOWN_PAYMENT_PURPOSE' };
  }

  return { handle };
}

module.exports = { createOmiseWebhookDispatchService };
