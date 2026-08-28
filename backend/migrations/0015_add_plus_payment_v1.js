module.exports = {
  version: '0015',
  name: 'add_plus_payment_v1',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS plus_orders (
        order_id VARCHAR(80) PRIMARY KEY,
        subject_line_user_id VARCHAR(128) NOT NULL,
        plan_id VARCHAR(64) NOT NULL CHECK (plan_id = 'plus_30d_v1'),
        amount_minor INTEGER NOT NULL CHECK (amount_minor = 5900),
        currency CHAR(3) NOT NULL CHECK (currency = 'THB'),
        return_target VARCHAR(64) NOT NULL CHECK (return_target IN (
          'lab_explanation', 'doctor_question_prep',
          'doctor_visit_organization', 'plus_home'
        )),
        idempotency_key VARCHAR(80) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'payment_pending', 'paid', 'failed', 'expired', 'cancelled')),
        provider VARCHAR(64),
        provider_checkout_id VARCHAR(160),
        payment_due_at TIMESTAMPTZ,
        payment_resume_data JSONB,
        paid_at TIMESTAMPTZ,
        fulfillment_status VARCHAR(32) NOT NULL DEFAULT 'pending'
          CHECK (fulfillment_status IN ('pending', 'granted', 'error')),
        entitlement_id VARCHAR(80),
        entitlement_start_at TIMESTAMPTZ,
        entitlement_end_at TIMESTAMPTZ,
        reconciliation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_attempts >= 0),
        reconciliation_next_attempt_at TIMESTAMPTZ,
        reconciliation_last_error VARCHAR(80),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (subject_line_user_id, idempotency_key),
        UNIQUE (entitlement_id),
        CHECK (payment_resume_data IS NULL OR jsonb_typeof(payment_resume_data) = 'object'),
        CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
        CHECK (
          fulfillment_status <> 'granted'
          OR (status = 'paid' AND entitlement_id IS NOT NULL
            AND entitlement_start_at IS NOT NULL AND entitlement_end_at IS NOT NULL)
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_plus_orders_active_subject
      ON plus_orders (subject_line_user_id)
      WHERE status IN ('draft', 'payment_pending')
         OR (status = 'paid' AND fulfillment_status <> 'granted')
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_plus_orders_provider_checkout
      ON plus_orders (provider, provider_checkout_id)
      WHERE provider IS NOT NULL AND provider_checkout_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plus_orders_subject_history
      ON plus_orders (subject_line_user_id, created_at DESC, order_id DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plus_orders_reconciliation_due
      ON plus_orders (reconciliation_next_attempt_at, updated_at, order_id)
      WHERE status = 'payment_pending'
         OR (status = 'paid' AND fulfillment_status <> 'granted')
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS plus_payment_transactions (
        payment_transaction_id VARCHAR(80) PRIMARY KEY,
        order_id VARCHAR(80) NOT NULL REFERENCES plus_orders(order_id) ON DELETE RESTRICT,
        provider VARCHAR(64) NOT NULL,
        provider_event_id VARCHAR(160) NOT NULL,
        provider_payment_id VARCHAR(160),
        provider_checkout_id VARCHAR(160),
        event_type VARCHAR(64) NOT NULL,
        processing_status VARCHAR(32) NOT NULL
          CHECK (processing_status IN ('verified', 'processed', 'retry_required', 'rejected')),
        amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
        currency CHAR(3) NOT NULL,
        signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
        payload_hash CHAR(64),
        provider_paid_at TIMESTAMPTZ,
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMPTZ,
        failure_code VARCHAR(80),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        UNIQUE (provider, provider_event_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plus_payment_transactions_order_time
      ON plus_payment_transactions (order_id, received_at DESC)
    `);

    await client.query(`
      ALTER TABLE plus_entitlements
      ADD COLUMN IF NOT EXISTS source_order_id VARCHAR(80)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_plus_entitlements_source_order
      ON plus_entitlements (source_order_id)
      WHERE source_order_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query('DROP INDEX IF EXISTS uq_plus_entitlements_source_order');
    await client.query('ALTER TABLE plus_entitlements DROP COLUMN IF EXISTS source_order_id');
    await client.query('DROP TABLE IF EXISTS plus_payment_transactions');
    await client.query('DROP TABLE IF EXISTS plus_orders');
  },
};
