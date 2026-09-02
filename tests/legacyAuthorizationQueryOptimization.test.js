const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const db = require('../backend/db');

beforeEach(() => db.resetAll());

test('explicit legacy query helper supports one and multiple equality fields with deterministic first-match semantics', async () => {
  await db.CenterStaff.insert({ staff_id:'STF-FIRST', center_id:'CTR-A', line_user_id:'U-A', role:'staff', status:'active' });
  await db.CenterStaff.insert({ staff_id:'STF-SECOND', center_id:'CTR-A', line_user_id:'U-A', role:'manager', status:'active' });
  await db.CenterStaff.insert({ staff_id:'STF-OTHER', center_id:'CTR-B', line_user_id:'U-A', role:'owner', status:'active' });

  assert.equal((await db.CenterStaff.findOneByFields({ line_user_id:'U-A' })).staff_id, 'STF-FIRST');
  assert.deepEqual(
    (await db.CenterStaff.findWhereByFields({ center_id:'CTR-A', line_user_id:'U-A' })).map((row) => row.staff_id),
    ['STF-FIRST', 'STF-SECOND'],
  );
  assert.equal(await db.CenterStaff.findOneByFields({ center_id:'CTR-MISSING', line_user_id:'U-A' }), null);
});

test('explicit legacy query validation rejects unsafe fields, empty criteria, and non-scalar values', async () => {
  await assert.rejects(db.CenterStaff.findOneByFields({ "line_user_id') OR TRUE --":'U-A' }), /INVALID_JSONB_FIELD/);
  await assert.rejects(db.CenterStaff.findOneByFields({}), /EMPTY_JSONB_CRITERIA/);
  await assert.rejects(db.CenterStaff.findOneByFields([]), /INVALID_JSONB_CRITERIA/);
  await assert.rejects(db.CenterStaff.findOneByFields({ line_user_id:{ raw:'U-A' } }), /INVALID_JSONB_CRITERIA_VALUE/);
});

test('SQL-looking criteria values remain parameter data and production query contract matches memory equality semantics', async () => {
  const injected = "U-A' OR TRUE --";
  await db.CenterStaff.insert({ staff_id:'STF-SAFE', center_id:'CTR-A', line_user_id:injected, status:'active' });
  assert.equal((await db.CenterStaff.findOneByFields({ center_id:'CTR-A', line_user_id:injected })).staff_id, 'STF-SAFE');

  const statement = db.buildExplicitFieldQuery('centerStaff', {
    line_user_id:injected, center_id:'CTR-A',
  }, { limitOne:true });
  assert.deepEqual(statement.values, ['CTR-A', injected]);
  assert.match(statement.sql, /data->>'center_id' = \$1 AND data->>'line_user_id' = \$2/);
  assert.match(statement.sql, /ORDER BY created_at ASC, id ASC LIMIT 1$/);
  assert.doesNotMatch(statement.sql, /OR TRUE|U-A'/);
  assert.deepEqual(
    db.normalizeExplicitCriteria({ line_user_id:injected, center_id:'CTR-A' }),
    statement.entries,
  );
});

test('explicit criteria compares persisted JSON scalar text consistently', () => {
  const entries = db.normalizeExplicitCriteria({ enabled:true, sequence:2 });
  assert.equal(db.recordMatchesExplicitCriteria({ enabled:true, sequence:2 }, entries), true);
  assert.equal(db.recordMatchesExplicitCriteria({ enabled:'true', sequence:'2' }, entries), true);
  assert.equal(db.recordMatchesExplicitCriteria({ enabled:true, sequence:null }, entries), false);
});
