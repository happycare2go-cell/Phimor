const { withTransaction } = require('../db');
const { createConsultationRepository } = require('./consultationRepository');
const { createConsultationOrderService } = require('./consultationOrderService');
const { loadConsultationConfig, isInternalConsultationUser } = require('../config/consultationConfig');
const { ConsultationDomainError } = require('../domain/consultation');

function safePaymentResumeData(value) {
  if (!value || value.method !== 'promptpay') return null;
  let qrImageUrl = null;
  try {
    const parsed = new URL(value.qrImageUrl);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) qrImageUrl = parsed.toString();
  } catch (_) { /* a missing QR remains a status-only recovery */ }
  const expires = value.expiresAt ? new Date(value.expiresAt) : null;
  return Object.freeze({
    method:'promptpay',
    ...(qrImageUrl ? {qrImageUrl} : {}),
    ...(expires && !Number.isNaN(expires.getTime()) ? {expiresAt:expires.toISOString()} : {}),
  });
}

function createConsultationCheckoutService({
  repository = createConsultationRepository(),
  transaction = withTransaction,
  orderService = null,
  configLoader = loadConsultationConfig,
} = {}) {
  const orders = orderService || createConsultationOrderService({repository,transaction});

  async function prepareCheckout({
    lineUserId, careProfileId, initialQuestion,
    termsAccepted, termsVersion, provider,
    config:suppliedConfig = null,
  } = {}) {
    const config = suppliedConfig || configLoader();
    if (!config.enabled) throw new ConsultationDomainError('CONSULTATION_DISABLED', 503);
    if (!isInternalConsultationUser(lineUserId, config)) {
      throw new ConsultationDomainError('INTERNAL_ACCESS_REQUIRED', 403);
    }
    if (!config.termsVersion) throw new ConsultationDomainError('CONSULTATION_TERMS_NOT_CONFIGURED', 503);
    if (termsVersion !== config.termsVersion) throw new ConsultationDomainError('TERMS_VERSION_MISMATCH', 409);
    if (!provider || typeof provider.createCheckout !== 'function') {
      throw new ConsultationDomainError('PAYMENT_PROVIDER_REQUIRED');
    }

    const order = await orders.createDraft({
      lineUserId, careProfileId, initialQuestion,
      termsAccepted, termsVersion:config.termsVersion,
    });
    if (order.checkout_reused) {
      const status = order.status === 'paid' ? 'payment_confirming'
        : order.status === 'payment_pending' ? 'payment_pending' : 'checkout_preparing';
      return {
        orderId:order.order_id, status, resumed:true,
        amountMinor:order.amount_minor, currency:order.currency,
        durationMinutes:order.duration_minutes, termsVersion:order.terms_version,
        termsAcceptedAt:order.terms_accepted_at,
        paymentInstructions:status === 'payment_pending'
          ? safePaymentResumeData(order.payment_resume_data) : null,
      };
    }

    let checkout;
    try {
      checkout = await provider.createCheckout({
        orderId:order.order_id,
        amountMinor:order.amount_minor,
        currency:order.currency,
        durationMinutes:order.duration_minutes,
      });
    } catch (error) {
      await transaction(`consultation-checkout:${order.order_id}`, () =>
        repository.markOrderPaymentFailed(order.order_id));
      throw error;
    }
    if (!checkout?.provider || !checkout?.checkoutId) {
      await transaction(`consultation-checkout:${order.order_id}`, () =>
        repository.markOrderPaymentFailed(order.order_id));
      throw new ConsultationDomainError('INVALID_PROVIDER_CHECKOUT', 502);
    }
    const paymentResumeData = safePaymentResumeData(checkout.paymentInstructions);
    const pendingOrder = await transaction(`consultation-checkout:${order.order_id}`, async () => {
      const locked = await repository.findOrderForUpdate(order.order_id);
      if (!locked) throw new ConsultationDomainError('ORDER_NOT_FOUND', 404);
      if (locked.terms_version !== config.termsVersion
          || locked.amount_minor !== config.priceMinor
          || locked.currency !== config.currency
          || locked.duration_minutes !== config.durationMinutes) {
        throw new ConsultationDomainError('ORDER_SNAPSHOT_MISMATCH', 409);
      }
      return repository.markOrderPaymentPending(order.order_id, {
        provider:checkout.provider,
        providerCheckoutId:checkout.checkoutId,
        paymentDueAt:checkout.paymentDueAt || null,
        paymentResumeData,
      });
    });
    if (!pendingOrder) throw new ConsultationDomainError('ORDER_CHECKOUT_UPDATE_FAILED', 500);
    return {
      orderId:pendingOrder.order_id,
      status:pendingOrder.status,
      provider:checkout.provider,
      checkoutId:checkout.checkoutId,
      amountMinor:pendingOrder.amount_minor,
      currency:pendingOrder.currency,
      durationMinutes:pendingOrder.duration_minutes,
      termsVersion:pendingOrder.terms_version,
      termsAcceptedAt:pendingOrder.terms_accepted_at,
      paymentInstructions:paymentResumeData,
      resumed:false,
    };
  }

  return { prepareCheckout };
}

module.exports = { safePaymentResumeData,createConsultationCheckoutService };
