const { randomUUID } = require('node:crypto');
const { withTransaction } = require('../db');
const { loadFeatureFlags } = require('../config/featureFlags');
const { createConsultationPaymentProvider } = require('../providers/consultationPaymentProviderFactory');
const { safePaymentResumeData } = require('./consultationCheckoutService');
const { createPlusPaymentRepository } = require('./plusPaymentRepository');
const { getPlusEntitlement } = require('./plusEntitlementService');
const {
  PLUS_PLAN_ID, PLUS_PRICE_MINOR, PLUS_CURRENCY, PLUS_DURATION_MINUTES,
  PlusPaymentError, normalizeReturnTarget, normalizeIdempotencyKey,
} = require('../domain/plusPayment');

function paymentAvailable(flags) {
  return flags?.plus?.enabled === true
    && flags.plus.paymentEnabled === true
    && flags.plus.internalEntitlementOnly !== true;
}

function orderStatus(order) {
  if (!order) return null;
  if (order.status === 'draft') return 'checkout_preparing';
  if (order.status === 'payment_pending') return 'payment_pending';
  if (order.status === 'paid' && order.fulfillment_status !== 'granted') return 'payment_confirming';
  if (order.status === 'paid' && order.fulfillment_status === 'granted') return 'active';
  return order.status;
}

function projectOrder(order) {
  if (!order) return null;
  const status = orderStatus(order);
  return Object.freeze({
    orderId: order.order_id,
    planId: PLUS_PLAN_ID,
    amountMinor: PLUS_PRICE_MINOR,
    currency: PLUS_CURRENCY,
    status,
    returnTarget: order.return_target,
    payment: status === 'payment_pending' ? safePaymentResumeData(order.payment_resume_data) : null,
    paidAt: order.paid_at || null,
    entitlementStartAt: order.entitlement_start_at || null,
    entitlementEndAt: order.entitlement_end_at || null,
    createdAt: order.created_at || null,
  });
}

function createPlusPaymentOrderService({
  repository = createPlusPaymentRepository(),
  transaction = withTransaction,
  providerFactory = createConsultationPaymentProvider,
  entitlementGetter = getPlusEntitlement,
  flagsLoader = loadFeatureFlags,
  orderId = () => `PLUSORD-${randomUUID()}`,
} = {}) {
  async function createCheckout({ lineUserId, returnTarget, idempotencyKey, renew = false } = {}) {
    if (typeof lineUserId !== 'string' || !lineUserId.trim()) throw new PlusPaymentError('UNAUTHENTICATED', 401);
    const target = normalizeReturnTarget(returnTarget);
    const key = normalizeIdempotencyKey(idempotencyKey);
    const flags = flagsLoader();
    if (!paymentAvailable(flags)) throw new PlusPaymentError('PLUS_PAYMENT_DISABLED', 503);
    const entitlement = await entitlementGetter({ lineUserId, flags });
    if (entitlement.allowed && renew !== true) throw new PlusPaymentError('PLUS_ALREADY_ACTIVE', 409);

    const draft = await transaction(`plus-checkout:${lineUserId}`, async () => {
      const existing = await repository.findActiveOrderForUpdate(lineUserId);
      if (existing) return { ...existing, checkout_reused: true };
      const inserted = await repository.createOrder({
        order_id: orderId(), subject_line_user_id: lineUserId,
        plan_id: PLUS_PLAN_ID, amount_minor: PLUS_PRICE_MINOR, currency: PLUS_CURRENCY,
        return_target: target, idempotency_key: key,
      });
      if (inserted) return { ...inserted, checkout_reused: false };
      const winner = await repository.findActiveOrderForUpdate(lineUserId);
      if (!winner) throw new PlusPaymentError('PLUS_CHECKOUT_CONFLICT', 409);
      return { ...winner, checkout_reused: true };
    });

    if (draft.checkout_reused) return { ...projectOrder(draft), resumed: true };
    const provider = providerFactory();
    let checkout;
    try {
      checkout = await provider.createCheckout({
        orderId: draft.order_id,
        amountMinor: PLUS_PRICE_MINOR,
        currency: PLUS_CURRENCY,
        durationMinutes: PLUS_DURATION_MINUTES,
        purpose: 'phimor_plus',
      });
    } catch (error) {
      await transaction(`plus-checkout:${draft.order_id}`, () => repository.markPaymentFailed(draft.order_id));
      throw error;
    }
    const resumeData = safePaymentResumeData(checkout?.paymentInstructions);
    if (!checkout?.checkoutId || !resumeData) {
      await transaction(`plus-checkout:${draft.order_id}`, () => repository.markPaymentFailed(draft.order_id));
      throw new PlusPaymentError('INVALID_PROVIDER_CHECKOUT', 502);
    }
    const pending = await transaction(`plus-checkout:${draft.order_id}`, async () => {
      const locked = await repository.findOrderForUpdate(draft.order_id);
      if (!locked) throw new PlusPaymentError('PLUS_ORDER_NOT_FOUND', 404);
      if (locked.plan_id !== PLUS_PLAN_ID || locked.amount_minor !== PLUS_PRICE_MINOR
          || locked.currency !== PLUS_CURRENCY) throw new PlusPaymentError('PLUS_ORDER_SNAPSHOT_MISMATCH', 409);
      return repository.markPaymentPending(draft.order_id, {
        provider: checkout.provider,
        providerCheckoutId: checkout.checkoutId,
        paymentDueAt: checkout.paymentDueAt || null,
        paymentResumeData: resumeData,
      });
    });
    if (!pending) throw new PlusPaymentError('PLUS_CHECKOUT_UPDATE_FAILED', 500);
    return { ...projectOrder(pending), resumed: false };
  }

  async function getCurrent({ lineUserId } = {}) {
    const order = await repository.findCurrentOrder(lineUserId);
    return { status: order ? 'found' : 'none', order: projectOrder(order) };
  }

  async function getStatus({ lineUserId, orderId: requestedOrderId } = {}) {
    const order = await repository.findOrder(requestedOrderId);
    if (!order || order.subject_line_user_id !== lineUserId) throw new PlusPaymentError('PLUS_ORDER_NOT_FOUND', 404);
    return projectOrder(order);
  }

  async function getHistory({ lineUserId, limit = 20, before = null } = {}) {
    const bounded = Math.min(50, Math.max(1, Number(limit) || 20));
    const rows = await repository.listHistory(lineUserId, { limit: bounded, before });
    const hasMore = rows.length > bounded;
    const visible = rows.slice(0, bounded).map((row) => projectOrder(row));
    return {
      orders: visible,
      nextCursor: hasMore ? visible[visible.length - 1]?.createdAt || null : null,
    };
  }

  return { createCheckout, getCurrent, getStatus, getHistory };
}

module.exports = { paymentAvailable, orderStatus, projectOrder, createPlusPaymentOrderService };
