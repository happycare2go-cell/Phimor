const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../backend/migrations/0016_add_center_family_linking_integrity');

function client({ duplicateAt = null, missingTables = false } = {}) {
  const calls = [];
  let duplicateQuery = 0;
  return {
    calls,
    query:async (sql) => {
      calls.push(String(sql));
      if (String(sql).includes("to_regclass('public.")) {
        return { rows:[{ access_requests:missingTables ? null : 'accessRequests', residents:missingTables ? null : 'residents' }] };
      }
      if (/HAVING COUNT\(\*\) > 1/.test(String(sql))) {
        duplicateQuery += 1;
        return { rows:duplicateAt === duplicateQuery ? [{ value:'duplicate', count:2 }] : [] };
      }
      return { rows:[] };
    },
  };
}

test('migration 0016 is additive, preflights legacy data, and creates partial JSONB integrity indexes', async () => {
  assert.equal(migration.version, '0016');
  const db = client();
  await migration.up(db);
  const sql = db.calls.join('\n');
  assert.match(sql, /DUPLICATE|HAVING COUNT\(\*\) > 1/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_access_requests_flow_a_token_hash/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_residents_flow_a_link_request/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_residents_active_care_profile/);
  assert.match(sql, /WHERE NULLIF\(data->>'link_token_hash', ''\) IS NOT NULL/);
  assert.match(sql, /data->>'status' = 'active'/);
  assert.doesNotMatch(sql, /DELETE FROM|UPDATE\s+"?accessRequests|CREATE TABLE/i);
});

test('migration 0016 fails visibly rather than choosing or repairing duplicate legacy rows', async () => {
  await assert.rejects(migration.up(client({ duplicateAt:1 })), /DUPLICATE_CENTER_FAMILY_LINK_TOKEN_HASH/);
  await assert.rejects(migration.up(client({ duplicateAt:2 })), /DUPLICATE_CENTER_FAMILY_LINK_RESIDENT/);
  await assert.rejects(migration.up(client({ duplicateAt:3 })), /MULTIPLE_ACTIVE_RESIDENTS_FOR_CARE_PROFILE/);
  await assert.rejects(migration.up(client({ missingTables:true })), /CENTER_FAMILY_LINKING_LEGACY_TABLES_REQUIRED/);
});

test('migration 0016 rollback removes only its indexes', async () => {
  const db = client();
  await migration.down(db);
  const sql = db.calls.join('\n');
  assert.match(sql, /DROP INDEX IF EXISTS uq_access_requests_flow_a_token_hash/);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/i);
});
