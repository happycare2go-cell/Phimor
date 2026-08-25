module.exports = {
  version: '0004',
  name: 'create_pharmacist_consultation_v1',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pharmacist_accounts (
        pharmacist_id VARCHAR(80) PRIMARY KEY,
        line_user_id VARCHAR(128) NOT NULL UNIQUE,
        display_name VARCHAR(160) NOT NULL,
        license_number VARCHAR(80) NOT NULL UNIQUE,
        license_verified_at TIMESTAMPTZ,
        status VARCHAR(32) NOT NULL
          CHECK (status IN ('invited', 'active', 'suspended', 'inactive')),
        created_by VARCHAR(128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS consultation_orders (
        order_id VARCHAR(80) PRIMARY KEY,
        customer_line_user_id VARCHAR(128) NOT NULL,
        care_profile_id VARCHAR(80) NOT NULL,
        initial_question TEXT NOT NULL
          CHECK (char_length(initial_question) BETWEEN 1 AND 4000),
        amount_minor INTEGER NOT NULL DEFAULT 10000
          CHECK (amount_minor = 10000),
        currency CHAR(3) NOT NULL DEFAULT 'THB'
          CHECK (currency = 'THB'),
        duration_minutes INTEGER NOT NULL DEFAULT 1440
          CHECK (duration_minutes = 1440),
        terms_version VARCHAR(80) NOT NULL,
        terms_accepted_at TIMESTAMPTZ NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'payment_pending', 'paid', 'failed', 'expired')),
        provider VARCHAR(64),
        provider_checkout_id VARCHAR(160),
        payment_due_at TIMESTAMPTZ,
        paid_at TIMESTAMPTZ,
        provisioning_status VARCHAR(32) NOT NULL DEFAULT 'pending'
          CHECK (provisioning_status IN ('pending', 'provisioned', 'error')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK ((status = 'paid') = (paid_at IS NOT NULL))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_consultation_orders_provider_checkout
      ON consultation_orders (provider, provider_checkout_id)
      WHERE provider IS NOT NULL AND provider_checkout_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_consultation_orders_customer_time
      ON consultation_orders (customer_line_user_id, created_at DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_transactions (
        payment_transaction_id VARCHAR(80) PRIMARY KEY,
        order_id VARCHAR(80) NOT NULL REFERENCES consultation_orders(order_id) ON DELETE RESTRICT,
        provider VARCHAR(64) NOT NULL,
        provider_event_id VARCHAR(160) NOT NULL,
        provider_payment_id VARCHAR(160),
        event_type VARCHAR(64) NOT NULL,
        processing_status VARCHAR(32) NOT NULL DEFAULT 'received'
          CHECK (processing_status IN ('received', 'verified', 'processed', 'rejected', 'error')),
        amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
        currency CHAR(3) NOT NULL,
        signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
        payload_hash CHAR(64),
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMPTZ,
        failure_code VARCHAR(80),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        UNIQUE (provider, provider_event_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payment_transactions_order_time
      ON payment_transactions (order_id, received_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payment_transactions_reconciliation
      ON payment_transactions (processing_status, received_at)
      WHERE processing_status IN ('received', 'verified', 'error')
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS consultation_cases (
        case_id VARCHAR(80) PRIMARY KEY,
        order_id VARCHAR(80) NOT NULL UNIQUE
          REFERENCES consultation_orders(order_id) ON DELETE RESTRICT,
        care_profile_id VARCHAR(80) NOT NULL,
        customer_line_user_id VARCHAR(128) NOT NULL,
        state VARCHAR(32) NOT NULL DEFAULT 'queued'
          CHECK (state IN ('queued', 'active', 'resolved', 'closed')),
        waiting_on VARCHAR(32) NOT NULL DEFAULT 'none'
          CHECK (waiting_on IN ('none', 'customer', 'pharmacist')),
        assigned_pharmacist_id VARCHAR(80)
          REFERENCES pharmacist_accounts(pharmacist_id) ON DELETE RESTRICT,
        queued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        accepted_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        close_reason VARCHAR(64),
        customer_last_read_sequence BIGINT NOT NULL DEFAULT 0 CHECK (customer_last_read_sequence >= 0),
        pharmacist_last_read_sequence BIGINT NOT NULL DEFAULT 0 CHECK (pharmacist_last_read_sequence >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK ((accepted_at IS NULL) = (expires_at IS NULL)),
        CHECK (expires_at IS NULL OR expires_at = accepted_at + INTERVAL '24 hours'),
        CHECK (
          (state = 'queued' AND assigned_pharmacist_id IS NULL AND accepted_at IS NULL AND waiting_on = 'none')
          OR
          (state IN ('active', 'resolved', 'closed') AND assigned_pharmacist_id IS NOT NULL AND accepted_at IS NOT NULL)
        ),
        CHECK (state = 'closed' OR closed_at IS NULL)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_consultation_cases_queue
      ON consultation_cases (queued_at, case_id)
      WHERE state = 'queued'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_consultation_cases_pharmacist_state
      ON consultation_cases (assigned_pharmacist_id, state, updated_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_consultation_cases_customer_time
      ON consultation_cases (customer_line_user_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_consultation_cases_expiration
      ON consultation_cases (expires_at)
      WHERE state <> 'closed' AND expires_at IS NOT NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS consultation_messages (
        message_id VARCHAR(80) PRIMARY KEY,
        case_id VARCHAR(80) NOT NULL
          REFERENCES consultation_cases(case_id) ON DELETE RESTRICT,
        message_sequence BIGINT GENERATED ALWAYS AS IDENTITY,
        sender_type VARCHAR(32) NOT NULL
          CHECK (sender_type IN ('customer', 'pharmacist', 'system')),
        sender_id VARCHAR(128),
        body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
        idempotency_key VARCHAR(80) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (case_id, message_sequence),
        UNIQUE (case_id, idempotency_key),
        CHECK (sender_type = 'system' OR sender_id IS NOT NULL)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_consultation_messages_case_sequence
      ON consultation_messages (case_id, message_sequence)
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION reject_consultation_message_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'consultation messages are immutable';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS trg_consultation_messages_immutable ON consultation_messages
    `);
    await client.query(`
      CREATE TRIGGER trg_consultation_messages_immutable
      BEFORE UPDATE OR DELETE ON consultation_messages
      FOR EACH ROW EXECUTE FUNCTION reject_consultation_message_mutation()
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS consultation_events (
        event_id VARCHAR(80) PRIMARY KEY,
        case_id VARCHAR(80) NOT NULL
          REFERENCES consultation_cases(case_id) ON DELETE RESTRICT,
        event_type VARCHAR(64) NOT NULL,
        actor_type VARCHAR(32) NOT NULL
          CHECK (actor_type IN ('customer', 'pharmacist', 'system', 'payment', 'admin')),
        actor_id VARCHAR(128),
        from_state VARCHAR(32)
          CHECK (from_state IS NULL OR from_state IN ('queued', 'active', 'resolved', 'closed')),
        to_state VARCHAR(32)
          CHECK (to_state IS NULL OR to_state IN ('queued', 'active', 'resolved', 'closed')),
        metadata JSONB NOT NULL DEFAULT '{}'
          CHECK (jsonb_typeof(metadata) = 'object'),
        idempotency_key VARCHAR(160),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_consultation_events_idempotency
      ON consultation_events (case_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_consultation_events_case_time
      ON consultation_events (case_id, occurred_at, event_id)
    `);

    await client.query(`
      ALTER TABLE ai_interaction_audit
      ADD COLUMN IF NOT EXISTS consultation_case_id VARCHAR(80),
      ADD COLUMN IF NOT EXISTS requester_type VARCHAR(32)
        CHECK (requester_type IS NULL OR requester_type IN ('family', 'pharmacist', 'system'))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_interaction_audit_consultation_case
      ON ai_interaction_audit (consultation_case_id)
      WHERE consultation_case_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query('DROP INDEX IF EXISTS idx_ai_interaction_audit_consultation_case');
    await client.query(`
      ALTER TABLE ai_interaction_audit
      DROP COLUMN IF EXISTS consultation_case_id,
      DROP COLUMN IF EXISTS requester_type
    `);
    await client.query('DROP TABLE IF EXISTS consultation_events');
    await client.query('DROP TRIGGER IF EXISTS trg_consultation_messages_immutable ON consultation_messages');
    await client.query('DROP TABLE IF EXISTS consultation_messages');
    await client.query('DROP FUNCTION IF EXISTS reject_consultation_message_mutation');
    await client.query('DROP TABLE IF EXISTS consultation_cases');
    await client.query('DROP TABLE IF EXISTS payment_transactions');
    await client.query('DROP TABLE IF EXISTS consultation_orders');
    await client.query('DROP TABLE IF EXISTS pharmacist_accounts');
  },
};
