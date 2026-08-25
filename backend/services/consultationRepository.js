const { databaseQuery } = require('../db');
const { assertWaitingOnInvariant } = require('../domain/consultation');

function createConsultationRepository({ queryFn = databaseQuery } = {}) {
  return {
    async createOrder(record) {
      const result = await queryFn(
        `INSERT INTO consultation_orders (
          order_id, customer_line_user_id, care_profile_id, initial_question,
          amount_minor, currency, duration_minutes, terms_version,
          terms_accepted_at, status, provisioning_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', 'pending')
        RETURNING *`,
        [
          record.order_id, record.customer_line_user_id, record.care_profile_id,
          record.initial_question, record.amount_minor, record.currency,
          record.duration_minutes, record.terms_version, record.terms_accepted_at,
        ]
      );
      return result.rows[0];
    },

    async findOrderForUpdate(orderId) {
      const result = await queryFn('SELECT * FROM consultation_orders WHERE order_id = $1 FOR UPDATE', [orderId]);
      return result.rows[0] || null;
    },

    async insertPaymentTransaction(record) {
      const inserted = await queryFn(
        `INSERT INTO payment_transactions (
          payment_transaction_id, order_id, provider, provider_event_id,
          provider_payment_id, event_type, processing_status, amount_minor,
          currency, signature_verified, payload_hash, received_at, attempts
        ) VALUES ($1, $2, $3, $4, $5, $6, 'verified', $7, $8, TRUE, $9, CURRENT_TIMESTAMP, 1)
        ON CONFLICT (provider, provider_event_id) DO NOTHING
        RETURNING *`,
        [
          record.payment_transaction_id, record.order_id, record.provider,
          record.provider_event_id, record.provider_payment_id, record.event_type,
          record.amount_minor, record.currency, record.payload_hash,
        ]
      );
      if (inserted.rows[0]) return { transaction: inserted.rows[0], duplicate: false };
      const existing = await queryFn(
        'SELECT * FROM payment_transactions WHERE provider = $1 AND provider_event_id = $2',
        [record.provider, record.provider_event_id]
      );
      return { transaction: existing.rows[0] || null, duplicate: true };
    },

    async updatePaymentTransaction(paymentTransactionId, patch) {
      const result = await queryFn(
        `UPDATE payment_transactions SET
          processing_status = COALESCE($2, processing_status),
          processed_at = COALESCE($3, processed_at),
          failure_code = $4,
          attempts = attempts + 1
        WHERE payment_transaction_id = $1
        RETURNING *`,
        [paymentTransactionId, patch.processing_status || null, patch.processed_at || null, patch.failure_code || null]
      );
      return result.rows[0] || null;
    },

    async markOrderPaid(orderId, paidAt) {
      const result = await queryFn(
        `UPDATE consultation_orders SET
          status = 'paid', paid_at = $2, provisioning_status = 'pending',
          updated_at = CURRENT_TIMESTAMP
        WHERE order_id = $1
        RETURNING *`,
        [orderId, paidAt]
      );
      return result.rows[0] || null;
    },

    async markOrderProvisioned(orderId) {
      const result = await queryFn(
        `UPDATE consultation_orders SET provisioning_status = 'provisioned', updated_at = CURRENT_TIMESTAMP
         WHERE order_id = $1 RETURNING *`,
        [orderId]
      );
      return result.rows[0] || null;
    },

    async findCaseByOrderId(orderId) {
      const result = await queryFn('SELECT * FROM consultation_cases WHERE order_id = $1', [orderId]);
      return result.rows[0] || null;
    },

    async createQueuedCase(record) {
      const result = await queryFn(
        `INSERT INTO consultation_cases (
          case_id, order_id, care_profile_id, customer_line_user_id,
          state, waiting_on, queued_at
        ) VALUES ($1, $2, $3, $4, 'queued', 'none', CURRENT_TIMESTAMP)
        ON CONFLICT (order_id) DO NOTHING
        RETURNING *, CURRENT_TIMESTAMP AS database_now`,
        [record.case_id, record.order_id, record.care_profile_id, record.customer_line_user_id]
      );
      if (result.rows[0]) return { consultationCase: result.rows[0], created: true };
      return { consultationCase: await this.findCaseByOrderId(record.order_id), created: false };
    },

    async insertEvent(record) {
      const result = await queryFn(
        `INSERT INTO consultation_events (
          event_id, case_id, event_type, actor_type, actor_id,
          from_state, to_state, metadata, idempotency_key, occurred_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, CURRENT_TIMESTAMP)
        ON CONFLICT (case_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING *`,
        [
          record.event_id, record.case_id, record.event_type, record.actor_type,
          record.actor_id || null, record.from_state || null, record.to_state || null,
          JSON.stringify(record.metadata || {}), record.idempotency_key || null,
        ]
      );
      return result.rows[0] || null;
    },

    async findPharmacistByLineUserId(lineUserId) {
      const result = await queryFn(
        `SELECT pharmacist_id, line_user_id, display_name, license_number,
                license_verified_at, status, created_at, updated_at
         FROM pharmacist_accounts WHERE line_user_id = $1`,
        [lineUserId]
      );
      return result.rows[0] || null;
    },

    async findCaseForUpdate(caseId) {
      const result = await queryFn(
        `SELECT c.*, o.status AS order_status, o.provisioning_status,
                CURRENT_TIMESTAMP AS database_now
         FROM consultation_cases c
         JOIN consultation_orders o ON o.order_id = c.order_id
         WHERE c.case_id = $1
         FOR UPDATE OF c`,
        [caseId]
      );
      return result.rows[0] || null;
    },

    async findCaseForRead(caseId) {
      const result = await queryFn(
        `SELECT c.*, o.initial_question, o.status AS order_status,
                o.provisioning_status, CURRENT_TIMESTAMP AS database_now
         FROM consultation_cases c
         JOIN consultation_orders o ON o.order_id = c.order_id
         WHERE c.case_id = $1`,
        [caseId]
      );
      return result.rows[0] || null;
    },

    async listCasesForCustomer(lineUserId) {
      const result = await queryFn(
        `SELECT c.*, o.initial_question, CURRENT_TIMESTAMP AS database_now
         FROM consultation_cases c
         JOIN consultation_orders o ON o.order_id = c.order_id
         WHERE c.customer_line_user_id = $1
           AND o.status = 'paid' AND o.provisioning_status = 'provisioned'
         ORDER BY c.created_at DESC, c.case_id DESC`,
        [lineUserId]
      );
      return result.rows;
    },

    async listQueuedCases() {
      const result = await queryFn(
        `SELECT c.*, o.initial_question, CURRENT_TIMESTAMP AS database_now
         FROM consultation_cases c
         JOIN consultation_orders o ON o.order_id = c.order_id
         WHERE c.state = 'queued'
           AND o.status = 'paid' AND o.provisioning_status = 'provisioned'
         ORDER BY c.queued_at, c.case_id`
      );
      return result.rows;
    },

    async listActiveCasesForPharmacist(pharmacistId) {
      const result = await queryFn(
        `SELECT c.*, o.initial_question, CURRENT_TIMESTAMP AS database_now
         FROM consultation_cases c
         JOIN consultation_orders o ON o.order_id = c.order_id
         WHERE c.assigned_pharmacist_id = $1 AND c.state IN ('active', 'resolved')
           AND o.status = 'paid' AND o.provisioning_status = 'provisioned'
         ORDER BY c.updated_at DESC, c.case_id DESC`,
        [pharmacistId]
      );
      return result.rows;
    },

    async listMessages(caseId, { afterSequence = 0, limit = 21 } = {}) {
      const result = await queryFn(
        `SELECT message_id, case_id, message_sequence, sender_type, sender_id, body, created_at
         FROM consultation_messages
         WHERE case_id = $1 AND message_sequence > $2
         ORDER BY message_sequence
         LIMIT $3`,
        [caseId, afterSequence, limit]
      );
      return result.rows;
    },

    async acceptCase(caseId, pharmacistId) {
      const result = await queryFn(
        `UPDATE consultation_cases SET
          state = 'active', waiting_on = 'pharmacist',
          assigned_pharmacist_id = $2,
          accepted_at = CURRENT_TIMESTAMP,
          expires_at = CURRENT_TIMESTAMP + INTERVAL '24 hours',
          updated_at = CURRENT_TIMESTAMP
        WHERE case_id = $1 AND state = 'queued' AND assigned_pharmacist_id IS NULL
        RETURNING *, CURRENT_TIMESTAMP AS database_now`,
        [caseId, pharmacistId]
      );
      return result.rows[0] || null;
    },

    async updateCaseWorkflow(caseId, { state, waitingOn, closedAt = null, closeReason = null }) {
      assertWaitingOnInvariant(state, waitingOn);
      const result = await queryFn(
        `UPDATE consultation_cases SET
          state = $2, waiting_on = $3,
          resolved_at = CASE WHEN $2 = 'resolved' THEN CURRENT_TIMESTAMP ELSE resolved_at END,
          closed_at = COALESCE($4, closed_at), close_reason = COALESCE($5, close_reason),
          updated_at = CURRENT_TIMESTAMP
        WHERE case_id = $1
        RETURNING *, CURRENT_TIMESTAMP AS database_now`,
        [caseId, state, waitingOn, closedAt, closeReason]
      );
      return result.rows[0] || null;
    },

    async findMessageByIdempotency(caseId, idempotencyKey) {
      const result = await queryFn(
        'SELECT * FROM consultation_messages WHERE case_id = $1 AND idempotency_key = $2',
        [caseId, idempotencyKey]
      );
      return result.rows[0] || null;
    },

    async insertMessage(record) {
      const result = await queryFn(
        `INSERT INTO consultation_messages (
          message_id, case_id, sender_type, sender_id, body, idempotency_key
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (case_id, idempotency_key) DO NOTHING
        RETURNING *`,
        [
          record.message_id, record.case_id, record.sender_type,
          record.sender_id || null, record.body, record.idempotency_key,
        ]
      );
      if (result.rows[0]) return { message: result.rows[0], duplicate: false };
      return { message: await this.findMessageByIdempotency(record.case_id, record.idempotency_key), duplicate: true };
    },
  };
}

module.exports = { createConsultationRepository };
