const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../backend/migrations/0005_extend_consultation_payment_reliability');

async function sqlFrom(method) {
  const statements=[];
  await migration[method]({query:async(sql)=>statements.push(String(sql))});
  return statements.join('\n');
}

test('payment reliability migration is incremental version 0005', async () => {
  assert.equal(migration.version,'0005');
  assert.equal(migration.name,'extend_consultation_payment_reliability');
  const sql=await sqlFrom('up');
  assert.doesNotMatch(sql,/CREATE TABLE|DROP TABLE/);
  assert.match(sql,/ALTER TABLE payment_transactions/);
});

test('payment reliability migration adds provider paid time and retry-required state', async () => {
  const sql=await sqlFrom('up');
  assert.match(sql,/ADD COLUMN IF NOT EXISTS provider_paid_at TIMESTAMPTZ/);
  assert.match(sql,/ADD COLUMN IF NOT EXISTS provider_checkout_id VARCHAR\(160\)/);
  assert.match(sql,/'retry_required'/);
  assert.match(sql,/idx_payment_transactions_reconciliation/);
});

test('payment reliability schema stores no raw webhook payload or health context', async () => {
  const sql=await sqlFrom('up');
  assert.doesNotMatch(sql,/raw_payload|webhook_body|initial_question|care_profile|medication|health/i);
});

test('payment reliability migration has a safe explicit rollback', async () => {
  const sql=await sqlFrom('down');
  assert.match(sql,/SET processing_status = 'error'/);
  assert.match(sql,/DROP COLUMN IF EXISTS provider_paid_at/);
  assert.match(sql,/DROP COLUMN IF EXISTS provider_checkout_id/);
  assert.match(sql,/'received', 'verified', 'processed', 'rejected', 'error'/);
});
