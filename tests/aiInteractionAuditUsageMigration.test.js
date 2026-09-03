const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../backend/migrations/0018_extend_ai_interaction_audit_usage');

test('migration 0018 additively extends AI audit with metadata-only nullable usage fields', async () => {
  const statements=[];
  await migration.up({async query(sql){statements.push(String(sql));return{rows:[]};}});
  const sql=statements.join('\n');
  assert.equal(migration.version,'0018');
  assert.equal(migration.name,'extend_ai_interaction_audit_usage');
  assert.match(sql,/ALTER TABLE ai_interaction_audit/i);
  for(const column of ['research_plan_version','input_tokens','output_tokens','total_tokens','reasoning_tokens','web_search_calls','source_count','research_performed']){
    assert.match(sql,new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`,'i'));
  }
  for(const column of ['input_tokens','output_tokens','total_tokens','reasoning_tokens','web_search_calls','source_count']){
    assert.match(sql,new RegExp(`${column} INTEGER\\s+CHECK \\(${column} IS NULL OR ${column} >= 0\\)`,'i'));
    assert.doesNotMatch(sql,new RegExp(`${column}[^,]*DEFAULT\\s+0`,'i'));
  }
  assert.match(sql,/research_performed BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.doesNotMatch(sql,/\b(?:UPDATE|INSERT|DELETE|CREATE INDEX)\b/i);
  assert.doesNotMatch(sql,/JSONB|prompt|conversation|patient|medication|lab|response_text|search_query|web_page/i);
});

test('migration 0018 rollback removes only its added columns',async()=>{
  const statements=[];
  await migration.down({async query(sql){statements.push(String(sql));return{rows:[]};}});
  const sql=statements.join('\n');
  assert.match(sql,/ALTER TABLE ai_interaction_audit/i);
  for(const column of ['research_performed','source_count','web_search_calls','reasoning_tokens','total_tokens','output_tokens','input_tokens','research_plan_version']){
    assert.match(sql,new RegExp(`DROP COLUMN IF EXISTS ${column}`,'i'));
  }
  assert.doesNotMatch(sql,/DROP TABLE|DROP INDEX|DELETE|UPDATE/i);
});
