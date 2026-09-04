const { databaseQuery } = require('../db');
const PLUS_RECONCILIATION_MAX_ATTEMPTS = 12;

function createPlusPaymentRepository({ queryFn = databaseQuery } = {}) {
  return {
    async getHealth() {
      try {
        const result = await queryFn(`SELECT
          to_regclass('public.plus_orders') AS orders_table,
          to_regclass('public.plus_payment_transactions') AS transactions_table`);
        const row = result.rows?.[0] || {};
        return {
          available: Boolean(row.orders_table && row.transactions_table),
          configured: true,
        };
      } catch (_) {
        return { available: false, configured: true };
      }
    },

    async findActiveOrderForUpdate(subjectLineUserId) {
      const result = await queryFn(
        `SELECT * FROM plus_orders
         WHERE subject_line_user_id = $1
           AND (status IN ('draft', 'payment_pending')
             OR (status = 'paid' AND fulfillment_status <> 'granted'))
         ORDER BY created_at DESC, order_id DESC
         LIMIT 1 FOR UPDATE`,
        [subjectLineUserId]
      );
      return result.rows[0] || null;
    },

    async findCurrentOrder(subjectLineUserId) {
      const result = await queryFn(
        `SELECT *, CURRENT_TIMESTAMP AS database_now FROM plus_orders
         WHERE subject_line_user_id = $1
           AND (status IN ('draft', 'payment_pending')
             OR (status = 'paid' AND fulfillment_status <> 'granted'))
         ORDER BY created_at DESC, order_id DESC LIMIT 1`,
        [subjectLineUserId]
      );
      return result.rows[0] || null;
    },

    async findLatestOrder(subjectLineUserId) {
      const result = await queryFn(
        `SELECT *, CURRENT_TIMESTAMP AS database_now FROM plus_orders
         WHERE subject_line_user_id = $1
         ORDER BY created_at DESC, order_id DESC LIMIT 1`,
        [subjectLineUserId]
      );
      return result.rows[0] || null;
    },

    async createOrder(record) {
      const result = await queryFn(
        `INSERT INTO plus_orders (
          order_id, subject_line_user_id, plan_id, amount_minor, currency,
          return_target, idempotency_key, status, fulfillment_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', 'pending')
        ON CONFLICT DO NOTHING RETURNING *`,
        [record.order_id, record.subject_line_user_id, record.plan_id,
          record.amount_minor, record.currency, record.return_target, record.idempotency_key]
      );
      return result.rows[0] || null;
    },

    async findOrder(orderId) {
      const result = await queryFn(
        'SELECT *, CURRENT_TIMESTAMP AS database_now FROM plus_orders WHERE order_id = $1',
        [orderId]
      );
      return result.rows[0] || null;
    },

    async findOrderForUpdate(orderId) {
      const result = await queryFn('SELECT * FROM plus_orders WHERE order_id = $1 FOR UPDATE', [orderId]);
      return result.rows[0] || null;
    },

    async markPaymentPending(orderId, {
      provider, providerCheckoutId, paymentDueAt = null, paymentResumeData = null,
    }) {
      const result = await queryFn(
        `UPDATE plus_orders SET status = 'payment_pending', provider = $2,
          provider_checkout_id = $3, payment_due_at = $4, payment_resume_data = $5::jsonb,
          reconciliation_attempts = 0,
          reconciliation_next_attempt_at = CURRENT_TIMESTAMP + INTERVAL '2 minutes',
          reconciliation_last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE order_id = $1 AND status = 'draft' RETURNING *`,
        [orderId, provider, providerCheckoutId, paymentDueAt,
          paymentResumeData ? JSON.stringify(paymentResumeData) : null]
      );
      return result.rows[0] || null;
    },

    async markPaymentFailed(orderId) {
      const result = await queryFn(
        `UPDATE plus_orders SET status = 'failed', payment_resume_data = NULL,
          reconciliation_next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE order_id = $1 AND status <> 'paid' RETURNING *`,
        [orderId]
      );
      return result.rows[0] || null;
    },

    async markPaymentExpired(orderId) {
      const result = await queryFn(
        `UPDATE plus_orders SET status = 'expired', payment_resume_data = NULL,
          reconciliation_next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE order_id = $1 AND status IN ('draft', 'payment_pending') RETURNING *`,
        [orderId]
      );
      return result.rows[0] || null;
    },

    async markPaid(orderId, paidAt) {
      const result = await queryFn(
        `UPDATE plus_orders SET status = 'paid', paid_at = COALESCE(paid_at, $2),
          fulfillment_status = CASE WHEN fulfillment_status = 'granted' THEN 'granted' ELSE 'pending' END,
          payment_resume_data = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE order_id = $1 RETURNING *`,
        [orderId, paidAt]
      );
      return result.rows[0] || null;
    },

    async findLatestEntitlementForUpdate(subjectLineUserId) {
      const result = await queryFn(
        `SELECT * FROM plus_entitlements
         WHERE subject_type = 'line_user' AND subject_id = $1 AND plan_code = 'family_plus'
           AND status IN ('active', 'trial')
         ORDER BY expires_at DESC, entitlement_id DESC LIMIT 1 FOR UPDATE`,
        [subjectLineUserId]
      );
      return result.rows[0] || null;
    },

    async findEntitlementBySourceOrder(orderId) {
      const result = await queryFn(
        `SELECT * FROM plus_entitlements
         WHERE source_order_id = $1 LIMIT 1`,
        [orderId]
      );
      return result.rows[0] || null;
    },

    async createPaymentEntitlement(record) {
      const result = await queryFn(
        `INSERT INTO plus_entitlements (
          entitlement_id, subject_type, subject_id, plan_code, status,
          starts_at, expires_at, source, features, created_by, note, source_order_id
        ) VALUES ($1, 'line_user', $2, 'family_plus', 'active',
          $3, $4, 'payment', $5::text[], 'payment', $6, $7)
        ON CONFLICT (source_order_id) WHERE source_order_id IS NOT NULL DO NOTHING
        RETURNING *`,
        [record.entitlement_id, record.subject_id, record.starts_at, record.expires_at,
          record.features, record.note, record.source_order_id]
      );
      if (result.rows[0]) return { entitlement: result.rows[0], created: true };
      return { entitlement: await this.findEntitlementBySourceOrder(record.source_order_id), created: false };
    },

    async markFulfilled(orderId, entitlement) {
      const result = await queryFn(
        `UPDATE plus_orders SET fulfillment_status = 'granted', entitlement_id = $2,
          entitlement_start_at = $3, entitlement_end_at = $4,
          reconciliation_next_attempt_at = NULL, reconciliation_last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
         WHERE order_id = $1 AND status = 'paid' RETURNING *`,
        [orderId, entitlement.entitlement_id, entitlement.starts_at, entitlement.expires_at]
      );
      return result.rows[0] || null;
    },

    async ingestPaymentTransaction(record) {
      const inserted = await queryFn(
        `INSERT INTO plus_payment_transactions (
          payment_transaction_id, order_id, provider, provider_event_id,
          provider_payment_id, provider_checkout_id, event_type, processing_status,
          amount_minor, currency, signature_verified, payload_hash, provider_paid_at,
          received_at, failure_code, attempts
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'verified',$8,$9,TRUE,$10,$11,CURRENT_TIMESTAMP,$12,1)
        ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING *`,
        [record.payment_transaction_id, record.order_id, record.provider,
          record.provider_event_id, record.provider_payment_id, record.provider_checkout_id,
          record.event_type, record.amount_minor, record.currency, record.payload_hash,
          record.provider_paid_at, record.failure_code || null]
      );
      if (inserted.rows[0]) return { transaction: inserted.rows[0], duplicate: false };
      const existing = await queryFn(
        'SELECT * FROM plus_payment_transactions WHERE provider = $1 AND provider_event_id = $2',
        [record.provider, record.provider_event_id]
      );
      return { transaction: existing.rows[0] || null, duplicate: true };
    },

    async findLatestPaymentTransaction(orderId) {
      const result = await queryFn(
        `SELECT * FROM plus_payment_transactions WHERE order_id = $1
         ORDER BY received_at DESC, payment_transaction_id DESC LIMIT 1`,
        [orderId]
      );
      return result.rows[0] || null;
    },

    async findSuccessfulPaymentTransaction(orderId) {
      const result = await queryFn(
        `SELECT * FROM plus_payment_transactions WHERE order_id = $1
           AND event_type = 'payment_succeeded' AND processing_status = 'processed'
         ORDER BY received_at DESC, payment_transaction_id DESC LIMIT 1`,
        [orderId]
      );
      return result.rows[0] || null;
    },

    async updatePaymentTransaction(paymentTransactionId, { status, failureCode = null }) {
      const result = await queryFn(
        `UPDATE plus_payment_transactions SET processing_status = $2::varchar,
          failure_code = $3, processed_at = CASE WHEN $2::varchar IN ('processed','rejected')
            THEN CURRENT_TIMESTAMP ELSE NULL END, attempts = attempts + 1
         WHERE payment_transaction_id = $1 RETURNING *`,
        [paymentTransactionId, status, failureCode]
      );
      return result.rows[0] || null;
    },

    async listOrdersDueForReconciliation(limit = 25) {
      const result = await queryFn(
        `SELECT order_id FROM plus_orders
         WHERE (status = 'payment_pending'
             OR (status = 'paid' AND fulfillment_status <> 'granted'))
           AND COALESCE(reconciliation_next_attempt_at, updated_at) <= CURRENT_TIMESTAMP
           AND reconciliation_attempts < $2
         ORDER BY COALESCE(reconciliation_next_attempt_at, updated_at), order_id LIMIT $1`,
        [limit, PLUS_RECONCILIATION_MAX_ATTEMPTS]
      );
      return result.rows.map((row) => row.order_id);
    },

    async markReconciliationAttempt(orderId, { nextAttemptAt }) {
      const result = await queryFn(
        `UPDATE plus_orders SET reconciliation_attempts = reconciliation_attempts + 1,
          reconciliation_next_attempt_at = $2, updated_at = CURRENT_TIMESTAMP
         WHERE order_id = $1 AND (status = 'payment_pending'
           OR (status = 'paid' AND fulfillment_status <> 'granted'))
           AND reconciliation_attempts < $3 RETURNING *`,
        [orderId, nextAttemptAt, PLUS_RECONCILIATION_MAX_ATTEMPTS]
      );
      return result.rows[0] || null;
    },

    async finishReconciliation(orderId, { nextAttemptAt = null, errorCode = null }) {
      const result = await queryFn(
        `UPDATE plus_orders SET reconciliation_next_attempt_at = $2,
          reconciliation_last_error = $3, updated_at = CURRENT_TIMESTAMP
         WHERE order_id = $1 RETURNING *`,
        [orderId, nextAttemptAt, errorCode]
      );
      return result.rows[0] || null;
    },

    async listHistory(subjectLineUserId, { limit = 20, before = null } = {}) {
      const result = await queryFn(
        `SELECT order_id, plan_id, amount_minor, currency, status, paid_at,
                fulfillment_status, entitlement_start_at, entitlement_end_at, created_at
         FROM plus_orders WHERE subject_line_user_id = $1
           AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
         ORDER BY created_at DESC, order_id DESC LIMIT $3`,
        [subjectLineUserId, before, limit + 1]
      );
      return result.rows;
    },

    async findSupportRecord(reference) {
      const result = await queryFn(
        `SELECT o.order_id, o.subject_line_user_id, o.plan_id, o.amount_minor, o.currency,
                o.status, o.fulfillment_status, o.paid_at, o.entitlement_start_at,
                o.entitlement_end_at, o.created_at, o.updated_at,
                t.processing_status, t.failure_code, t.received_at, t.processed_at
         FROM plus_orders o
         LEFT JOIN LATERAL (
           SELECT processing_status, failure_code, received_at, processed_at
           FROM plus_payment_transactions WHERE order_id = o.order_id
           ORDER BY received_at DESC, payment_transaction_id DESC LIMIT 1
         ) t ON TRUE
         WHERE o.order_id = $1 OR o.provider_checkout_id = $1
           OR EXISTS (SELECT 1 FROM plus_payment_transactions p
             WHERE p.order_id = o.order_id
               AND (p.provider_payment_id = $1 OR p.provider_event_id = $1))
         ORDER BY o.created_at DESC LIMIT 1`,
        [reference]
      );
      return result.rows[0] || null;
    },
  };
}

module.exports = { PLUS_RECONCILIATION_MAX_ATTEMPTS, createPlusPaymentRepository };
