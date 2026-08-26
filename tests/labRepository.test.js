const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { createLabRepository } = require('../backend/services/labRepository');

function recorder(rows = [{}]) {
  const calls = [];
  return {
    calls,
    repository:createLabRepository({queryFn:async(sql,params=[])=>{
      calls.push({sql:String(sql),params:structuredClone(params)});
      return {rows:structuredClone(rows)};
    }}),
  };
}

test('Lab repository writes relational reports with parameterized SQL only', async () => {
  const {repository,calls}=recorder([{report_id:'LABR-1'}]);
  await repository.createReport({
    report_id:'LABR-1',report_group_id:'LABG-1',version_no:1,care_profile_id:'CP-1',
    appointment_id:null,laboratory_name:"Lab ' sensitive",hospital_name:null,
    specimen_collected_at:null,reported_at:null,supersedes_report_id:null,
    correction_reason:null,created_by_actor_type:'family_owner',created_by_actor_id:'U-1',
    created_source:'family_liff',retention_until:null,
  });
  assert.match(calls[0].sql,/INSERT INTO lab_reports/);
  assert.doesNotMatch(calls[0].sql,/Lab ' sensitive|U-1|CP-1/);
  assert.equal(calls[0].params[5],"Lab ' sensitive");
  assert.doesNotMatch(calls[0].sql,/makeTable|data\s*::?jsonb/i);
});

test('observation and source content remain query parameters rather than SQL or logs', async () => {
  const {repository,calls}=recorder([{observation_id:'LABO-1'}]);
  await repository.insertObservations('LABR-1',[{
    sourceOrdinal:1,analyteNameSource:'SECRET ANALYTE',sourceValueText:'SECRET VALUE',
    valueType:'numeric',numericValue:1,textValue:null,sourceUnit:null,
    referenceRangeText:null,referenceLow:null,referenceHigh:null,abnormalFlagSource:null,
    specimenSource:null,methodSource:null,loincCode:null,loincVerificationSource:null,
    loincVerifiedBy:null,loincVerifiedAt:null,ucumUnit:null,normalizedNumericValue:null,
    unitNormalizationSource:null,comparisonKey:null,sourcePage:1,
    sourceRegion:{x:1,y:2,width:3,height:4},extractionConfidence:null,
  }],()=> 'LABO-1');
  assert.doesNotMatch(calls[0].sql,/SECRET ANALYTE|SECRET VALUE/);
  assert.equal(calls[0].params[3],'SECRET ANALYTE');assert.equal(calls[0].params[4],'SECRET VALUE');
  assert.equal(calls[0].params[24],JSON.stringify({x:1,y:2,width:3,height:4}));
});

test('repository exposes row locks for confirmation and correction serialization', async () => {
  const {repository,calls}=recorder([]);
  await repository.findReportForUpdate('LABR-1');
  await repository.findLatestVersionForUpdate('LABG-1');
  assert.match(calls[0].sql,/WHERE report_id = \$1 FOR UPDATE/);
  assert.match(calls[1].sql,/WHERE report_group_id = \$1[\s\S]*ORDER BY version_no DESC[\s\S]*FOR UPDATE/);
});

test('confirmation and void writes use database time and guarded source states', async () => {
  const {repository,calls}=recorder([{report_id:'LABR-1'}]);
  await repository.confirmReport('LABR-1',{actorType:'family_owner',actorId:'U-1'});
  await repository.voidReport('LABR-1','เอกสารผิด');
  assert.match(calls[0].sql,/confirmed_at = CURRENT_TIMESTAMP/);
  assert.match(calls[0].sql,/WHERE report_id = \$1 AND status = 'draft'/);
  assert.match(calls[1].sql,/voided_at = CURRENT_TIMESTAMP/);
  assert.match(calls[1].sql,/WHERE report_id = \$1 AND status = 'confirmed'/);
});

test('list SQL scopes every query to Care Profile and hides drafts unless explicitly allowed', async () => {
  const {repository,calls}=recorder([]);
  await repository.listReports({careProfileId:'CP-1',includeDrafts:false,includeHistory:false,cursor:null,limit:20});
  assert.match(calls[0].sql,/WHERE care_profile_id = \$1/);
  assert.match(calls[0].sql,/status = 'confirmed'/);
  assert.match(calls[0].sql,/\$2::boolean = TRUE AND status = 'draft'/);
  assert.deepEqual(calls[0].params,['CP-1',false,false,21]);
});
