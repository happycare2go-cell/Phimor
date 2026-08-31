process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {
  UPDATE_CASE_WORKFLOW_SQL,createConsultationRepository,
}=require('../backend/services/consultationRepository');
const {createConsultationExpirationService}=require('../backend/services/consultationExpirationService');
const {
  createConsultationLifecycleSchedulerService,
}=require('../backend/services/consultationLifecycleSchedulerService');
const {
  createSchedulerCoordinatorService,safeSchedulerError,
}=require('../backend/services/schedulerCoordinatorService');
const {
  REQUIRED_TABLES,PREPARE_CHECKS,run:runPreflight,
}=require('../backend/scripts/preflight-consultation-lifecycle');

test('updateCaseWorkflow explicitly types state in assignment and literal comparison',async()=>{
  const calls=[];
  const repository=createConsultationRepository({queryFn:async(sql,params)=>{
    calls.push({sql:String(sql),params});
    return {rows:[{case_id:params[0],state:params[1],waiting_on:params[2],
      resolved_at:params[1]==='resolved'?'2026-08-31T00:00:00.000Z':'2026-08-30T00:00:00.000Z',
      closed_at:params[3],close_reason:params[4]}]};
  }});
  const transitions=[
    ['queued','none'],['active','customer'],['active','pharmacist'],
    ['resolved','none'],['closed','none'],
  ];
  for(const [state,waitingOn] of transitions){
    const result=await repository.updateCaseWorkflow('CASE-1',{state,waitingOn,
      closedAt:state==='closed'?'2026-08-31T00:00:00.000Z':null,
      closeReason:state==='closed'?'expired':null});
    assert.equal(result.state,state);assert.equal(result.waiting_on,waitingOn);
  }
  assert.equal(calls.every((call)=>call.sql===UPDATE_CASE_WORKFLOW_SQL),true);
  assert.match(UPDATE_CASE_WORKFLOW_SQL,/state\s*=\s*\$2::varchar/);
  assert.match(UPDATE_CASE_WORKFLOW_SQL,/CASE\s+WHEN\s+\$2::varchar\s*=\s*'resolved'/);
  assert.match(UPDATE_CASE_WORKFLOW_SQL,/ELSE\s+resolved_at\s+END/);
  assert.match(UPDATE_CASE_WORKFLOW_SQL,/closed_at\s*=\s*COALESCE\(\$4,\s*closed_at\)/);
  assert.match(UPDATE_CASE_WORKFLOW_SQL,/close_reason\s*=\s*COALESCE\(\$5,\s*close_reason\)/);
});

test('invalid workflow state and waiting pair fails before SQL',async()=>{
  let queries=0;
  const repository=createConsultationRepository({queryFn:async()=>{queries+=1;return {rows:[]};}});
  await assert.rejects(repository.updateCaseWorkflow('CASE-1',{state:'resolved',waitingOn:'customer'}),
    {code:'INVALID_WAITING_ON_STATE'});
  await assert.rejects(repository.updateCaseWorkflow('CASE-1',{state:'active',waitingOn:'none'}),
    {code:'INVALID_WAITING_ON_STATE'});
  assert.equal(queries,0);
});

test('expiration workflow rolls back case mutation when its audit event fails',async()=>{
  const state={consultationCase:{case_id:'CASE-1',state:'active',waiting_on:'pharmacist',
    expires_at:'2026-08-30T00:00:00.000Z',database_now:'2026-08-31T00:00:00.000Z'},events:[]};
  const transaction=async(_key,action)=>{
    const before=structuredClone(state);
    try{return await action();}catch(error){state.consultationCase=before.consultationCase;state.events=before.events;throw error;}
  };
  const repository={
    async findCaseForUpdate(){return structuredClone(state.consultationCase);},
    async updateCaseWorkflow(_id,patch){Object.assign(state.consultationCase,{state:patch.state,waiting_on:patch.waitingOn,
      closed_at:patch.closedAt,close_reason:patch.closeReason});return structuredClone(state.consultationCase);},
    async insertEvent(){throw Object.assign(new Error('private database detail'),{code:'42P08'});},
  };
  const service=createConsultationExpirationService({repository,transaction,realtime:{async publish(){}}});
  await assert.rejects(service.materializeCase('CASE-1'),{code:'42P08'});
  assert.equal(state.consultationCase.state,'active');assert.equal(state.consultationCase.closed_at,undefined);
  assert.deepEqual(state.events,[]);
});

test('expiration sweep is bounded and no-work completes without writes',async()=>{
  let receivedLimit=null;let writes=0;
  const repository={
    async listExpiredCaseIds(limit){receivedLimit=limit;return [];},
    async updateCaseWorkflow(){writes+=1;},async insertEvent(){writes+=1;},
  };
  const service=createConsultationExpirationService({repository,transaction:async(_key,action)=>action()});
  assert.deepEqual(await service.sweepExpired({limit:999}),{scanned:0,closed:0});
  assert.equal(receivedLimit,500);assert.equal(writes,0);
});

test('lifecycle scheduler annotates the failing bounded operation without payloads',async()=>{
  const failure=Object.assign(new Error('query and parameter details'),{code:'42P08',routine:'parse_param'});
  const service=createConsultationLifecycleSchedulerService({
    lockService:{async runWithLock(_key,task){return task();}},
    reconciliation:{async sweepPendingOrders(){return {scanned:0};}},
    expiration:{async sweepExpired(){throw failure;}},
    notifications:{async enqueueDueNotifications(){throw new Error('must not run after failure');}},
  });
  await assert.rejects(service.runDueWork(),failure);
  assert.equal(failure.safeOperation,'expiration_sweep');
});

test('scheduler diagnostics retain only safe PostgreSQL metadata',async()=>{
  const log=[];let tick=0;
  const coordinator=createSchedulerCoordinatorService({
    lockService:{async runWithLock(_key,task){return task();}},
    now:()=>new Date(`2026-08-31T00:00:0${tick++}.000Z`),
    logger:{error(...args){log.push(args);},info(){}},
  });
  const failure=Object.assign(new Error('patient question and SQL parameters'),{
    code:'42P08',routine:'parse_param',constraint:'consultation_cases_state_check',
    safeOperation:'expiration_sweep',detail:'private payload',parameters:['private'],
  });
  await assert.rejects(coordinator.run('consultationLifecycle',async()=>{throw failure;}),failure);
  const diagnostic=safeSchedulerError(failure);
  assert.deepEqual(diagnostic,{
    errorCode:'SCHEDULED_JOB_FAILED',postgresCode:'42P08',postgresRoutine:'parse_param',
    postgresConstraint:'consultation_cases_state_check',operation:'expiration_sweep',
  });
  const serialized=JSON.stringify({log,health:coordinator.health()});
  assert.match(serialized,/42P08/);assert.match(serialized,/expiration_sweep/);
  assert.doesNotMatch(serialized,/patient question|SQL parameters|private payload|parameters/);
});

test('consultation lifecycle preflight is read-only and prepares every SQL contract',async()=>{
  const queries=[];const output=[];
  class FakePool{
    async connect(){return {query:async(sql,params)=>{
      queries.push({sql:String(sql),params});
      if(String(sql).startsWith('SELECT to_regclass'))return {rows:[{table_name:params[0]}]};
      return {rows:[]};
    },release(){queries.push({sql:'RELEASE'});}};}
    async end(){queries.push({sql:'END'});}
  }
  const result=await runPreflight({env:{DATABASE_URL:'postgres://not-printed'},PoolClass:FakePool,
    write:(line)=>output.push(line)});
  assert.equal(result.ok,true);
  assert.deepEqual(output,[
    'PHIMOR_CONSULTATION_LIFECYCLE_PREFLIGHT','required_tables: PASS',
    'update_case_workflow: PASS','lifecycle_queries: PASS','RESULT: SAFE',
  ]);
  assert.equal(queries.filter((item)=>item.sql.startsWith('SELECT to_regclass')).length,REQUIRED_TABLES.length);
  assert.equal(queries.filter((item)=>item.sql.startsWith('PREPARE ')).length,PREPARE_CHECKS.length);
  assert.equal(queries.some((item)=>/^EXECUTE\b/.test(item.sql)),false);
  assert.deepEqual(queries.filter((item)=>item.sql==='BEGIN READ ONLY'||item.sql==='ROLLBACK').map((item)=>item.sql),
    ['BEGIN READ ONLY','ROLLBACK']);
  assert.doesNotMatch(JSON.stringify(output),/postgres:\/\//);
});

test('consultation lifecycle preflight command is registered and makes no executed mutation',()=>{
  const root=path.resolve(__dirname,'..');
  const source=fs.readFileSync(path.join(root,'backend','scripts','preflight-consultation-lifecycle.js'),'utf8');
  const packageJson=JSON.parse(fs.readFileSync(path.join(root,'backend','package.json'),'utf8'));
  assert.equal(packageJson.scripts['preflight:consultation-lifecycle'],'node scripts/preflight-consultation-lifecycle.js');
  assert.match(source,/BEGIN READ ONLY/);assert.match(source,/PREPARE phimor_consultation_update_workflow_check/);
  assert.match(source,/ROLLBACK/);assert.doesNotMatch(source,/\bEXECUTE\b|client\.query\(['"`]INSERT|client\.query\(['"`]DELETE/);
  assert.doesNotMatch(source,/console\.log\s*\(\s*process\.env\.DATABASE_URL/);
});
