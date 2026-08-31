const { databaseQuery } = require('../db');
const { assertWaitingOnInvariant } = require('../domain/consultation');

const UPDATE_CASE_WORKFLOW_SQL = `UPDATE consultation_cases SET
  state = $2::varchar, waiting_on = $3,
  resolved_at = CASE WHEN $2::varchar = 'resolved' THEN CURRENT_TIMESTAMP ELSE resolved_at END,
  closed_at = COALESCE($4, closed_at), close_reason = COALESCE($5, close_reason),
  updated_at = CURRENT_TIMESTAMP
WHERE case_id = $1
RETURNING *, CURRENT_TIMESTAMP AS database_now`;

function createConsultationRepository({ queryFn = databaseQuery } = {}) {
  return {
    async createOrder(record) {
      const result = await queryFn(
        `INSERT INTO consultation_orders (
          order_id, customer_line_user_id, care_profile_id, initial_question,
          amount_minor, currency, duration_minutes, terms_version,
          terms_accepted_at, status, provisioning_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', 'pending')
        ON CONFLICT DO NOTHING
        RETURNING *`,
        [
          record.order_id, record.customer_line_user_id, record.care_profile_id,
          record.initial_question, record.amount_minor, record.currency,
          record.duration_minutes, record.terms_version, record.terms_accepted_at,
        ]
      );
      return result.rows[0] || null;
    },

    async findActiveCheckoutForUpdate(customerLineUserId, careProfileId) {
      const result = await queryFn(
        `SELECT * FROM consultation_orders
         WHERE customer_line_user_id = $1 AND care_profile_id = $2
           AND (status IN ('draft', 'payment_pending')
             OR (status = 'paid' AND provisioning_status <> 'provisioned'))
         ORDER BY created_at DESC, order_id DESC
         LIMIT 1
         FOR UPDATE`,
        [customerLineUserId, careProfileId]
      );
      return result.rows[0] || null;
    },

    async findCurrentCheckout(customerLineUserId, careProfileId) {
      const result = await queryFn(
        `SELECT o.*, c.case_id, c.state AS case_state, c.accepted_at, c.expires_at,
                c.closed_at, c.close_reason, CURRENT_TIMESTAMP AS database_now
         FROM consultation_orders o
         LEFT JOIN consultation_cases c ON c.order_id = o.order_id
         WHERE o.customer_line_user_id = $1 AND o.care_profile_id = $2
           AND (o.status IN ('draft', 'payment_pending')
             OR (o.status = 'paid' AND o.provisioning_status <> 'provisioned'))
         ORDER BY o.created_at DESC, o.order_id DESC
         LIMIT 1`,
        [customerLineUserId, careProfileId]
      );
      return result.rows[0] || null;
    },

    async findOrderForUpdate(orderId) {
      const result = await queryFn('SELECT * FROM consultation_orders WHERE order_id = $1 FOR UPDATE', [orderId]);
      return result.rows[0] || null;
    },

    async findOrder(orderId) {
      const result = await queryFn(
        'SELECT *, CURRENT_TIMESTAMP AS database_now FROM consultation_orders WHERE order_id = $1',
        [orderId]
      );
      return result.rows[0] || null;
    },

    async markOrderPaymentPending(orderId, {
      provider, providerCheckoutId, paymentDueAt = null, paymentResumeData = null,
    }) {
      const result = await queryFn(
        `UPDATE consultation_orders SET
          status = 'payment_pending', provider = $2, provider_checkout_id = $3,
          payment_due_at = $4, payment_resume_data = $5::jsonb,
          reconciliation_attempts = 0,
          reconciliation_next_attempt_at = CURRENT_TIMESTAMP + INTERVAL '2 minutes',
          reconciliation_last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
         WHERE order_id = $1 AND status <> 'paid'
         RETURNING *`,
        [orderId, provider, providerCheckoutId, paymentDueAt,
          paymentResumeData ? JSON.stringify(paymentResumeData) : null]
      );
      return result.rows[0] || null;
    },

    async markOrderPaymentFailed(orderId) {
      const result = await queryFn(
        `UPDATE consultation_orders SET status = 'failed', payment_resume_data = NULL,
          reconciliation_next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE order_id = $1 AND status <> 'paid'
         RETURNING *`,
        [orderId]
      );
      return result.rows[0] || null;
    },

    async ingestPaymentTransaction(record) {
      const inserted = await queryFn(
        `INSERT INTO payment_transactions (
          payment_transaction_id, order_id, provider, provider_event_id,
          provider_payment_id, provider_checkout_id, event_type, processing_status, amount_minor,
          currency, signature_verified, payload_hash, provider_paid_at,
          received_at, attempts
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                  CURRENT_TIMESTAMP, 0)
        ON CONFLICT (provider, provider_event_id) DO NOTHING
        RETURNING *`,
        [
          record.payment_transaction_id, record.order_id, record.provider,
          record.provider_event_id, record.provider_payment_id, record.provider_checkout_id,
          record.event_type, record.processing_status, record.amount_minor,
          record.currency, record.signature_verified, record.payload_hash,
          record.provider_paid_at,
        ]
      );
      if (inserted.rows[0]) return { transaction:inserted.rows[0], duplicate:false };
      const existing = await queryFn(
        'SELECT * FROM payment_transactions WHERE provider = $1 AND provider_event_id = $2',
        [record.provider, record.provider_event_id]
      );
      return { transaction:existing.rows[0] || null, duplicate:true };
    },

    async findPaymentTransaction(provider, providerEventId) {
      const result = await queryFn(
        'SELECT * FROM payment_transactions WHERE provider = $1 AND provider_event_id = $2',
        [provider, providerEventId]
      );
      return result.rows[0] || null;
    },

    async findLatestPaymentTransactionForOrder(orderId) {
      const result = await queryFn(
        `SELECT * FROM payment_transactions
         WHERE order_id = $1
         ORDER BY received_at DESC, payment_transaction_id DESC
         LIMIT 1`,
        [orderId]
      );
      return result.rows[0] || null;
    },

    async markPaymentTransactionVerified(paymentTransactionId) {
      const result = await queryFn(
        `UPDATE payment_transactions SET
          signature_verified = TRUE, processing_status = 'verified',
          processed_at = NULL, failure_code = NULL, attempts = attempts + 1
         WHERE payment_transaction_id = $1
         RETURNING *`,
        [paymentTransactionId]
      );
      return result.rows[0] || null;
    },

    async insertPaymentTransaction(record) {
      const inserted = await queryFn(
        `INSERT INTO payment_transactions (
          payment_transaction_id, order_id, provider, provider_event_id,
          provider_payment_id, provider_checkout_id, event_type, processing_status, amount_minor,
          currency, signature_verified, payload_hash, provider_paid_at,
          received_at, attempts
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'verified', $8, $9, TRUE, $10, $11, CURRENT_TIMESTAMP, 1)
        ON CONFLICT (provider, provider_event_id) DO NOTHING
        RETURNING *`,
        [
          record.payment_transaction_id, record.order_id, record.provider,
          record.provider_event_id, record.provider_payment_id, record.provider_checkout_id,
          record.event_type,
          record.amount_minor, record.currency, record.payload_hash, record.provider_paid_at || null,
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

    async findPharmacistById(pharmacistId) {
      const result = await queryFn(
        `SELECT pharmacist_id, line_user_id, display_name, license_number,
                license_verified_at, status, created_at, updated_at
         FROM pharmacist_accounts WHERE pharmacist_id = $1`,
        [pharmacistId]
      );
      return result.rows[0] || null;
    },

    async markOrderExpired(orderId) {
      const result = await queryFn(
        `UPDATE consultation_orders SET status = 'expired', payment_resume_data = NULL,
          reconciliation_next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE order_id = $1 AND status IN ('draft', 'payment_pending')
         RETURNING *`,
        [orderId]
      );
      return result.rows[0] || null;
    },

    async expireStaleDraftOrders(maxAgeMinutes = 10) {
      const result = await queryFn(
        `UPDATE consultation_orders SET status = 'expired',
          reconciliation_next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE status = 'draft'
           AND created_at <= CURRENT_TIMESTAMP - ($1 * INTERVAL '1 minute')
         RETURNING order_id`,
        [maxAgeMinutes]
      );
      return result.rows.map((row) => row.order_id);
    },

    async listOrdersDueForReconciliation(limit = 25) {
      const result = await queryFn(
        `SELECT order_id
         FROM consultation_orders
         WHERE (status = 'payment_pending'
             OR (status = 'paid' AND provisioning_status <> 'provisioned'))
           AND COALESCE(reconciliation_next_attempt_at, updated_at) <= CURRENT_TIMESTAMP
         ORDER BY COALESCE(reconciliation_next_attempt_at, updated_at), order_id
         LIMIT $1`,
        [limit]
      );
      return result.rows.map((row) => row.order_id);
    },

    async markOrderReconciliationAttempt(orderId, { nextAttemptAt, errorCode = null } = {}) {
      const result = await queryFn(
        `UPDATE consultation_orders SET
          reconciliation_attempts = reconciliation_attempts + 1,
          reconciliation_next_attempt_at = $2,
          reconciliation_last_error = $3,
          updated_at = CURRENT_TIMESTAMP
         WHERE order_id = $1
           AND (status = 'payment_pending'
             OR (status = 'paid' AND provisioning_status <> 'provisioned'))
         RETURNING *`,
        [orderId, nextAttemptAt || null, errorCode || null]
      );
      return result.rows[0] || null;
    },

    async finishOrderReconciliation(orderId, { nextAttemptAt = null, errorCode = null } = {}) {
      const result = await queryFn(
        `UPDATE consultation_orders SET
          reconciliation_next_attempt_at = $2,
          reconciliation_last_error = $3,
          updated_at = CURRENT_TIMESTAMP
         WHERE order_id = $1
         RETURNING *`,
        [orderId, nextAttemptAt, errorCode]
      );
      return result.rows[0] || null;
    },

    async findPaymentSupportRecord(reference) {
      const result = await queryFn(
        `SELECT
           o.order_id, o.status AS order_status, o.provisioning_status,
           o.amount_minor, o.currency, o.provider, o.provider_checkout_id,
           o.payment_due_at, o.paid_at, o.created_at, o.updated_at,
           c.case_id, c.state AS case_state, c.queued_at, c.accepted_at,
           c.expires_at, c.closed_at, c.close_reason,
           p.provider_event_id, p.provider_payment_id,
           p.processing_status AS payment_processing_status,
           p.failure_code AS payment_failure_code,
           p.received_at AS payment_received_at,
           p.processed_at AS payment_processed_at
         FROM consultation_orders o
         LEFT JOIN consultation_cases c ON c.order_id = o.order_id
         LEFT JOIN LATERAL (
           SELECT pt.provider_event_id, pt.provider_payment_id,
                  pt.processing_status, pt.failure_code,
                  pt.received_at, pt.processed_at
           FROM payment_transactions pt
           WHERE pt.order_id = o.order_id
           ORDER BY pt.received_at DESC, pt.payment_transaction_id DESC
           LIMIT 1
         ) p ON TRUE
         WHERE o.order_id = $1
            OR c.case_id = $1
            OR o.provider_checkout_id = $1
            OR EXISTS (
              SELECT 1 FROM payment_transactions lookup
              WHERE lookup.order_id = o.order_id
                AND (lookup.provider_payment_id = $1 OR lookup.provider_event_id = $1)
            )
         ORDER BY o.created_at DESC
         LIMIT 1`,
        [reference]
      );
      return result.rows[0] || null;
    },

    async listEligiblePharmacists() {
      const result = await queryFn(
        `SELECT pharmacist_id, line_user_id, status, license_verified_at
         FROM pharmacist_accounts
         WHERE status = 'active'
           AND license_verified_at IS NOT NULL
           AND line_user_id IS NOT NULL
           AND btrim(line_user_id) <> ''
         ORDER BY pharmacist_id`
      );
      return result.rows;
    },

    async listAcceptedNotificationCandidates(since) {
      const result = await queryFn(
        `SELECT c.case_id, c.customer_line_user_id, e.occurred_at
         FROM consultation_events e
         JOIN consultation_cases c ON c.case_id = e.case_id
         WHERE e.event_type = 'accepted' AND e.occurred_at >= $1
         ORDER BY e.occurred_at, c.case_id`,
        [since]
      );
      return result.rows;
    },

    async listClosedNotificationCandidates(since) {
      const result = await queryFn(
        `SELECT c.case_id, c.customer_line_user_id, e.occurred_at
         FROM consultation_events e
         JOIN consultation_cases c ON c.case_id = e.case_id
         WHERE e.event_type = 'closed' AND e.occurred_at >= $1
         ORDER BY e.occurred_at, c.case_id`,
        [since]
      );
      return result.rows;
    },

    async listNearExpiryNotificationCandidates(milestoneMinutes = 120) {
      const result = await queryFn(
        `SELECT case_id, customer_line_user_id, expires_at
         FROM consultation_cases
         WHERE state IN ('active', 'resolved')
           AND expires_at > CURRENT_TIMESTAMP
           AND expires_at <= CURRENT_TIMESTAMP + ($1 * INTERVAL '1 minute')
         ORDER BY expires_at, case_id`,
        [milestoneMinutes]
      );
      return result.rows;
    },

    async listUnreadMessageNotificationCandidates(limit = 100) {
      const result = await queryFn(
        `SELECT c.case_id, c.waiting_on, c.customer_line_user_id,
                p.pharmacist_id, p.line_user_id AS pharmacist_line_user_id,
                unread.message_sequence, unread.sender_type
         FROM consultation_cases c
         LEFT JOIN pharmacist_accounts p ON p.pharmacist_id = c.assigned_pharmacist_id
         JOIN LATERAL (
           SELECT m.message_sequence, m.sender_type
           FROM consultation_messages m
           WHERE m.case_id = c.case_id
             AND (
               (c.waiting_on = 'customer' AND m.sender_type = 'pharmacist'
                 AND m.message_sequence > c.customer_last_read_sequence)
               OR
               (c.waiting_on = 'pharmacist' AND m.sender_type = 'customer'
                 AND m.message_sequence > c.pharmacist_last_read_sequence)
             )
           ORDER BY m.message_sequence
           LIMIT 1
         ) unread ON TRUE
         WHERE c.state IN ('active', 'resolved')
           AND c.expires_at > CURRENT_TIMESTAMP
         ORDER BY c.updated_at, c.case_id
         LIMIT $1`,
        [limit]
      );
      return result.rows;
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
                p.display_name AS pharmacist_display_name,
                o.provisioning_status, CURRENT_TIMESTAMP AS database_now,
                COALESCE((SELECT MAX(m.message_sequence)
                          FROM consultation_messages m WHERE m.case_id = c.case_id), 0)
                  AS last_message_sequence,
                COALESCE((SELECT COUNT(*) FROM consultation_messages m
                          WHERE m.case_id = c.case_id AND m.sender_type = 'pharmacist'
                            AND m.message_sequence > c.customer_last_read_sequence), 0)
                  AS customer_unread_count,
                COALESCE((SELECT COUNT(*) FROM consultation_messages m
                          WHERE m.case_id = c.case_id AND m.sender_type = 'customer'
                            AND m.message_sequence > c.pharmacist_last_read_sequence), 0)
                  AS pharmacist_unread_count
         FROM consultation_cases c
         JOIN consultation_orders o ON o.order_id = c.order_id
         LEFT JOIN pharmacist_accounts p ON p.pharmacist_id = c.assigned_pharmacist_id
         WHERE c.case_id = $1`,
        [caseId]
      );
      return result.rows[0] || null;
    },

    async listCasesForCustomer(lineUserId) {
      const result = await queryFn(
        `SELECT c.*, o.initial_question,
                p.display_name AS pharmacist_display_name,
                o.status AS order_status, o.provisioning_status,
                CURRENT_TIMESTAMP AS database_now,
                COALESCE((SELECT MAX(m.message_sequence)
                          FROM consultation_messages m WHERE m.case_id = c.case_id), 0)
                  AS last_message_sequence,
                COALESCE((SELECT COUNT(*) FROM consultation_messages m
                          WHERE m.case_id = c.case_id AND m.sender_type = 'pharmacist'
                            AND m.message_sequence > c.customer_last_read_sequence), 0)
                  AS customer_unread_count,
                COALESCE((SELECT COUNT(*) FROM consultation_messages m
                          WHERE m.case_id = c.case_id AND m.sender_type = 'customer'
                            AND m.message_sequence > c.pharmacist_last_read_sequence), 0)
                  AS pharmacist_unread_count
         FROM consultation_cases c
         JOIN consultation_orders o ON o.order_id = c.order_id
         LEFT JOIN pharmacist_accounts p ON p.pharmacist_id = c.assigned_pharmacist_id
         WHERE c.customer_line_user_id = $1
           AND o.status = 'paid' AND o.provisioning_status = 'provisioned'
         ORDER BY c.created_at DESC, c.case_id DESC`,
        [lineUserId]
      );
      return result.rows;
    },

    async listQueuedCases({
      cursorQueuedAt = null, cursorCaseId = null,
      minQueuedMinutes = 0, limit = 51,
    } = {}) {
      const result = await queryFn(
        `SELECT c.*, o.initial_question, CURRENT_TIMESTAMP AS database_now
         FROM consultation_cases c
         JOIN consultation_orders o ON o.order_id = c.order_id
         WHERE c.state = 'queued'
           AND o.status = 'paid' AND o.provisioning_status = 'provisioned'
           AND ($1::timestamptz IS NULL OR (c.queued_at, c.case_id) > ($1::timestamptz, $2))
           AND c.queued_at <= CURRENT_TIMESTAMP - ($3 * INTERVAL '1 minute')
         ORDER BY c.queued_at, c.case_id
         LIMIT $4`,
        [cursorQueuedAt, cursorCaseId, minQueuedMinutes, limit]
      );
      return result.rows;
    },

    async listActiveCasesForPharmacist(pharmacistId) {
      return this.listCasesForPharmacist(pharmacistId, {collection:'open'});
    },

    async listCasesForPharmacist(pharmacistId, {collection = 'active', limit = 100} = {}) {
      const collectionPredicates = {
        open:"c.state IN ('active', 'resolved') AND c.expires_at > CURRENT_TIMESTAMP",
        active:"c.state = 'active' AND c.expires_at > CURRENT_TIMESTAMP",
        resolved:"c.state = 'resolved' AND c.expires_at > CURRENT_TIMESTAMP",
        closed:"(c.state = 'closed' OR (c.expires_at IS NOT NULL AND c.expires_at <= CURRENT_TIMESTAMP))",
      };
      const predicate = collectionPredicates[collection];
      if (!predicate) throw new Error('Unsupported consultation collection');
      const result = await queryFn(
        `SELECT c.*, o.initial_question,
                p.display_name AS pharmacist_display_name,
                o.status AS order_status, o.provisioning_status,
                CURRENT_TIMESTAMP AS database_now,
                COALESCE((SELECT MAX(m.message_sequence)
                          FROM consultation_messages m WHERE m.case_id = c.case_id), 0)
                  AS last_message_sequence,
                COALESCE((SELECT COUNT(*) FROM consultation_messages m
                          WHERE m.case_id = c.case_id AND m.sender_type = 'customer'
                            AND m.message_sequence > c.pharmacist_last_read_sequence), 0)
                  AS pharmacist_unread_count
         FROM consultation_cases c
         JOIN consultation_orders o ON o.order_id = c.order_id
         LEFT JOIN pharmacist_accounts p ON p.pharmacist_id = c.assigned_pharmacist_id
         WHERE c.assigned_pharmacist_id = $1 AND ${predicate}
           AND o.status = 'paid' AND o.provisioning_status = 'provisioned'
         ORDER BY c.updated_at DESC, c.case_id DESC
         LIMIT $2`,
        [pharmacistId, limit]
      );
      return result.rows;
    },

    async listExpiredCaseIds(limit = 100) {
      const result = await queryFn(
        `SELECT case_id
         FROM consultation_cases
         WHERE state IN ('active', 'resolved')
           AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP
         ORDER BY expires_at, case_id
         LIMIT $1`,
        [limit]
      );
      return result.rows.map((row) => row.case_id);
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

    async listMessagesBefore(caseId, { beforeSequence = 0, limit = 21 } = {}) {
      const result = await queryFn(
        `SELECT message_id, case_id, message_sequence, sender_type, sender_id, body, created_at
         FROM (
           SELECT message_id, case_id, message_sequence, sender_type, sender_id, body, created_at
           FROM consultation_messages
           WHERE case_id = $1 AND ($2 = 0 OR message_sequence < $2)
           ORDER BY message_sequence DESC
           LIMIT $3
         ) page
         ORDER BY message_sequence`,
        [caseId, beforeSequence, limit]
      );
      return result.rows;
    },

    async findMessageBySequence(caseId, sequence) {
      const result = await queryFn(
        `SELECT message_id, case_id, message_sequence, sender_type, sender_id, body, created_at
         FROM consultation_messages WHERE case_id = $1 AND message_sequence = $2`,
        [caseId, sequence]
      );
      return result.rows[0] || null;
    },

    async getLastMessageSequence(caseId) {
      const result = await queryFn(
        `SELECT COALESCE(MAX(message_sequence), 0) AS last_message_sequence
         FROM consultation_messages WHERE case_id = $1`,
        [caseId]
      );
      return Number(result.rows[0]?.last_message_sequence || 0);
    },

    async updateReadSequence(caseId, reader, sequence) {
      const column = reader === 'customer' ? 'customer_last_read_sequence'
        : reader === 'pharmacist' ? 'pharmacist_last_read_sequence' : null;
      if (!column) throw new Error('Unsupported consultation reader');
      const result = await queryFn(
        `UPDATE consultation_cases SET
           ${column} = GREATEST(${column}, $2), updated_at = CURRENT_TIMESTAMP
         WHERE case_id = $1
         RETURNING *, CURRENT_TIMESTAMP AS database_now`,
        [caseId, sequence]
      );
      return result.rows[0] || null;
    },

    async listRecentMessages(caseId, { limit = 12 } = {}) {
      const result = await queryFn(
        `SELECT message_id, case_id, message_sequence, sender_type, body, created_at
         FROM (
           SELECT message_id, case_id, message_sequence, sender_type, body, created_at
           FROM consultation_messages
           WHERE case_id = $1
           ORDER BY message_sequence DESC
           LIMIT $2
         ) recent
         ORDER BY message_sequence`,
        [caseId, limit]
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
        UPDATE_CASE_WORKFLOW_SQL,
        [caseId, state, waitingOn, closedAt, closeReason]
      );
      return result.rows[0] || null;
    },

    async reassignCase(caseId, pharmacistId) {
      const result = await queryFn(
        `UPDATE consultation_cases SET
          assigned_pharmacist_id = $2, updated_at = CURRENT_TIMESTAMP
         WHERE case_id = $1
         RETURNING *, CURRENT_TIMESTAMP AS database_now`,
        [caseId, pharmacistId]
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

module.exports = { UPDATE_CASE_WORKFLOW_SQL, createConsultationRepository };
