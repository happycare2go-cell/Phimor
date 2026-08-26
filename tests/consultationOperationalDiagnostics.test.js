const test = require('node:test');
const assert = require('node:assert/strict');

const {
  databaseFailureCategory,
  recordConsultationWriteFailure,
} = require('../backend/services/consultationOperationalDiagnostics');

test('PostgreSQL failures are reduced to non-sensitive operational categories',()=>{
  assert.equal(databaseFailureCategory({code:'42P01'}),'database_schema');
  assert.equal(databaseFailureCategory({code:'23505'}),'database_constraint');
  assert.equal(databaseFailureCategory({code:'40P01'}),'database_concurrency');
  assert.equal(databaseFailureCategory({code:'08006'}),'database_connection');
  assert.equal(databaseFailureCategory(new Error('private')),'consultation_write');
});

test('write diagnostics contain only allowlisted metadata and logger failure is fail-safe',()=>{
  const events=[];
  const error=Object.assign(new Error('INSERT private message body'),{code:'42703',stack:'PRIVATE_STACK',detail:'U-LINE'});
  const correlationId=recordConsultationWriteFailure(error,{
    action:'pharmacist_message_send',logger:(event)=>events.push(event),
    correlationIdFactory:()=> 'CREF-UNIT',
  });
  assert.equal(correlationId,'CREF-UNIT');
  assert.deepEqual(Object.keys(events[0]).sort(),['action','correlationId','event','failureCategory','safeErrorCode'].sort());
  assert.doesNotMatch(JSON.stringify(events),/INSERT|private message|PRIVATE_STACK|U-LINE|42703/);
  assert.doesNotThrow(()=>recordConsultationWriteFailure(error,{
    action:'pharmacist_resolve',logger:()=>{throw new Error('logger offline');},correlationIdFactory:()=> 'CREF-LOGGER',
  }));
});
