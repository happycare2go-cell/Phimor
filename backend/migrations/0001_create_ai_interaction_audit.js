module.exports = {
  version: '0001',
  name: 'create_ai_interaction_audit',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_interaction_audit (
        interaction_id VARCHAR(80) PRIMARY KEY,
        requester_line_id VARCHAR(128),
        care_profile_id VARCHAR(80),
        purpose VARCHAR(64) NOT NULL,
        intent VARCHAR(64),
        provider VARCHAR(32),
        model VARCHAR(128),
        prompt_version VARCHAR(64),
        context_version VARCHAR(64),
        requested_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        result_status VARCHAR(32) NOT NULL,
        error_code VARCHAR(64),
        escalation BOOLEAN NOT NULL DEFAULT FALSE,
        provider_request_id VARCHAR(160),
        input_character_count INTEGER NOT NULL DEFAULT 0 CHECK (input_character_count >= 0),
        output_character_count INTEGER NOT NULL DEFAULT 0 CHECK (output_character_count >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_ai_interaction_audit_requested_at ON ai_interaction_audit (requested_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ai_interaction_audit_care_profile_id ON ai_interaction_audit (care_profile_id)');
  },

  async down(client) {
    await client.query('DROP TABLE IF EXISTS ai_interaction_audit');
  },
};
