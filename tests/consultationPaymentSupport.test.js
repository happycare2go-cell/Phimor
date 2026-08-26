const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const {
  createConsultationPaymentSupportService, normalizePaymentReference,
} = require('../backend/services/consultationPaymentSupportService');
const { createConsultationRepository } = require('../backend/services/consultationRepository');

const ROW = {
  order_id:'ORD-REFERENCE-1', order_status:'paid', provisioning_status:'provisioned',
  amount_minor:10000, currency:'THB', provider:'omise', provider_checkout_id:'chrg_test_1',
  payment_due_at:'2026-08-26T10:15:00Z', paid_at:'2026-08-26T10:03:00Z',
  created_at:'2026-08-26T10:00:00Z', updated_at:'2026-08-26T10:03:00Z',
  case_id:'CASE-1', case_state:'queued', queued_at:'2026-08-26T10:03:01Z',
  accepted_at:null, expires_at:null, closed_at:null, close_reason:null,
  provider_event_id:'evnt_test_1', provider_payment_id:'chrg_test_1',
  payment_processing_status:'processed', payment_failure_code:null,
  payment_received_at:'2026-08-26T10:03:00Z', payment_processed_at:'2026-08-26T10:03:01Z',
  customer_line_user_id:'U-SECRET', initial_question:'SECRET HEALTH QUESTION', care_profile_id:'CP-SECRET',
};

test('payment support lookup maps a PHIMOR reference to Omise charge and case without health identity data',async()=>{
  const service=createConsultationPaymentSupportService({repository:{async findPaymentSupportRecord(reference){assert.equal(reference,'ORD-REFERENCE-1');return ROW;}}});
  const result=await service.lookup({reference:' ORD-REFERENCE-1 '});
  assert.equal(result.paymentReference,'ORD-REFERENCE-1');assert.equal(result.providerChargeId,'chrg_test_1');assert.equal(result.caseId,'CASE-1');
  const serialized=JSON.stringify(result);
  for(const secret of ['U-SECRET','SECRET HEALTH QUESTION','CP-SECRET','customer_line_user_id','initial_question','care_profile_id'])assert.equal(serialized.includes(secret),false,secret);
});

test('payment support lookup rejects malformed references and fails safely when not found',async()=>{
  for(const value of ['', 'bad reference', 'x'.repeat(161)])assert.throws(()=>normalizePaymentReference(value),{code:'INVALID_PAYMENT_REFERENCE'});
  const service=createConsultationPaymentSupportService({repository:{async findPaymentSupportRecord(){return null;}}});
  await assert.rejects(()=>service.lookup({reference:'ORD-NOT-FOUND'}),{code:'PAYMENT_REFERENCE_NOT_FOUND'});
});

test('repository payment support lookup is exact, parameterized and covers order/case/charge/event references',async()=>{
  const calls=[];const repository=createConsultationRepository({queryFn:async(sql,params)=>{calls.push({sql:String(sql),params});return {rows:[]};}});
  await repository.findPaymentSupportRecord('chrg_test_1');
  assert.deepEqual(calls[0].params,['chrg_test_1']);
  assert.match(calls[0].sql,/o\.order_id = \$1/);assert.match(calls[0].sql,/c\.case_id = \$1/);
  assert.match(calls[0].sql,/o\.provider_checkout_id = \$1/);assert.match(calls[0].sql,/lookup\.provider_payment_id = \$1/);assert.match(calls[0].sql,/lookup\.provider_event_id = \$1/);
  assert.doesNotMatch(calls[0].sql,/initial_question|customer_line_user_id|care_profile_id/);
});

test('System Admin exposes an authenticated exact-reference support tool without health search fields',()=>{
  const adminRoute=fs.readFileSync(path.join(__dirname,'..','backend','routes','admin.js'),'utf8');
  const adminUi=fs.readFileSync(path.join(__dirname,'..','liff-app','system-admin','index.html'),'utf8');
  assert.ok(adminRoute.indexOf('router.use(requireAdminKey)') < adminRoute.indexOf("router.get('/consultation-payments/lookup'"));
  assert.match(adminUi,/เลขอ้างอิง PHIMOR/);
  assert.match(adminUi,/\/api\/admin\/consultation-payments\/lookup\?reference=/);
  assert.match(adminUi,/Omise Charge ID/);
  assert.doesNotMatch(adminUi,/ค้นหาด้วยชื่อยา|ค้นหาด้วยคำถามสุขภาพ|LINE access token/);
});
