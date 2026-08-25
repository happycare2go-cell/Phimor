module.exports = {
  version: '0005',
  name: 'extend_consultation_payment_reliability',

  async up(client) {
    await client.query(`
      ALTER TABLE payment_transactions
      ADD COLUMN IF NOT EXISTS provider_paid_at TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE payment_transactions
      ADD COLUMN IF NOT EXISTS provider_checkout_id VARCHAR(160)
    `);
    await client.query(`
      ALTER TABLE payment_transactions
      DROP CONSTRAINT IF EXISTS payment_transactions_processing_status_check
    `);
    await client.query(`
      ALTER TABLE payment_transactions
      ADD CONSTRAINT payment_transactions_processing_status_check
      CHECK (processing_status IN (
        'received', 'verified', 'processed', 'retry_required', 'rejected', 'error'
      ))
    `);
    await client.query('DROP INDEX IF EXISTS idx_payment_transactions_reconciliation');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payment_transactions_reconciliation
      ON payment_transactions (processing_status, received_at)
      WHERE processing_status IN ('received', 'verified', 'retry_required', 'error')
    `);
  },

  async down(client) {
    await client.query(`
      UPDATE payment_transactions
      SET processing_status = 'error'
      WHERE processing_status = 'retry_required'
    `);
    await client.query('DROP INDEX IF EXISTS idx_payment_transactions_reconciliation');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payment_transactions_reconciliation
      ON payment_transactions (processing_status, received_at)
      WHERE processing_status IN ('received', 'verified', 'error')
    `);
    await client.query(`
      ALTER TABLE payment_transactions
      DROP CONSTRAINT IF EXISTS payment_transactions_processing_status_check
    `);
    await client.query(`
      ALTER TABLE payment_transactions
      ADD CONSTRAINT payment_transactions_processing_status_check
      CHECK (processing_status IN ('received', 'verified', 'processed', 'rejected', 'error'))
    `);
    await client.query(`
      ALTER TABLE payment_transactions
      DROP COLUMN IF EXISTS provider_paid_at
    `);
    await client.query(`
      ALTER TABLE payment_transactions
      DROP COLUMN IF EXISTS provider_checkout_id
    `);
  },
};
