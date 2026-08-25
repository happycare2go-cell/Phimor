const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../backend/migrations/0004_create_pharmacist_consultation_v1');

async function sqlFrom(method) {
  const statements = [];
  await migration[method]({ query: async (sql) => { statements.push(String(sql)); } });
  return statements.join('\n');
}

test('consultation migration is version 0004 and creates six relational tables', async () => {
  assert.equal(migration.version, '0004');
  assert.equal(migration.name, 'create_pharmacist_consultation_v1');
  const sql = await sqlFrom('up');
  for (const table of [
    'pharmacist_accounts', 'consultation_orders', 'payment_transactions',
    'consultation_cases', 'consultation_messages', 'consultation_events',
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.doesNotMatch(sql, /makeTable|CREATE TABLE IF NOT EXISTS "consultation/i);
});

test('order schema snapshots fixed price, currency, duration and terms evidence', async () => {
  const sql = await sqlFrom('up');
  assert.match(sql, /amount_minor INTEGER NOT NULL DEFAULT 10000[\s\S]*CHECK \(amount_minor = 10000\)/);
  assert.match(sql, /currency CHAR\(3\) NOT NULL DEFAULT 'THB'[\s\S]*CHECK \(currency = 'THB'\)/);
  assert.match(sql, /duration_minutes INTEGER NOT NULL DEFAULT 1440[\s\S]*CHECK \(duration_minutes = 1440\)/);
  assert.match(sql, /terms_version VARCHAR\(80\) NOT NULL/);
  assert.match(sql, /terms_accepted_at TIMESTAMPTZ NOT NULL/);
  assert.match(sql, /CHECK \(\(status = 'paid'\) = \(paid_at IS NOT NULL\)\)/);
});

test('payment schema protects callback and case provisioning idempotency', async () => {
  const sql = await sqlFrom('up');
  assert.match(sql, /UNIQUE \(provider, provider_event_id\)/);
  assert.match(sql, /order_id VARCHAR\(80\) NOT NULL UNIQUE/);
  assert.match(sql, /idx_payment_transactions_reconciliation/);
  assert.match(sql, /signature_verified BOOLEAN NOT NULL DEFAULT FALSE/);
});

test('case schema enforces state, assignment and exact 24-hour window', async () => {
  const sql = await sqlFrom('up');
  for (const state of ['queued', 'active', 'resolved', 'closed']) assert.match(sql, new RegExp(`'${state}'`));
  assert.match(sql, /expires_at = accepted_at \+ INTERVAL '24 hours'/);
  assert.match(sql, /state = 'queued' AND assigned_pharmacist_id IS NULL/);
  assert.match(sql, /state IN \('active', 'resolved', 'closed'\) AND assigned_pharmacist_id IS NOT NULL/);
  assert.match(sql, /idx_consultation_cases_queue/);
  assert.match(sql, /idx_consultation_cases_expiration/);
});

test('message schema is immutable, ordered, idempotent, text-only and limited to 4000 chars', async () => {
  const sql = await sqlFrom('up');
  const messageTable = sql.match(/CREATE TABLE IF NOT EXISTS consultation_messages \([\s\S]*?\n      \)/)[0];
  assert.match(messageTable, /message_sequence BIGINT GENERATED ALWAYS AS IDENTITY/);
  assert.match(messageTable, /char_length\(body\) BETWEEN 1 AND 4000/);
  assert.match(messageTable, /UNIQUE \(case_id, message_sequence\)/);
  assert.match(messageTable, /UNIQUE \(case_id, idempotency_key\)/);
  assert.doesNotMatch(messageTable, /attachment|updated_at/i);
  assert.match(sql, /CREATE TRIGGER trg_consultation_messages_immutable/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON consultation_messages/);
});

test('pharmacist accounts are a dedicated least-privilege identity table', async () => {
  const sql = await sqlFrom('up');
  assert.match(sql, /line_user_id VARCHAR\(128\) NOT NULL UNIQUE/);
  assert.match(sql, /license_number VARCHAR\(80\) NOT NULL UNIQUE/);
  assert.match(sql, /'invited', 'active', 'suspended', 'inactive'/);
  assert.doesNotMatch(sql, /REFERENCES\s+(?:"?AdminUsers|"?centerStaff)/i);
});

test('migration adds minimal consultation linkage to AI audit without raw content', async () => {
  const sql = await sqlFrom('up');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS consultation_case_id/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS requester_type/);
  assert.doesNotMatch(sql, /raw_prompt|raw_response|clinical_context/);
});

test('migration down reverses AI audit extension and all consultation tables', async () => {
  const sql = await sqlFrom('down');
  assert.match(sql, /DROP COLUMN IF EXISTS consultation_case_id/);
  assert.match(sql, /DROP COLUMN IF EXISTS requester_type/);
  assert.match(sql, /DROP FUNCTION IF EXISTS reject_consultation_message_mutation/);
  for (const table of [
    'consultation_events', 'consultation_messages', 'consultation_cases',
    'payment_transactions', 'consultation_orders', 'pharmacist_accounts',
  ]) assert.match(sql, new RegExp(`DROP TABLE IF EXISTS ${table}`));
});
