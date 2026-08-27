const test=require('node:test');
const assert=require('node:assert/strict');
const migration=require('../backend/migrations/0012_align_care_finalization_and_routing');

async function sql(){const calls=[];await migration.up({query:async(statement)=>{calls.push(String(statement));return{rows:[]};}});return calls.join('\n');}

test('migration 0012 is the additive next migration and expands the controlled Vital registry',async()=>{
  const source=await sql();assert.equal(migration.version,'0012');assert.equal(migration.name,'align_care_finalization_and_routing');
  for(const type of ['temperature','blood_pressure_systolic','blood_pressure_diastolic','pulse','spo2','respiratory_rate','blood_glucose','weight'])assert.match(source,new RegExp(`'${type}'`));
  assert.match(source,/ADD COLUMN IF NOT EXISTS measurement_context/);
  for(const context of ['fasting','before_meal','after_meal','random','unspecified'])assert.match(source,new RegExp(`'${context}'`));
});

test('migration adds versioned Native review/finalization fields without rewriting legacy status',async()=>{
  const source=await sql();
  for(const field of ['report_group_id','version_no','supersedes_report_id','care_date','shift_code','shift_source_label','submitted_at','returned_at','return_reason','finalized_at','finalized_by_actor_reference'])assert.match(source,new RegExp(field));
  for(const status of ['recorded','submitted','changes_requested','finalized','voided'])assert.match(source,new RegExp(`'${status}'`));
  for(const event of ['submitted','returned','finalized','correction_submitted'])assert.match(source,new RegExp(`'${event}'`));
  assert.doesNotMatch(source,/UPDATE daily_care_reports\s+SET status\s*=\s*'finalized'/i);
  assert.match(source,/UNIQUE \(report_group_id, version_no\)/);
  assert.match(source,/REFERENCES daily_care_reports\(daily_report_id\) ON DELETE RESTRICT/);
});

test('migration aligns the external event contract and persists routing reconciliation state',async()=>{
  const source=await sql();
  assert.match(source,/care\.daily_report\.finalized/);
  assert.match(source,/legacy care\.daily_report\.recorded inbox rows require explicit operational review/);
  for(const field of ['expected_line_group_id','verified_line_group_id','group_reconciliation_status','notification_intent_status'])assert.match(source,new RegExp(field));
  for(const status of ['no_expected_group','verified_match','group_binding_missing','group_binding_mismatch'])assert.match(source,new RegExp(`'${status}'`));
  assert.match(source,/idx_integration_inbox_group_reconciliation/);
});

test('migration remains additive to pre-P0 clinical and Family tables',async()=>{
  const source=await sql();
  assert.doesNotMatch(source,/ALTER TABLE (careProfiles|residents|centers|groupBindings|lab_reports|doctor_visit_records)/i);
  assert.doesNotMatch(source,/DROP TABLE/i);
  assert.doesNotMatch(source,/TRUNCATE|DELETE FROM/i);
});
