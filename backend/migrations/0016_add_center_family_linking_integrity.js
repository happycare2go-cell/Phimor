module.exports = {
  version: '0016',
  name: 'add_center_family_linking_integrity',

  async up(client) {
    const required = await client.query(`
      SELECT to_regclass('public."accessRequests"') AS access_requests,
             to_regclass('public.residents') AS residents
    `);
    if (!required.rows[0]?.access_requests || !required.rows[0]?.residents) {
      throw new Error('CENTER_FAMILY_LINKING_LEGACY_TABLES_REQUIRED');
    }

    const duplicateTokenHashes = await client.query(`
      SELECT data->>'link_token_hash' AS value, COUNT(*)::int AS count
      FROM "accessRequests"
      WHERE NULLIF(data->>'link_token_hash', '') IS NOT NULL
      GROUP BY data->>'link_token_hash'
      HAVING COUNT(*) > 1
      LIMIT 1
    `);
    if (duplicateTokenHashes.rows.length) throw new Error('DUPLICATE_CENTER_FAMILY_LINK_TOKEN_HASH');

    const duplicateLinkRequests = await client.query(`
      SELECT data->>'link_request_id' AS value, COUNT(*)::int AS count
      FROM residents
      WHERE NULLIF(data->>'link_request_id', '') IS NOT NULL
      GROUP BY data->>'link_request_id'
      HAVING COUNT(*) > 1
      LIMIT 1
    `);
    if (duplicateLinkRequests.rows.length) throw new Error('DUPLICATE_CENTER_FAMILY_LINK_RESIDENT');

    const duplicateActiveProfiles = await client.query(`
      SELECT data->>'care_profile_id' AS value, COUNT(*)::int AS count
      FROM residents
      WHERE NULLIF(data->>'care_profile_id', '') IS NOT NULL
        AND data->>'status' = 'active'
      GROUP BY data->>'care_profile_id'
      HAVING COUNT(*) > 1
      LIMIT 1
    `);
    if (duplicateActiveProfiles.rows.length) throw new Error('MULTIPLE_ACTIVE_RESIDENTS_FOR_CARE_PROFILE');

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_access_requests_flow_a_token_hash
      ON "accessRequests" ((data->>'link_token_hash'))
      WHERE NULLIF(data->>'link_token_hash', '') IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_residents_flow_a_link_request
      ON residents ((data->>'link_request_id'))
      WHERE NULLIF(data->>'link_request_id', '') IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_residents_active_care_profile
      ON residents ((data->>'care_profile_id'))
      WHERE NULLIF(data->>'care_profile_id', '') IS NOT NULL
        AND data->>'status' = 'active'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_access_requests_flow_a_actor_status
      ON "accessRequests" ((data->>'presented_to_line_user_id'), (data->>'status'), (data->>'expires_at'))
      WHERE data->>'request_kind' = 'anonymous_existing_profile_link'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_access_requests_center_kind_status
      ON "accessRequests" ((data->>'center_id'), (data->>'request_kind'), (data->>'status'), (data->>'expires_at'))
    `);
  },

  async down(client) {
    await client.query('DROP INDEX IF EXISTS idx_access_requests_center_kind_status');
    await client.query('DROP INDEX IF EXISTS idx_access_requests_flow_a_actor_status');
    await client.query('DROP INDEX IF EXISTS uq_residents_active_care_profile');
    await client.query('DROP INDEX IF EXISTS uq_residents_flow_a_link_request');
    await client.query('DROP INDEX IF EXISTS uq_access_requests_flow_a_token_hash');
  },
};
