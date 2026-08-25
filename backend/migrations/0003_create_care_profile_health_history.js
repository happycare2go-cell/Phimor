const HEALTH_FIELDS_SQL = [
  'gender', 'blood_type', 'height_cm', 'weight_kg', 'chronic_conditions',
  'drug_allergies', 'food_allergies', 'mobility_limitations',
  'emergency_contact_name', 'emergency_contact_phone', 'family_phone',
].map((field) => `'${field}'`).join(', ');

module.exports = {
  version: '0003',
  name: 'create_care_profile_health_history',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS care_profile_health_history (
        history_id VARCHAR(80) PRIMARY KEY,
        care_profile_id VARCHAR(80) NOT NULL,
        changed_at TIMESTAMPTZ NOT NULL,
        changed_by_line_user_id VARCHAR(128) NOT NULL,
        actor_type VARCHAR(32) NOT NULL
          CHECK (actor_type IN (
            'family_owner', 'family_caregiver', 'center_owner',
            'center_manager', 'system_admin'
          )),
        source VARCHAR(32) NOT NULL
          CHECK (source IN ('family_liff', 'center_liff', 'api')),
        changed_fields TEXT[] NOT NULL
          CHECK (
            cardinality(changed_fields) > 0
            AND changed_fields <@ ARRAY[${HEALTH_FIELDS_SQL}]::TEXT[]
          ),
        before_values JSONB NOT NULL
          CHECK (jsonb_typeof(before_values) = 'object'),
        after_values JSONB NOT NULL
          CHECK (jsonb_typeof(after_values) = 'object'),
        schema_version SMALLINT NOT NULL DEFAULT 1,
        retention_until TIMESTAMPTZ DEFAULT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_health_history_profile_time
      ON care_profile_health_history (care_profile_id, changed_at DESC, history_id DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_health_history_changed_fields
      ON care_profile_health_history USING GIN (changed_fields)
    `);
  },

  async down(client) {
    await client.query('DROP TABLE IF EXISTS care_profile_health_history');
  },
};
