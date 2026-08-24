module.exports = {
  version: '0002',
  name: 'create_plus_entitlements',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS plus_entitlements (
        entitlement_id VARCHAR(80) PRIMARY KEY,
        subject_type VARCHAR(32) NOT NULL CHECK (subject_type IN ('line_user')),
        subject_id VARCHAR(128) NOT NULL,
        plan_code VARCHAR(64) NOT NULL CHECK (plan_code IN ('family_plus')),
        status VARCHAR(32) NOT NULL CHECK (status IN ('active', 'expired', 'suspended', 'trial')),
        starts_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        source VARCHAR(32) NOT NULL CHECK (source IN ('internal', 'promotion', 'payment')),
        features TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR(128),
        note VARCHAR(500)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plus_entitlements_subject
      ON plus_entitlements (subject_type, subject_id, plan_code)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plus_entitlements_expiry
      ON plus_entitlements (expires_at)
    `);
  },

  async down(client) {
    await client.query('DROP TABLE IF EXISTS plus_entitlements');
  },
};
