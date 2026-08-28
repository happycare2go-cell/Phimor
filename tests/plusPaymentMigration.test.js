const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = require('../backend/migrations/0015_add_plus_payment_v1');

test('canonical migration tail reserves 0014 for shared rate limits and 0015 for Plus', () => {
  const names = fs.readdirSync(path.resolve(__dirname, '..', 'backend', 'migrations'))
    .filter((name) => /^\d{4}_.+\.js$/.test(name));
  const versions = names.map((name) => name.slice(0, 4));
  assert.equal(new Set(versions).size, versions.length);
  assert.equal(names.includes('0013_add_consultation_payment_recovery.js'), true);
  assert.equal(names.includes('0014_create_shared_rate_limit_windows.js'), true);
  assert.equal(names.includes('0015_add_plus_payment_v1.js'), true);
  assert.equal(names.includes('0014_add_plus_payment_v1.js'), false);
});

test('migration 0015 is additive and creates isolated Plus payment state', async () => {
  const statements = [];
  await migration.up({ async query(sql) { statements.push(String(sql)); return { rows: [] }; } });
  const sql = statements.join('\n');
  assert.equal(migration.version, '0015');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS plus_orders/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS plus_payment_transactions/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS source_order_id/);
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN/);
});

test('migration enforces one active actor checkout and fixed 59 THB plan', async () => {
  const statements = [];
  await migration.up({ async query(sql) { statements.push(String(sql)); return { rows: [] }; } });
  const sql = statements.join('\n');
  assert.match(sql, /amount_minor = 5900/);
  assert.match(sql, /plan_id = 'plus_30d_v1'/);
  assert.match(sql, /uq_plus_orders_active_subject/);
  assert.match(sql, /status IN \('draft', 'payment_pending'\)/);
  assert.match(sql, /status = 'paid' AND fulfillment_status <> 'granted'/);
  assert.match(sql, /UNIQUE \(provider, provider_event_id\)/);
});

test('migration rollback removes only Plus V1 additions', async () => {
  const statements = [];
  await migration.down({ async query(sql) { statements.push(String(sql)); } });
  const sql = statements.join('\n');
  assert.match(sql, /DROP TABLE IF EXISTS plus_payment_transactions/);
  assert.match(sql, /DROP TABLE IF EXISTS plus_orders/);
  assert.doesNotMatch(sql, /DROP TABLE IF EXISTS plus_entitlements/);
});
