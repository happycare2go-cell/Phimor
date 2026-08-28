process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDailyCareRepository } = require('../backend/services/dailyCareRepository');
const { createVitalSignRepository } = require('../backend/services/vitalSignRepository');

function recorder(factory) {
  const calls=[];
  return { calls, repository:factory({ queryFn:async(sql,params=[]) => {
    calls.push({ sql:String(sql), params:structuredClone(params) }); return { rows:[] };
  } }) };
}

test('Daily Care Family projection selects only the latest finalized-or-voided authority boundary', async () => {
  const { repository, calls }=recorder(createDailyCareRepository);
  await repository.listHistory({ careProfileId:'CP-1', centerId:null, from:null, to:null, cursor:null, limit:20 });
  assert.match(calls[0].sql, /d\.status='finalized'/);
  assert.match(calls[0].sql, /MAX\(candidate\.version_no\)/);
  assert.match(calls[0].sql, /candidate\.status='voided' AND candidate\.finalized_at IS NOT NULL/);
  assert.deepEqual(calls[0].params, ['CP-1', 21]);

  await repository.findAuthoritativeFinalized('DCR-1');
  assert.match(calls[1].sql, /d\.daily_report_id=\$1 AND d\.status='finalized'/);
  assert.match(calls[1].sql, /candidate\.status='voided' AND candidate\.finalized_at IS NOT NULL/);
});

test('Vital Family projection keeps standalone recorded sets and gates linked sets by authoritative finalized Daily Care', async () => {
  const { repository, calls }=recorder(createVitalSignRepository);
  await repository.listHistory({ careProfileId:'CP-1', limit:20 });
  const sql=calls[0].sql;
  assert.match(sql, /NOT EXISTS[\s\S]*daily_care_vital_links/);
  assert.match(sql, /EXISTS[\s\S]*report\.status = 'finalized'/);
  assert.match(sql, /MAX\(candidate\.version_no\)/);
  assert.match(sql, /candidate\.status = 'voided' AND candidate\.finalized_at IS NOT NULL/);
  assert.doesNotMatch(sql, /UPDATE|DELETE/i);
  assert.deepEqual(calls[0].params, ['CP-1', 21]);
});
