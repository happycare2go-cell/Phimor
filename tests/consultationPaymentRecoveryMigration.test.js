const test=require('node:test');
const assert=require('node:assert/strict');

const migration=require('../backend/migrations/0013_add_consultation_payment_recovery');

async function upSql(rows=[]) {
  const statements=[];
  await migration.up({query:async(sql)=>{statements.push(String(sql));return {rows};}});
  return statements.join('\n');
}

test('migration 0013 is additive and provides payment recovery state',async()=>{
  assert.equal(migration.version,'0013');
  assert.equal(migration.name,'add_consultation_payment_recovery');
  const sql=await upSql();
  assert.match(sql,/ALTER TABLE consultation_orders/);
  assert.match(sql,/payment_resume_data JSONB/);
  assert.match(sql,/reconciliation_attempts INTEGER/);
  assert.match(sql,/reconciliation_next_attempt_at TIMESTAMPTZ/);
  assert.doesNotMatch(sql,/DROP TABLE|DELETE FROM|TRUNCATE/i);
});

test('migration 0013 enforces one concurrent active checkout per actor and Care Profile',async()=>{
  const sql=await upSql();
  assert.match(sql,/CREATE UNIQUE INDEX IF NOT EXISTS uq_consultation_orders_active_checkout/);
  assert.match(sql,/customer_line_user_id, care_profile_id/);
  assert.match(sql,/status IN \('draft', 'payment_pending'\)/);
  assert.match(sql,/status = 'paid' AND provisioning_status <> 'provisioned'/);
});

test('migration 0013 stops for pre-existing duplicate active checkouts instead of deleting evidence',async()=>{
  await assert.rejects(
    migration.up({query:async(sql)=>String(sql).includes('HAVING COUNT(*) > 1')
      ? {rows:[{active_count:2}]}:{rows:[]}}),
    /CONSULTATION_ACTIVE_CHECKOUT_DUPLICATES_REQUIRE_REVIEW/,
  );
});

test('migration 0013 has an explicit rollback for only its own schema',async()=>{
  const statements=[];await migration.down({query:async(sql)=>statements.push(String(sql))});
  const sql=statements.join('\n');
  assert.match(sql,/DROP INDEX IF EXISTS uq_consultation_orders_active_checkout/);
  assert.match(sql,/DROP COLUMN IF EXISTS payment_resume_data/);
  assert.match(sql,/DROP COLUMN IF EXISTS reconciliation_last_error/);
  assert.doesNotMatch(sql,/DROP TABLE|0001|0012/);
});
