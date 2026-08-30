const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
process.env.NODE_ENV='test';

const {REQUIRED_TABLES,CHECK_SQL,printResult}=require('../backend/scripts/preflight-medication-v2');
const source=fs.readFileSync(path.resolve(__dirname,'../backend/scripts/preflight-medication-v2.js'),'utf8');

test('preflight covers every required medication integrity aggregate',()=>{
  assert.deepEqual(REQUIRED_TABLES,['medicationSnapshots','medications','careProfiles']);
  for(const name of ['duplicate_normalized_name_groups','duplicate_stable_id_groups','timestamp_tie_groups',
    'linked_embedded_mismatch_snapshots','orphan_linked_medication_rows','unsnapshotted_legacy_medication_rows',
    'equally_authoritative_care_profiles'])assert.match(CHECK_SQL,new RegExp(name));
});

test('preflight SQL and table check are read-only',()=>{
  assert.match(CHECK_SQL.trim(),/^WITH\s/i);
  assert.doesNotMatch(CHECK_SQL,/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(source,/\.query\(\s*[`'"]\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)/i);
});

test('preflight output source never prints clinical or identity columns',()=>{
  const outputSection=source.slice(source.indexOf('function printResult'),source.indexOf('async function main'));
  assert.doesNotMatch(outputSection,/patient_name|line_user|dose|strength|token_hash/);
  assert.match(outputSection,/SAFE_FOR_CONTROLLED_V2_ROLLOUT/);
  assert.match(outputSection,/BLOCKED_REVIEW_REQUIRED/);
});

test('preflight result prints deterministic aggregate counts and blocks duplicate authority',()=>{
  const lines=[];const original=console.log;console.log=(value)=>lines.push(String(value));
  try{printResult({duplicate_normalized_name_groups:1,duplicate_stable_id_groups:0,timestamp_tie_groups:2,
    linked_embedded_mismatch_snapshots:3,orphan_linked_medication_rows:4,unsnapshotted_legacy_medication_rows:5,
    equally_authoritative_care_profiles:1});}finally{console.log=original}
  assert.deepEqual(lines,[
    'PHIMOR_MEDICATION_V2_PREFLIGHT','required_tables: PASS','duplicate_normalized_name_groups: 1',
    'duplicate_stable_id_groups: 0','timestamp_tie_groups: 2','linked_embedded_mismatch_snapshots: 3',
    'orphan_linked_medication_rows: 4','unsnapshotted_legacy_medication_rows: 5','equally_authoritative_care_profiles: 1',
    'RESULT: BLOCKED_REVIEW_REQUIRED','reason: duplicate or ambiguous authoritative current medication state requires controlled review',
  ]);
});
