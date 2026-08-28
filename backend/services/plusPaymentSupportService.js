const { createPlusPaymentRepository } = require('./plusPaymentRepository');
const { PlusPaymentError } = require('../domain/plusPayment');

const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;

function maskActor(value) {
  const text = typeof value === 'string' ? value : '';
  return text.length >= 8 ? `${text.slice(0, 4)}…${text.slice(-4)}` : 'ไม่ระบุ';
}

function createPlusPaymentSupportService({ repository = createPlusPaymentRepository() } = {}) {
  async function lookup({ reference } = {}) {
    const safeReference = typeof reference === 'string' ? reference.trim() : '';
    if (!REFERENCE_PATTERN.test(safeReference)) throw new PlusPaymentError('INVALID_PAYMENT_REFERENCE');
    const row = await repository.findSupportRecord(safeReference);
    if (!row) throw new PlusPaymentError('PLUS_PAYMENT_NOT_FOUND', 404);
    return Object.freeze({
      paymentReference: row.order_id,
      subjectReference: maskActor(row.subject_line_user_id),
      planId: row.plan_id,
      amountMinor: row.amount_minor,
      currency: row.currency,
      orderStatus: row.status,
      fulfillmentStatus: row.fulfillment_status,
      paidAt: row.paid_at || null,
      entitlementStartAt: row.entitlement_start_at || null,
      entitlementEndAt: row.entitlement_end_at || null,
      paymentProcessingStatus: row.processing_status || null,
      paymentFailureCode: row.failure_code || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  return { lookup };
}

module.exports = { REFERENCE_PATTERN, maskActor, createPlusPaymentSupportService };
