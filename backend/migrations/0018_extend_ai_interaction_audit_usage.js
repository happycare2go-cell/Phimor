module.exports = {
  version: '0018',
  name: 'extend_ai_interaction_audit_usage',

  async up(client) {
    await client.query(`
      ALTER TABLE ai_interaction_audit
        ADD COLUMN IF NOT EXISTS research_plan_version VARCHAR(64),
        ADD COLUMN IF NOT EXISTS input_tokens INTEGER
          CHECK (input_tokens IS NULL OR input_tokens >= 0),
        ADD COLUMN IF NOT EXISTS output_tokens INTEGER
          CHECK (output_tokens IS NULL OR output_tokens >= 0),
        ADD COLUMN IF NOT EXISTS total_tokens INTEGER
          CHECK (total_tokens IS NULL OR total_tokens >= 0),
        ADD COLUMN IF NOT EXISTS reasoning_tokens INTEGER
          CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
        ADD COLUMN IF NOT EXISTS web_search_calls INTEGER
          CHECK (web_search_calls IS NULL OR web_search_calls >= 0),
        ADD COLUMN IF NOT EXISTS source_count INTEGER
          CHECK (source_count IS NULL OR source_count >= 0),
        ADD COLUMN IF NOT EXISTS research_performed BOOLEAN NOT NULL DEFAULT FALSE
    `);
  },

  async down(client) {
    await client.query(`
      ALTER TABLE ai_interaction_audit
        DROP COLUMN IF EXISTS research_performed,
        DROP COLUMN IF EXISTS source_count,
        DROP COLUMN IF EXISTS web_search_calls,
        DROP COLUMN IF EXISTS reasoning_tokens,
        DROP COLUMN IF EXISTS total_tokens,
        DROP COLUMN IF EXISTS output_tokens,
        DROP COLUMN IF EXISTS input_tokens,
        DROP COLUMN IF EXISTS research_plan_version
    `);
  },
};
