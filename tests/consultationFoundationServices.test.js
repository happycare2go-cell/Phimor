const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const db = require('../backend/db');
const {
  CONSULTATION_PRICE_MINOR, CONSULTATION_CURRENCY, CONSULTATION_DURATION_MINUTES,
  effectiveConsultationState,
} = require('../backend/domain/consultation');
const { createConsultationOrderService } = require('../backend/services/consultationOrderService');
const { createConsultationPaymentService } = require('../backend/services/consultationPaymentService');
const { createConsultationCaseService } = require('../backend/services/consultationCaseService');
const { createConsultationMessageService } = require('../backend/services/consultationMessageService');
const { createPharmacistAccountService } = require('../backend/services/pharmacistAccountService');
const { PaymentProvider } = require('../backend/providers/PaymentProvider');

function clone(value) { return structuredClone(value); }

function createMemoryHarness({ now = '2026-08-25T03:00:00.000Z' } = {}) {
  const state = {
    orders: new Map(), payments: new Map(), cases: new Map(), messages: [], events: [],
    pharmacists: new Map([
      ['U-PHARM-1', { pharmacist_id:'PH-1', line_user_id:'U-PHARM-1', display_name:'เภสัชกรหนึ่ง', license_number:'LIC-1', license_verified_at:'2026-01-01T00:00:00Z', status:'active' }],
      ['U-PHARM-2', { pharmacist_id:'PH-2', line_user_id:'U-PHARM-2', display_name:'เภสัชกรสอง', license_number:'LIC-2', license_verified_at:'2026-01-01T00:00:00Z', status:'active' }],
      ['U-PHARM-S', { pharmacist_id:'PH-S', line_user_id:'U-PHARM-S', display_name:'ถูกระงับ', license_number:'LIC-S', license_verified_at:'2026-01-01T00:00:00Z', status:'suspended' }],
    ]),
    sequence: 0, profileWrites: 0, healthHistoryWrites: 0,
  };
  let clock = now;
  const locks = new Map();

  const transaction = async (key, fn) => {
    const prior = locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    locks.set(key, prior.then(() => gate));
    await prior;
    const snapshot = clone({
      orders:[...state.orders], payments:[...state.payments], cases:[...state.cases],
      messages:state.messages, events:state.events, sequence:state.sequence,
    });
    try { return await fn(); }
    catch (error) {
      state.orders = new Map(snapshot.orders); state.payments = new Map(snapshot.payments);
      state.cases = new Map(snapshot.cases); state.messages = snapshot.messages;
      state.events = snapshot.events; state.sequence = snapshot.sequence;
      throw error;
    } finally { release(); }
  };

  const repository = {
    async createOrder(record) {
      const row = { ...clone(record), status:'draft', provisioning_status:'pending', paid_at:null };
      state.orders.set(row.order_id, row); return clone(row);
    },
    async findOrderForUpdate(id) { return clone(state.orders.get(id) || null); },
    async insertPaymentTransaction(record) {
      const key = `${record.provider}:${record.provider_event_id}`;
      if (state.payments.has(key)) return { transaction:clone(state.payments.get(key)), duplicate:true };
      const row = { ...clone(record), processing_status:'verified', signature_verified:true };
      state.payments.set(key, row); return { transaction:clone(row), duplicate:false };
    },
    async updatePaymentTransaction(id, patch) {
      const entry = [...state.payments].find(([, value]) => value.payment_transaction_id === id);
      if (!entry) return null;
      const row = { ...entry[1], ...clone(patch) }; state.payments.set(entry[0], row); return clone(row);
    },
    async markOrderPaid(id, paidAt) {
      const row = state.orders.get(id); if (!row) return null;
      Object.assign(row, { status:'paid', paid_at:paidAt, provisioning_status:'pending' }); return clone(row);
    },
    async markOrderProvisioned(id) {
      const row = state.orders.get(id); if (!row) return null;
      row.provisioning_status = 'provisioned'; return clone(row);
    },
    async findCaseByOrderId(orderId) {
      return clone([...state.cases.values()].find((item) => item.order_id === orderId) || null);
    },
    async createQueuedCase(record) {
      const existing = [...state.cases.values()].find((item) => item.order_id === record.order_id);
      if (existing) return { consultationCase:clone(existing), created:false };
      const row = { ...clone(record), state:'queued', waiting_on:'none', assigned_pharmacist_id:null,
        queued_at:clock, accepted_at:null, expires_at:null, database_now:clock };
      state.cases.set(row.case_id, row); return { consultationCase:clone(row), created:true };
    },
    async insertEvent(record) {
      if (record.idempotency_key && state.events.some((item) => item.case_id === record.case_id && item.idempotency_key === record.idempotency_key)) return null;
      state.events.push(clone(record)); return clone(record);
    },
    async findPharmacistByLineUserId(lineUserId) { return clone(state.pharmacists.get(lineUserId) || null); },
    async findCaseForUpdate(id) {
      const row = state.cases.get(id); return row ? { ...clone(row), database_now:clock } : null;
    },
    async acceptCase(id, pharmacistId) {
      const row = state.cases.get(id);
      if (!row || row.state !== 'queued' || row.assigned_pharmacist_id) return null;
      const accepted = new Date(clock); const expires = new Date(accepted.getTime() + 24 * 60 * 60 * 1000);
      Object.assign(row, { state:'active', waiting_on:'pharmacist', assigned_pharmacist_id:pharmacistId,
        accepted_at:accepted.toISOString(), expires_at:expires.toISOString(), database_now:clock });
      return clone(row);
    },
    async updateCaseWorkflow(id, patch) {
      const row = state.cases.get(id); if (!row) return null;
      Object.assign(row, { state:patch.state, waiting_on:patch.waitingOn });
      if (patch.closedAt) row.closed_at = patch.closedAt;
      if (patch.closeReason) row.close_reason = patch.closeReason;
      return { ...clone(row), database_now:clock };
    },
    async findMessageByIdempotency(caseId, key) {
      return clone(state.messages.find((item) => item.case_id === caseId && item.idempotency_key === key) || null);
    },
    async insertMessage(record) {
      const existing = state.messages.find((item) => item.case_id === record.case_id && item.idempotency_key === record.idempotency_key);
      if (existing) return { message:clone(existing), duplicate:true };
      const row = { ...clone(record), message_sequence:++state.sequence, created_at:clock };
      state.messages.push(row); return { message:clone(row), duplicate:false };
    },
  };
  return { state, repository, transaction, setNow(value) { clock = value; } };
}

function orderFixture(overrides = {}) {
  return {
    order_id:'ORD-1', customer_line_user_id:'U-CUSTOMER', care_profile_id:'CP-1',
    initial_question:'สอบถามเรื่องยา', amount_minor:10000, currency:'THB', duration_minutes:1440,
    terms_version:'consult-v1', terms_accepted_at:'2026-08-25T01:00:00Z', status:'draft',
    provisioning_status:'pending', paid_at:null, ...overrides,
  };
}

function paidEvent(overrides = {}) {
  return {
    verified:true, signatureVerified:true, provider:'fakepay', providerEventId:'EV-1',
    providerPaymentId:'PAY-1', eventType:'payment_succeeded', orderId:'ORD-1',
    amountMinor:10000, currency:'THB', paidAt:'2026-08-25T02:00:00Z', ...overrides,
  };
}

function activeCase(overrides = {}) {
  return {
    case_id:'CASE-1', order_id:'ORD-1', care_profile_id:'CP-1', customer_line_user_id:'U-CUSTOMER',
    state:'active', waiting_on:'pharmacist', assigned_pharmacist_id:'PH-1',
    accepted_at:'2026-08-25T03:00:00Z', expires_at:'2026-08-26T03:00:00Z',
    order_status:'paid', provisioning_status:'provisioned', ...overrides,
  };
}

test('fixed consultation invariants are 100 THB, THB and 1440 minutes', () => {
  assert.equal(CONSULTATION_PRICE_MINOR, 10000);
  assert.equal(CONSULTATION_CURRENCY, 'THB');
  assert.equal(CONSULTATION_DURATION_MINUTES, 1440);
});

test('draft order requires terms evidence and snapshots fixed commercial terms', async () => {
  const h = createMemoryHarness();
  const service = createConsultationOrderService({ repository:h.repository, transaction:h.transaction,
    authorize:async () => ({ principalType:'family_owner' }), now:() => '2026-08-25T01:00:00Z', orderId:() => 'ORD-1' });
  await assert.rejects(() => service.createDraft({ lineUserId:'U-CUSTOMER', careProfileId:'CP-1', initialQuestion:'กินยาสองตัวนี้ด้วยกันได้ไหม', termsVersion:'v1' }), (e) => e.code === 'TERMS_ACCEPTANCE_REQUIRED');
  const order = await service.createDraft({ lineUserId:'U-CUSTOMER', careProfileId:'CP-1', initialQuestion:'กินยาสองตัวนี้ด้วยกันได้ไหม', termsAccepted:true, termsVersion:'v1' });
  assert.equal(order.amount_minor, 10000); assert.equal(order.currency, 'THB'); assert.equal(order.duration_minutes, 1440);
  assert.equal(order.terms_version, 'v1'); assert.equal(order.terms_accepted_at, '2026-08-25T01:00:00Z');
});

test('order creation uses view authorization: active caregiver allowed, revoked caregiver denied', async () => {
  const h = createMemoryHarness();
  const seen = [];
  const service = createConsultationOrderService({ repository:h.repository, transaction:h.transaction,
    authorize:async (request) => { seen.push(request); if (request.lineUserId === 'U-REVOKED') { const e = new Error('revoked'); e.code='MEMBERSHIP_REVOKED'; throw e; } return { principalType:'family_caregiver', permissions:['view'] }; },
    orderId:() => 'ORD-CG' });
  await service.createDraft({ lineUserId:'U-CAREGIVER', careProfileId:'CP-1', initialQuestion:'กินยาสองตัวนี้ด้วยกันได้ไหม', termsAccepted:true, termsVersion:'v1' });
  assert.equal(seen[0].permission, 'view');
  await assert.rejects(() => service.createDraft({ lineUserId:'U-REVOKED', careProfileId:'CP-1', initialQuestion:'กินยาสองตัวนี้ด้วยกันได้ไหม', termsAccepted:true, termsVersion:'v1' }), (e) => e.code === 'MEMBERSHIP_REVOKED');
  assert.equal(h.state.orders.size, 1);
});

test('order foundation reuses real centralized authorization for caregiver status and view permission', async () => {
  db.resetAll();
  await db.CareProfiles.insert({ care_profile_id:'CP-AUTH', owner_line_id:'U-OWNER', patient_name:'ผู้รับการดูแล', status:'independent' });
  await db.CareProfileMembers.insert({ member_id:'M-ACTIVE', care_profile_id:'CP-AUTH', line_user_id:'U-ACTIVE', role:'caregiver', status:'active', permissions:['view'] });
  await db.CareProfileMembers.insert({ member_id:'M-REVOKED', care_profile_id:'CP-AUTH', line_user_id:'U-REVOKED', role:'caregiver', status:'revoked', permissions:['view'] });
  const h = createMemoryHarness();
  const service = createConsultationOrderService({ repository:h.repository, transaction:h.transaction,
    orderId:()=>`ORD-AUTH-${h.state.orders.size+1}` });
  await service.createDraft({ lineUserId:'U-ACTIVE', careProfileId:'CP-AUTH', initialQuestion:'กินยาสองตัวนี้ด้วยกันได้ไหม', termsAccepted:true, termsVersion:'v1' });
  await assert.rejects(
    () => service.createDraft({ lineUserId:'U-REVOKED', careProfileId:'CP-AUTH', initialQuestion:'กินยาสองตัวนี้ด้วยกันได้ไหม', termsAccepted:true, termsVersion:'v1' }),
    (error) => error.code === 'MEMBERSHIP_REVOKED'
  );
  assert.equal(h.state.orders.size, 1);
  db.resetAll();
});

test('unauthorized profile creates neither order nor health writes', async () => {
  const h = createMemoryHarness();
  const service = createConsultationOrderService({ repository:h.repository, transaction:h.transaction,
    authorize:async () => { const e=new Error('denied'); e.code='ACCESS_DENIED'; throw e; } });
  await assert.rejects(() => service.createDraft({ lineUserId:'U-X', careProfileId:'CP-X', initialQuestion:'กินยาสองตัวนี้ด้วยกันได้ไหม', termsAccepted:true, termsVersion:'v1' }), (e) => e.code === 'ACCESS_DENIED');
  assert.equal(h.state.orders.size, 0); assert.equal(h.state.profileWrites, 0); assert.equal(h.state.healthHistoryWrites, 0);
});

test('verified payment atomically creates one paid order, one queued case and one queue event', async () => {
  const h = createMemoryHarness(); h.state.orders.set('ORD-1', orderFixture());
  const service = createConsultationPaymentService({ repository:h.repository, transaction:h.transaction,
    paymentTransactionId:()=>'PT-1', caseId:()=>'CASE-1', eventId:()=>'E-1' });
  const result = await service.provisionVerifiedPayment(paidEvent());
  assert.equal(result.order.status, 'paid'); assert.equal(result.order.provisioning_status, 'provisioned');
  assert.equal(result.consultationCase.state, 'queued'); assert.equal(h.state.cases.size, 1); assert.equal(h.state.events.length, 1);
});

test('duplicate verified provider event is idempotent and cannot create a second case', async () => {
  const h = createMemoryHarness(); h.state.orders.set('ORD-1', orderFixture());
  const service = createConsultationPaymentService({ repository:h.repository, transaction:h.transaction,
    paymentTransactionId:()=>`PT-${h.state.payments.size+1}`, caseId:()=>`CASE-${h.state.cases.size+1}`, eventId:()=>`E-${h.state.events.length+1}` });
  await service.provisionVerifiedPayment(paidEvent());
  const duplicate = await service.provisionVerifiedPayment(paidEvent());
  assert.equal(duplicate.duplicate, true); assert.equal(h.state.payments.size, 1); assert.equal(h.state.cases.size, 1); assert.equal(h.state.events.length, 1);
});

test('duplicate provider event cannot be replayed against a different order', async () => {
  const h = createMemoryHarness();
  h.state.orders.set('ORD-1', orderFixture());
  h.state.orders.set('ORD-2', orderFixture({order_id:'ORD-2'}));
  const service = createConsultationPaymentService({ repository:h.repository, transaction:h.transaction,
    paymentTransactionId:()=>`PT-${h.state.payments.size+1}`, caseId:()=>`CASE-${h.state.cases.size+1}` });
  await service.provisionVerifiedPayment(paidEvent());
  await assert.rejects(
    () => service.provisionVerifiedPayment(paidEvent({orderId:'ORD-2'})),
    (error) => error.code === 'PAYMENT_EVENT_CONFLICT'
  );
  assert.equal(h.state.orders.get('ORD-2').status, 'draft');
  assert.equal(h.state.cases.size, 1);
});

test('wrong payment amount or currency is rejected before provisioning', async () => {
  for (const event of [paidEvent({amountMinor:9900}), paidEvent({currency:'USD'})]) {
    const h = createMemoryHarness(); h.state.orders.set('ORD-1', orderFixture());
    const service = createConsultationPaymentService({ repository:h.repository, transaction:h.transaction });
    await assert.rejects(() => service.provisionVerifiedPayment(event), (e) => ['PAYMENT_AMOUNT_MISMATCH','PAYMENT_CURRENCY_MISMATCH'].includes(e.code));
    assert.equal(h.state.payments.size, 0); assert.equal(h.state.cases.size, 0);
  }
});

test('simulated case provisioning failure rolls back payment and order atomically', async () => {
  const h = createMemoryHarness(); h.state.orders.set('ORD-1', orderFixture());
  h.repository.createQueuedCase = async () => { throw new Error('simulated insert failure'); };
  const service = createConsultationPaymentService({ repository:h.repository, transaction:h.transaction });
  await assert.rejects(() => service.provisionVerifiedPayment(paidEvent()), /simulated insert failure/);
  assert.equal(h.state.orders.get('ORD-1').status, 'draft'); assert.equal(h.state.payments.size, 0); assert.equal(h.state.cases.size, 0);
});

test('provider-neutral PaymentProvider is abstract and performs no external calls', async () => {
  const provider = new PaymentProvider();
  await assert.rejects(() => provider.createCheckout({}), (e) => e.code === 'PAYMENT_PROVIDER_NOT_IMPLEMENTED');
  await assert.rejects(() => provider.verifyWebhook({}), (e) => e.code === 'PAYMENT_PROVIDER_NOT_IMPLEMENTED');
  await assert.rejects(() => provider.retrievePayment({}), (e) => e.code === 'PAYMENT_PROVIDER_NOT_IMPLEMENTED');
});

test('active pharmacist acceptance sets a DB-timed window of exactly 24 hours', async () => {
  const h = createMemoryHarness(); h.state.cases.set('CASE-1', { ...activeCase(), state:'queued', waiting_on:'none', assigned_pharmacist_id:null, accepted_at:null, expires_at:null });
  const service = createConsultationCaseService({ repository:h.repository, transaction:h.transaction, eventId:()=>'E-ACCEPT' });
  const accepted = await service.acceptCase({ caseId:'CASE-1', pharmacistLineUserId:'U-PHARM-1' });
  assert.equal(accepted.state, 'active'); assert.equal(accepted.waiting_on, 'pharmacist');
  assert.equal(new Date(accepted.expires_at)-new Date(accepted.accepted_at), 24*60*60*1000);
});

test('assigned pharmacist can send immediately after valid atomic acceptance', async () => {
  const h=createMemoryHarness();
  h.state.cases.set('CASE-1',{
    ...activeCase(),state:'queued',waiting_on:'none',assigned_pharmacist_id:null,
    accepted_at:null,expires_at:null,
  });
  const cases=createConsultationCaseService({repository:h.repository,transaction:h.transaction,eventId:()=>'E-ACCEPT-SEND'});
  await cases.acceptCase({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM-1'});
  const messages=messageService(h);
  const sent=await messages.sendMessage({
    caseId:'CASE-1',actor:{type:'pharmacist',lineUserId:'U-PHARM-1'},
    body:'ขอข้อมูลเพิ่มเติม',idempotencyKey:'K-AFTER-ACCEPT',
  });
  assert.equal(sent.message.sender_type,'pharmacist');
  assert.equal(sent.message.message_sequence,1);
  assert.equal(h.state.cases.get('CASE-1').waiting_on,'customer');
});

test('two pharmacists accepting concurrently produce exactly one winner', async () => {
  const h = createMemoryHarness(); h.state.cases.set('CASE-1', { ...activeCase(), state:'queued', waiting_on:'none', assigned_pharmacist_id:null, accepted_at:null, expires_at:null });
  const service = createConsultationCaseService({ repository:h.repository, transaction:h.transaction });
  const settled = await Promise.allSettled([
    service.acceptCase({caseId:'CASE-1', pharmacistLineUserId:'U-PHARM-1'}),
    service.acceptCase({caseId:'CASE-1', pharmacistLineUserId:'U-PHARM-2'}),
  ]);
  assert.equal(settled.filter((x)=>x.status==='fulfilled').length, 1);
  assert.equal(settled.filter((x)=>x.status==='rejected' && x.reason.code==='CASE_ALREADY_ACCEPTED').length, 1);
});

test('suspended pharmacist cannot accept a case', async () => {
  const h = createMemoryHarness(); h.state.cases.set('CASE-1', { ...activeCase(), state:'queued', waiting_on:'none', assigned_pharmacist_id:null, accepted_at:null, expires_at:null });
  const service = createConsultationCaseService({ repository:h.repository, transaction:h.transaction });
  await assert.rejects(() => service.acceptCase({caseId:'CASE-1', pharmacistLineUserId:'U-PHARM-S'}), (e) => e.code === 'PHARMACIST_INACTIVE');
  assert.equal(h.state.cases.get('CASE-1').state, 'queued');
});

function messageService(h, authorize = async () => ({ principalType:'family_owner' })) {
  return createConsultationMessageService({ repository:h.repository, transaction:h.transaction, authorize,
    messageId:()=>`MSG-${h.state.messages.length+1}`, eventId:()=>`EV-${h.state.events.length+1}` });
}

test('messages are sequenced, text-only and immutable through the repository contract', async () => {
  const h = createMemoryHarness(); h.state.cases.set('CASE-1', activeCase()); const service = messageService(h);
  const first = await service.sendMessage({caseId:'CASE-1', actor:{type:'customer',lineUserId:'U-CUSTOMER'}, body:'ข้อความ 1', idempotencyKey:'K-1'});
  const second = await service.sendMessage({caseId:'CASE-1', actor:{type:'pharmacist',lineUserId:'U-PHARM-1'}, body:'ข้อความ 2', idempotencyKey:'K-2'});
  assert.equal(first.message.message_sequence, 1); assert.equal(second.message.message_sequence, 2);
  assert.equal(typeof h.repository.updateMessage, 'undefined'); assert.equal(typeof h.repository.deleteMessage, 'undefined');
  assert.equal(h.state.messages[0].body, 'ข้อความ 1');
});

test('message retries are idempotent and conflicting sender cannot reuse the key', async () => {
  const h = createMemoryHarness(); h.state.cases.set('CASE-1', activeCase()); const service = messageService(h);
  const request = {caseId:'CASE-1', actor:{type:'customer',lineUserId:'U-CUSTOMER'}, body:'ข้อความ', idempotencyKey:'K-1'};
  await service.sendMessage(request);
  const duplicate = await service.sendMessage({...request, body:'ข้อความใหม่ที่ไม่ควรแทนของเดิม'});
  assert.equal(duplicate.duplicate, true); assert.equal(h.state.messages.length, 1); assert.equal(duplicate.message.body, 'ข้อความ');
  await assert.rejects(() => service.sendMessage({caseId:'CASE-1',actor:{type:'pharmacist',lineUserId:'U-PHARM-1'},body:'x',idempotencyKey:'K-1'}), (e)=>e.code==='IDEMPOTENCY_KEY_CONFLICT');
});

test('message body enforces non-empty and 4000-character maximum', async () => {
  const h = createMemoryHarness(); h.state.cases.set('CASE-1', activeCase()); const service = messageService(h);
  await service.sendMessage({caseId:'CASE-1',actor:{type:'customer',lineUserId:'U-CUSTOMER'},body:'ก'.repeat(4000),idempotencyKey:'K-OK'});
  await assert.rejects(() => service.sendMessage({caseId:'CASE-1',actor:{type:'customer',lineUserId:'U-CUSTOMER'},body:'ก'.repeat(4001),idempotencyKey:'K-LONG'}), (e)=>e.code==='QUESTION_TOO_LONG');
  await assert.rejects(() => service.sendMessage({caseId:'CASE-1',actor:{type:'customer',lineUserId:'U-CUSTOMER'},body:'   ',idempotencyKey:'K-EMPTY'}), (e)=>e.code==='QUESTION_REQUIRED');
});

test('only owning customer and assigned active pharmacist may send', async () => {
  const h = createMemoryHarness(); h.state.cases.set('CASE-1', activeCase()); const service = messageService(h);
  await assert.rejects(() => service.sendMessage({caseId:'CASE-1',actor:{type:'customer',lineUserId:'U-OTHER'},body:'x',idempotencyKey:'K-1'}), (e)=>e.code==='CONSULTATION_ACCESS_DENIED');
  await assert.rejects(() => service.sendMessage({caseId:'CASE-1',actor:{type:'pharmacist',lineUserId:'U-PHARM-2'},body:'x',idempotencyKey:'K-2'}), (e)=>e.code==='CONSULTATION_ACCESS_DENIED');
  await assert.rejects(() => service.sendMessage({caseId:'CASE-1',actor:{type:'pharmacist',lineUserId:'U-PHARM-S'},body:'x',idempotencyKey:'K-3'}), (e)=>e.code==='PHARMACIST_INACTIVE');
  assert.equal(h.state.messages.length, 0);
});

test('revoked caregiver loses consultation send access immediately', async () => {
  const h = createMemoryHarness(); h.state.cases.set('CASE-1', activeCase());
  const service = messageService(h, async () => { const e=new Error('revoked'); e.code='MEMBERSHIP_REVOKED'; throw e; });
  await assert.rejects(() => service.sendMessage({caseId:'CASE-1',actor:{type:'customer',lineUserId:'U-CUSTOMER'},body:'x',idempotencyKey:'K-1'}), (e)=>e.code==='MEMBERSHIP_REVOKED');
  assert.equal(h.state.messages.length, 0);
});

test('exact expiration rejects both actors and materializes closed without a scheduler', async () => {
  const h = createMemoryHarness({now:'2026-08-26T03:00:00.000Z'}); h.state.cases.set('CASE-1', activeCase()); const service = messageService(h);
  await assert.rejects(() => service.sendMessage({caseId:'CASE-1',actor:{type:'customer',lineUserId:'U-CUSTOMER'},body:'x',idempotencyKey:'K-1'}), (e)=>e.code==='CONSULTATION_EXPIRED');
  assert.equal(h.state.cases.get('CASE-1').state, 'closed'); assert.equal(h.state.cases.get('CASE-1').close_reason, 'expired');
  assert.equal(effectiveConsultationState(activeCase(), new Date('2026-08-26T03:00:00Z')), 'closed');
});

test('resolved case remains writable and customer follow-up reopens it before expiry', async () => {
  const h = createMemoryHarness(); h.state.cases.set('CASE-1', activeCase({state:'resolved',waiting_on:'none'})); const service = messageService(h);
  await service.sendMessage({caseId:'CASE-1',actor:{type:'customer',lineUserId:'U-CUSTOMER'},body:'ถามต่อ',idempotencyKey:'K-1'});
  assert.equal(h.state.cases.get('CASE-1').state, 'active'); assert.equal(h.state.cases.get('CASE-1').waiting_on, 'pharmacist');
  assert.equal(h.state.events.at(-1).event_type, 'reopened');
});

test('closed case is read-only and consultation services never write Care Profile or Health History', async () => {
  const h = createMemoryHarness(); h.state.cases.set('CASE-1', activeCase({state:'closed',closed_at:'2026-08-25T04:00:00Z'})); const service = messageService(h);
  await assert.rejects(() => service.sendMessage({caseId:'CASE-1',actor:{type:'customer',lineUserId:'U-CUSTOMER'},body:'x',idempotencyKey:'K-1'}), (e)=>e.code==='CONSULTATION_EXPIRED');
  assert.equal(h.state.profileWrites, 0); assert.equal(h.state.healthHistoryWrites, 0); assert.equal(h.state.messages.length, 0);
});

test('pharmacist account service exposes dedicated status checks only', async () => {
  const h = createMemoryHarness(); const service = createPharmacistAccountService({repository:h.repository});
  assert.equal((await service.requireActive('U-PHARM-1')).pharmacistId, 'PH-1');
  await assert.rejects(() => service.requireActive('U-PHARM-S'), (e)=>e.code==='PHARMACIST_INACTIVE');
  await assert.rejects(() => service.requireActive('U-MISSING'), (e)=>e.code==='PHARMACIST_NOT_FOUND');
});
