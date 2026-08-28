const { randomUUID } = require('node:crypto');
const { withTransaction } = require('../db');
const { createPlusPaymentRepository } = require('./plusPaymentRepository');
const {
  PLUS_PLAN_ID, PLUS_PRICE_MINOR, PLUS_CURRENCY, PLUS_DURATION_DAYS,
  PlusPaymentError, assertFixedPlusPurchase, addEntitlementDays,
} = require('../domain/plusPayment');

const PAID_PLUS_FEATURES = Object.freeze([
  'care_profile_summary', 'medication_summary', 'appointment_summary',
  'doctor_visit_preparation', 'ai_explanation', 'medication_diff',
]);

function createPlusPaymentEntitlementService({
  repository = createPlusPaymentRepository(),
  transaction = withTransaction,
  entitlementId = (orderId) => `PLUSENT-${orderId}-${randomUUID().slice(0, 8)}`,
} = {}) {
  async function grantVerifiedPayment(event = {}) {
    assertFixedPlusPurchase({
      planId: PLUS_PLAN_ID, amountMinor: event.amountMinor, currency: event.currency,
    });
    if (event.verified !== true || event.signatureVerified !== true) {
      throw new PlusPaymentError('PAYMENT_NOT_VERIFIED', 403);
    }
    const paidAt = new Date(event.paidAt);
    if (Number.isNaN(paidAt.getTime())) throw new PlusPaymentError('INVALID_PAYMENT_TIME');

    return transaction(`plus-payment:${event.orderId}`, async () => {
      let order = await repository.findOrderForUpdate(event.orderId);
      if (!order) throw new PlusPaymentError('PLUS_ORDER_NOT_FOUND', 404);
      assertFixedPlusPurchase({ planId: order.plan_id, amountMinor: order.amount_minor, currency: order.currency });
      if (order.provider && order.provider !== event.provider) throw new PlusPaymentError('PAYMENT_PROVIDER_MISMATCH', 409);
      if (order.provider_checkout_id && order.provider_checkout_id !== event.providerCheckoutId) {
        throw new PlusPaymentError('PAYMENT_CHECKOUT_MISMATCH', 409);
      }
      if (order.fulfillment_status === 'granted') {
        const existing = await repository.findEntitlementBySourceOrder(order.order_id);
        return { order, entitlement: existing, duplicate: true };
      }
      order = await repository.markPaid(order.order_id, paidAt.toISOString());
      const current = await repository.findLatestEntitlementForUpdate(order.subject_line_user_id);
      const currentEnd = current ? new Date(current.expires_at) : null;
      const startsAt = currentEnd && !Number.isNaN(currentEnd.getTime()) && currentEnd > paidAt
        ? currentEnd : paidAt;
      const endsAt = addEntitlementDays(startsAt, PLUS_DURATION_DAYS);
      const result = await repository.createPaymentEntitlement({
        entitlement_id: entitlementId(order.order_id),
        subject_id: order.subject_line_user_id,
        starts_at: startsAt.toISOString(),
        expires_at: endsAt.toISOString(),
        features: PAID_PLUS_FEATURES,
        note: `${PLUS_PLAN_ID}: manual renewal; no automatic charge`,
        source_order_id: order.order_id,
      });
      if (!result.entitlement) throw new PlusPaymentError('ENTITLEMENT_CREATION_FAILED', 500);
      order = await repository.markFulfilled(order.order_id, result.entitlement);
      return { order, entitlement: result.entitlement, duplicate: !result.created };
    });
  }

  return { grantVerifiedPayment };
}

module.exports = { PAID_PLUS_FEATURES, createPlusPaymentEntitlementService };
