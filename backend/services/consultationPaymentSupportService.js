const { createConsultationRepository } = require('./consultationRepository');
const { ConsultationDomainError } = require('../domain/consultation');

const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;

function normalizePaymentReference(value) {
  const reference = typeof value === 'string' ? value.trim() : '';
  if (!PAYMENT_REFERENCE_PATTERN.test(reference)) {
    throw new ConsultationDomainError('INVALID_PAYMENT_REFERENCE', 400);
  }
  return reference;
}

function projectPaymentSupportRecord(row) {
  if (!row) return null;
  return Object.freeze({
    paymentReference:row.order_id,
    caseId:row.case_id || null,
    orderStatus:row.order_status,
    provisioningStatus:row.provisioning_status,
    caseState:row.case_state || null,
    amountMinor:Number(row.amount_minor),
    currency:row.currency,
    provider:row.provider || null,
    providerChargeId:row.provider_payment_id || row.provider_checkout_id || null,
    providerEventId:row.provider_event_id || null,
    paymentProcessingStatus:row.payment_processing_status || null,
    paymentFailureCode:row.payment_failure_code || null,
    createdAt:row.created_at,
    paymentDueAt:row.payment_due_at || null,
    paidAt:row.paid_at || null,
    paymentReceivedAt:row.payment_received_at || null,
    paymentProcessedAt:row.payment_processed_at || null,
    queuedAt:row.queued_at || null,
    acceptedAt:row.accepted_at || null,
    expiresAt:row.expires_at || null,
    closedAt:row.closed_at || null,
    closeReason:row.close_reason || null,
  });
}

function createConsultationPaymentSupportService({
  repository = createConsultationRepository(),
} = {}) {
  async function lookup({ reference } = {}) {
    const normalized = normalizePaymentReference(reference);
    const row = await repository.findPaymentSupportRecord(normalized);
    if (!row) throw new ConsultationDomainError('PAYMENT_REFERENCE_NOT_FOUND', 404);
    return projectPaymentSupportRecord(row);
  }

  return { lookup };
}

module.exports = {
  PAYMENT_REFERENCE_PATTERN,
  normalizePaymentReference,
  projectPaymentSupportRecord,
  createConsultationPaymentSupportService,
};
