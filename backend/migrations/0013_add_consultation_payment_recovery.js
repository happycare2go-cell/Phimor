module.exports = {
  version: '0013',
  name: 'add_consultation_payment_recovery',

  async up(client) {
    await client.query(`
      ALTER TABLE consultation_orders
      ADD COLUMN IF NOT EXISTS payment_resume_data JSONB,
      ADD COLUMN IF NOT EXISTS reconciliation_attempts INTEGER NOT NULL DEFAULT 0
        CHECK (reconciliation_attempts >= 0),
      ADD COLUMN IF NOT EXISTS reconciliation_next_attempt_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reconciliation_last_error VARCHAR(80)
    `);
    await client.query(`
      ALTER TABLE consultation_orders
      DROP CONSTRAINT IF EXISTS consultation_orders_payment_resume_data_check
    `);
    await client.query(`
      ALTER TABLE consultation_orders
      ADD CONSTRAINT consultation_orders_payment_resume_data_check
      CHECK (payment_resume_data IS NULL OR jsonb_typeof(payment_resume_data) = 'object')
    `);

    const duplicates = await client.query(`
      SELECT customer_line_user_id, care_profile_id, COUNT(*)::integer AS active_count
      FROM consultation_orders
      WHERE status IN ('draft', 'payment_pending')
         OR (status = 'paid' AND provisioning_status <> 'provisioned')
      GROUP BY customer_line_user_id, care_profile_id
      HAVING COUNT(*) > 1
      LIMIT 1
    `);
    if (duplicates?.rows?.length) {
      throw new Error('CONSULTATION_ACTIVE_CHECKOUT_DUPLICATES_REQUIRE_REVIEW');
    }

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_consultation_orders_active_checkout
      ON consultation_orders (customer_line_user_id, care_profile_id)
      WHERE status IN ('draft', 'payment_pending')
         OR (status = 'paid' AND provisioning_status <> 'provisioned')
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_consultation_orders_reconciliation_due
      ON consultation_orders (reconciliation_next_attempt_at, updated_at, order_id)
      WHERE status = 'payment_pending'
         OR (status = 'paid' AND provisioning_status <> 'provisioned')
    `);
  },

  async down(client) {
    await client.query('DROP INDEX IF EXISTS idx_consultation_orders_reconciliation_due');
    await client.query('DROP INDEX IF EXISTS uq_consultation_orders_active_checkout');
    await client.query(`
      ALTER TABLE consultation_orders
      DROP CONSTRAINT IF EXISTS consultation_orders_payment_resume_data_check
    `);
    await client.query(`
      ALTER TABLE consultation_orders
      DROP COLUMN IF EXISTS payment_resume_data,
      DROP COLUMN IF EXISTS reconciliation_attempts,
      DROP COLUMN IF EXISTS reconciliation_next_attempt_at,
      DROP COLUMN IF EXISTS reconciliation_last_error
    `);
  },
};
