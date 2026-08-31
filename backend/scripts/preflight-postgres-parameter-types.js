const { Pool } = require('pg');

const REQUIRED_TABLES = Object.freeze([
  'integration_clients',
  'plus_payment_transactions',
]);

const PREPARE_CHECKS = Object.freeze([
  {
    name: 'integration_client_status',
    sql: `PREPARE phimor_integration_client_status_type_check AS
      UPDATE integration_clients SET status = $2::varchar,
        revoked_at = CASE WHEN $2::varchar = 'revoked' THEN CURRENT_TIMESTAMP ELSE NULL END,
        updated_at = CURRENT_TIMESTAMP
      WHERE integration_client_id = $1 RETURNING *`,
    preparedName: 'phimor_integration_client_status_type_check',
  },
  {
    name: 'plus_payment_transaction_status',
    sql: `PREPARE phimor_plus_payment_status_type_check AS
      UPDATE plus_payment_transactions SET processing_status = $2::varchar,
        failure_code = $3,
        processed_at = CASE WHEN $2::varchar IN ('processed','rejected')
          THEN CURRENT_TIMESTAMP ELSE NULL END,
        attempts = attempts + 1
      WHERE payment_transaction_id = $1 RETURNING *`,
    preparedName: 'phimor_plus_payment_status_type_check',
  },
]);

async function run() {
  console.log('PHIMOR_POSTGRES_PARAMETER_TYPE_PREFLIGHT');
  if (!process.env.DATABASE_URL) {
    console.log('RESULT: BLOCKED');
    console.log('reason: DATABASE_URL_REQUIRED');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN READ ONLY');
    transactionOpen = true;
    for (const table of REQUIRED_TABLES) {
      const result = await client.query('SELECT to_regclass($1) AS table_name', [`public.${table}`]);
      if (!result.rows[0]?.table_name) throw Object.assign(new Error('required table missing'), { safeCode:'REQUIRED_TABLE_MISSING' });
    }
    console.log('required_tables: PASS');

    for (const check of PREPARE_CHECKS) {
      await client.query(check.sql);
      await client.query(`DEALLOCATE ${check.preparedName}`);
      console.log(`${check.name}: PASS`);
    }
    await client.query('ROLLBACK');
    transactionOpen = false;
    console.log('RESULT: SAFE');
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch (_) { /* best effort */ }
    }
    const postgresCode = /^[0-9A-Z]{5}$/.test(String(error?.code || '')) ? error.code : null;
    console.log('RESULT: BLOCKED');
    console.log(`reason: ${error?.safeCode || (postgresCode ? `POSTGRES_${postgresCode}` : 'PREFLIGHT_FAILED')}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(() => {
  console.log('RESULT: BLOCKED');
  console.log('reason: PREFLIGHT_START_FAILED');
  process.exitCode = 1;
});

module.exports = { REQUIRED_TABLES, PREPARE_CHECKS };
