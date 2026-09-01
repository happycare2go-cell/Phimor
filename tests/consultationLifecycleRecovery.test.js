const test=require('node:test');
const assert=require('node:assert/strict');

process.env.NODE_ENV='test';

const {createDistributedJobLockService}=require('../backend/services/distributedJobLockService');
const {createConsultationLifecycleNotificationService,NEAR_EXPIRY_MILESTONE_MINUTES}=require('../backend/services/consultationLifecycleNotificationService');
const {createConsultationLifecycleSchedulerService}=require('../backend/services/consultationLifecycleSchedulerService');
const {createConsultationRepository}=require('../backend/services/consultationRepository');

test('distributed scheduler owns one PostgreSQL advisory session lock and always releases it',async()=>{
  const queries=[];let released=0;
  const service=createDistributedJobLockService({acquireClient:async()=>({query:async(sql,params)=>{queries.push({sql:String(sql),params});return {rows:[{acquired:true}]};},release(){released+=1;}})});
  const result=await service.runWithLock('job-key',async()=>({ok:true}));
  assert.deepEqual(result,{acquired:true,skipped:false,result:{ok:true}});
  assert.match(queries[0].sql,/pg_try_advisory_lock/);assert.match(queries[1].sql,/pg_advisory_unlock/);
  assert.deepEqual(queries.map((item)=>item.params),[['job-key'],['job-key']]);assert.equal(released,1);
});

test('consultation lifecycle business service does not acquire a redundant scheduler lock',async()=>{
  let payment=0,expiry=0,notifications=0;
  const service=createConsultationLifecycleSchedulerService({
    lockService:{async runWithLock(){throw new Error('redundant lock must not run');}},
    reconciliation:{async sweepPendingOrders(){payment+=1;}},expiration:{async sweepExpired(){expiry+=1;}},notifications:{async enqueueDueNotifications(){notifications+=1;}},
  });
  assert.deepEqual(await service.runDueWork(),{payment:undefined,expired:undefined,notification:undefined});
  assert.deepEqual({payment,expiry,notifications},{payment:1,expiry:1,notifications:1});
});

test('coordinator-owned lifecycle work runs payment, expiry and notifications in order',async()=>{
  const order=[];
  const service=createConsultationLifecycleSchedulerService({
    reconciliation:{async sweepPendingOrders(){order.push('payment');return {processed:1};}},
    expiration:{async sweepExpired(){order.push('expiry');return {closed:1};}},
    notifications:{async enqueueDueNotifications(){order.push('notification');return {queued:2};}},
  });
  const result=await service.runDueWork();
  assert.deepEqual(order,['payment','expiry','notification']);assert.equal(result.payment.processed,1);assert.equal(result.expired.closed,1);
});

function lifecycleHarness() {
  const calls=[];const dedupe=new Set();
  const repository={
    async listAcceptedNotificationCandidates(){return [{case_id:'CASE-1',customer_line_user_id:'U-FAMILY'}];},
    async listClosedNotificationCandidates(){return [{case_id:'CASE-2',customer_line_user_id:'U-FAMILY'}];},
    async listNearExpiryNotificationCandidates(minutes){assert.equal(minutes,120);return [{case_id:'CASE-3',customer_line_user_id:'U-FAMILY'}];},
    async listUnreadMessageNotificationCandidates(){return [
      {case_id:'CASE-4',waiting_on:'customer',customer_line_user_id:'U-FAMILY',pharmacist_id:'PH-1',pharmacist_line_user_id:'U-PHARM',message_sequence:5},
      {case_id:'CASE-5',waiting_on:'pharmacist',customer_line_user_id:'U-FAMILY',pharmacist_id:'PH-1',pharmacist_line_user_id:'U-PHARM',message_sequence:7},
    ];},
  };
  const service=createConsultationLifecycleNotificationService({repository,env:{LIFF_ID_FAMILY:'2000000000-FAMILY',LIFF_ID_PHARMACIST:'2000000000-PHARM'},now:()=>new Date('2026-08-28T03:00:00Z'),enqueue:async(input)=>{calls.push(input);const duplicate=dedupe.has(input.dedupeKey);dedupe.add(input.dedupeKey);return {ok:true,duplicate};}});
  return {calls,service};
}

test('approved consultation lifecycle notifications are minimal, recipient-specific and idempotent',async()=>{
  const h=lifecycleHarness();
  assert.deepEqual(await h.service.enqueueDueNotifications(),{queued:5,duplicate:0,skipped:0});
  assert.deepEqual(await h.service.enqueueDueNotifications(),{queued:0,duplicate:5,skipped:0});
  assert.equal(new Set(h.calls.map((item)=>item.dedupeKey)).size,5);
  assert.ok(h.calls.some((item)=>item.kind==='consultation_accepted'&&item.to==='U-FAMILY'));
  assert.ok(h.calls.some((item)=>item.kind==='consultation_new_message'&&item.to==='U-PHARM'));
  assert.ok(h.calls.some((item)=>item.kind==='consultation_expiring_soon'));
  assert.ok(h.calls.some((item)=>item.kind==='consultation_closed'));
  const visible=JSON.stringify(h.calls.map((item)=>item.messages));
  assert.match(visible,/เภสัชกรรับเคสแล้ว/);assert.match(visible,/เหลือเวลาอีกประมาณ 2 ชั่วโมง/);assert.match(visible,/สิ้นสุดแล้ว/);
  assert.doesNotMatch(visible,/CASE-|U-FAMILY|U-PHARM|question|medication|payment|Omise/i);
});

test('new-message candidate SQL uses opposite sender read cursor and suppresses room-active reads',async()=>{
  const calls=[];const repository=createConsultationRepository({queryFn:async(sql,params)=>{calls.push({sql:String(sql),params});return {rows:[]};}});
  await repository.listUnreadMessageNotificationCandidates(50);
  const sql=calls[0].sql;
  assert.match(sql,/c\.waiting_on = 'customer'.*m\.sender_type = 'pharmacist'/s);
  assert.match(sql,/m\.message_sequence > c\.customer_last_read_sequence/);
  assert.match(sql,/c\.waiting_on = 'pharmacist'.*m\.sender_type = 'customer'/s);
  assert.match(sql,/m\.message_sequence > c\.pharmacist_last_read_sequence/);
  assert.match(sql,/ORDER BY m\.message_sequence\s+LIMIT 1/s);
  assert.equal(NEAR_EXPIRY_MILESTONE_MINUTES,120);
});

test('lifecycle notifications fail closed when LIFF runtime configuration is unavailable',async()=>{
  let enqueues=0;
  const rows={
    async listAcceptedNotificationCandidates(){return [{case_id:'CASE-1',customer_line_user_id:'U-1'}];},async listClosedNotificationCandidates(){return [];},
    async listNearExpiryNotificationCandidates(){return [];},async listUnreadMessageNotificationCandidates(){return [];},
  };
  const service=createConsultationLifecycleNotificationService({repository:rows,env:{},enqueue:async()=>{enqueues+=1;}});
  assert.deepEqual(await service.enqueueDueNotifications(),{queued:0,duplicate:0,skipped:1});assert.equal(enqueues,0);
});
