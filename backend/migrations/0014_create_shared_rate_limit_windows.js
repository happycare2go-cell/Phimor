module.exports = {
  version: '0014',
  name: 'create_shared_rate_limit_windows',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS shared_rate_limit_windows (
        key_hash CHAR(64) PRIMARY KEY,
        domain VARCHAR(80) NOT NULL,
        window_started_at TIMESTAMPTZ NOT NULL,
        window_expires_at TIMESTAMPTZ NOT NULL,
        request_count INTEGER NOT NULL CHECK (request_count >= 1),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT shared_rate_limit_window_order CHECK (window_expires_at > window_started_at)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shared_rate_limit_windows_expiry
      ON shared_rate_limit_windows (window_expires_at, key_hash)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shared_rate_limit_windows_domain
      ON shared_rate_limit_windows (domain, updated_at DESC)
    `);
  },

  async down(client) {
    await client.query('DROP TABLE IF EXISTS shared_rate_limit_windows');
  },
};
