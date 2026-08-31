const { Pool } = require('pg');

const REQUIRED_TABLES=Object.freeze([
  'consultation_orders','payment_transactions','consultation_cases',
  'consultation_events','consultation_messages','pharmacist_accounts',
]);

const PREPARE_CHECKS=Object.freeze([
  {
    name:'update_case_workflow',preparedName:'phimor_consultation_update_workflow_check',
    sql:`PREPARE phimor_consultation_update_workflow_check AS
      UPDATE consultation_cases SET
        state = $2::varchar, waiting_on = $3,
        resolved_at = CASE WHEN $2::varchar = 'resolved' THEN CURRENT_TIMESTAMP ELSE resolved_at END,
        closed_at = COALESCE($4, closed_at), close_reason = COALESCE($5, close_reason),
        updated_at = CURRENT_TIMESTAMP
      WHERE case_id = $1 RETURNING *`,
  },
  {
    name:'lifecycle_expired_cases',preparedName:'phimor_consultation_expired_cases_check',
    sql:`PREPARE phimor_consultation_expired_cases_check AS
      SELECT case_id FROM consultation_cases
      WHERE state IN ('active', 'resolved')
        AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP
      ORDER BY expires_at, case_id LIMIT $1`,
  },
  {
    name:'lifecycle_stale_draft_expiry',preparedName:'phimor_consultation_stale_drafts_check',
    sql:`PREPARE phimor_consultation_stale_drafts_check AS
      UPDATE consultation_orders SET status = 'expired',
        reconciliation_next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'draft'
        AND created_at <= CURRENT_TIMESTAMP - ($1 * INTERVAL '1 minute')
      RETURNING order_id`,
  },
  {
    name:'lifecycle_payment_reconciliation',preparedName:'phimor_consultation_reconciliation_check',
    sql:`PREPARE phimor_consultation_reconciliation_check AS
      SELECT order_id FROM consultation_orders
      WHERE (status = 'payment_pending'
          OR (status = 'paid' AND provisioning_status <> 'provisioned'))
        AND COALESCE(reconciliation_next_attempt_at, updated_at) <= CURRENT_TIMESTAMP
      ORDER BY COALESCE(reconciliation_next_attempt_at, updated_at), order_id LIMIT $1`,
  },
  {
    name:'lifecycle_accepted_notifications',preparedName:'phimor_consultation_accepted_notifications_check',
    sql:`PREPARE phimor_consultation_accepted_notifications_check AS
      SELECT c.case_id, c.customer_line_user_id, e.occurred_at
      FROM consultation_events e
      JOIN consultation_cases c ON c.case_id = e.case_id
      WHERE e.event_type = 'accepted' AND e.occurred_at >= $1
      ORDER BY e.occurred_at, c.case_id`,
  },
  {
    name:'lifecycle_closed_notifications',preparedName:'phimor_consultation_closed_notifications_check',
    sql:`PREPARE phimor_consultation_closed_notifications_check AS
      SELECT c.case_id, c.customer_line_user_id, e.occurred_at
      FROM consultation_events e
      JOIN consultation_cases c ON c.case_id = e.case_id
      WHERE e.event_type = 'closed' AND e.occurred_at >= $1
      ORDER BY e.occurred_at, c.case_id`,
  },
  {
    name:'lifecycle_near_expiry_notifications',preparedName:'phimor_consultation_near_expiry_check',
    sql:`PREPARE phimor_consultation_near_expiry_check AS
      SELECT case_id, customer_line_user_id, expires_at FROM consultation_cases
      WHERE state IN ('active', 'resolved')
        AND expires_at > CURRENT_TIMESTAMP
        AND expires_at <= CURRENT_TIMESTAMP + ($1 * INTERVAL '1 minute')
      ORDER BY expires_at, case_id`,
  },
  {
    name:'lifecycle_unread_notifications',preparedName:'phimor_consultation_unread_notifications_check',
    sql:`PREPARE phimor_consultation_unread_notifications_check AS
      SELECT c.case_id, c.waiting_on, c.customer_line_user_id,
        p.pharmacist_id, p.line_user_id AS pharmacist_line_user_id,
        unread.message_sequence, unread.sender_type
      FROM consultation_cases c
      LEFT JOIN pharmacist_accounts p ON p.pharmacist_id = c.assigned_pharmacist_id
      JOIN LATERAL (
        SELECT m.message_sequence, m.sender_type FROM consultation_messages m
        WHERE m.case_id = c.case_id AND (
          (c.waiting_on = 'customer' AND m.sender_type = 'pharmacist'
            AND m.message_sequence > c.customer_last_read_sequence)
          OR (c.waiting_on = 'pharmacist' AND m.sender_type = 'customer'
            AND m.message_sequence > c.pharmacist_last_read_sequence)
        )
        ORDER BY m.message_sequence LIMIT 1
      ) unread ON TRUE
      WHERE c.state IN ('active', 'resolved')
        AND c.expires_at > CURRENT_TIMESTAMP
      ORDER BY c.updated_at, c.case_id LIMIT $1`,
  },
]);

async function run({env=process.env,PoolClass=Pool,write=(line)=>console.log(line)}={}) {
  write('PHIMOR_CONSULTATION_LIFECYCLE_PREFLIGHT');
  if (!env.DATABASE_URL) {
    write('RESULT: BLOCKED');write('reason: DATABASE_URL_REQUIRED');return {ok:false};
  }
  const pool=new PoolClass({connectionString:env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
  let client;let transactionOpen=false;
  try {
    client=await pool.connect();
    await client.query('BEGIN READ ONLY');transactionOpen=true;
    for(const table of REQUIRED_TABLES){
      const result=await client.query('SELECT to_regclass($1) AS table_name',[`public.${table}`]);
      if(!result.rows[0]?.table_name)throw Object.assign(new Error('required table missing'),{safeCode:'REQUIRED_TABLE_MISSING'});
    }
    write('required_tables: PASS');
    for(const check of PREPARE_CHECKS){
      await client.query(check.sql);await client.query(`DEALLOCATE ${check.preparedName}`);
      if(check.name==='update_case_workflow')write('update_case_workflow: PASS');
    }
    write('lifecycle_queries: PASS');
    await client.query('ROLLBACK');transactionOpen=false;
    write('RESULT: SAFE');return {ok:true};
  } catch(error) {
    if(transactionOpen&&client){try{await client.query('ROLLBACK');}catch(_){/* best effort */}}
    const postgresCode=/^[0-9A-Z]{5}$/.test(String(error?.code||''))?error.code:null;
    write('RESULT: BLOCKED');
    write(`reason: ${error?.safeCode||(postgresCode?`POSTGRES_${postgresCode}`:'PREFLIGHT_FAILED')}`);
    return {ok:false};
  } finally {
    client?.release();await pool.end();
  }
}

if(require.main===module){run().then((result)=>{if(!result.ok)process.exitCode=1;}).catch(()=>{
  console.log('RESULT: BLOCKED');console.log('reason: PREFLIGHT_START_FAILED');process.exitCode=1;
});}

module.exports={REQUIRED_TABLES,PREPARE_CHECKS,run};
