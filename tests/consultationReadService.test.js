const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const { createConsultationReadService } = require('../backend/services/consultationReadService');
const { createConsultationRepository } = require('../backend/services/consultationRepository');

function caseRow(overrides = {}) {
  return {
    case_id:'CASE-1', order_id:'ORD-1', care_profile_id:'CP-1',
    customer_line_user_id:'U-CUSTOMER', state:'active', waiting_on:'pharmacist',
    assigned_pharmacist_id:'PH-1', queued_at:'2026-08-25T00:00:00Z',
    accepted_at:'2026-08-25T01:00:00Z', expires_at:'2026-08-26T01:00:00Z',
    resolved_at:null, closed_at:null, close_reason:null,
    order_status:'paid', provisioning_status:'provisioned',
    initial_question:'กินยาสองตัวนี้ด้วยกันได้ไหม',
    database_now:'2026-08-25T02:00:00Z', ...overrides,
  };
}

function message(sequence, overrides = {}) {
  return {
    message_id:`MSG-${sequence}`, case_id:'CASE-1', message_sequence:sequence,
    sender_type:sequence % 2 ? 'customer' : 'pharmacist', sender_id:'PRIVATE-LINE-ID',
    body:`ข้อความ ${sequence}`, created_at:`2026-08-25T02:00:0${sequence}Z`, ...overrides,
  };
}

function harness(overrides = {}) {
  const rows = overrides.rows || [caseRow()];
  const repository = {
    async listCasesForCustomer() { return rows; },
    async findCaseForRead(id) { return rows.find((item) => item.case_id === id) || null; },
    async listQueuedCases() { return rows.filter((item) => item.state === 'queued'); },
    async listActiveCasesForPharmacist(id) { return rows.filter((item) => item.assigned_pharmacist_id === id); },
    async listMessages(caseId, {afterSequence, limit}) {
      return (overrides.messages || [message(1),message(2),message(3)])
        .filter((item) => item.case_id === caseId && item.message_sequence > afterSequence)
        .slice(0, limit);
    },
  };
  let accessAllowed = overrides.accessAllowed !== false;
  const authorize = async () => {
    if (!accessAllowed) { const error=new Error('revoked'); error.code='MEMBERSHIP_REVOKED'; throw error; }
    return {principalType:'family_owner'};
  };
  const pharmacistAccounts = {
    async requireActive(lineUserId) {
      if (lineUserId === 'U-PHARM-S') { const error=new Error('inactive'); error.code='PHARMACIST_INACTIVE'; throw error; }
      return {pharmacistId:lineUserId === 'U-PHARM-2' ? 'PH-2' : 'PH-1'};
    },
  };
  return {
    repository, pharmacistAccounts,
    service:createConsultationReadService({repository,authorize,pharmacistAccounts}),
    revoke() { accessAllowed=false; },
  };
}

test('Family reads only the purchased case with fresh Care Profile authorization', async () => {
  const h = harness();
  const detail = await h.service.getFamilyCase({caseId:'CASE-1',lineUserId:'U-CUSTOMER'});
  assert.equal(detail.caseId, 'CASE-1');
  assert.equal(detail.initialQuestion, 'กินยาสองตัวนี้ด้วยกันได้ไหม');
  await assert.rejects(() => h.service.getFamilyCase({caseId:'CASE-1',lineUserId:'U-OTHER'}), (e)=>e.code==='CONSULTATION_ACCESS_DENIED');
});

test('revoked caregiver immediately loses list, detail and message-read access', async () => {
  const h = harness();
  assert.equal((await h.service.listFamilyCases({lineUserId:'U-CUSTOMER'})).items.length, 1);
  h.revoke();
  assert.equal((await h.service.listFamilyCases({lineUserId:'U-CUSTOMER'})).items.length, 0);
  await assert.rejects(() => h.service.getFamilyCase({caseId:'CASE-1',lineUserId:'U-CUSTOMER'}), (e)=>e.code==='MEMBERSHIP_REVOKED');
  await assert.rejects(() => h.service.listCaseMessages({caseId:'CASE-1',lineUserId:'U-CUSTOMER'}), (e)=>e.code==='MEMBERSHIP_REVOKED');
});

test('queue projection contains minimum triage fields and no health or identity data', async () => {
  const row = caseRow({ state:'queued', waiting_on:'none', assigned_pharmacist_id:null,
    accepted_at:null, expires_at:null, medication_list:['SECRET'], phone:'0811111111', allergies:['SECRET'] });
  const h = harness({rows:[row]});
  const result = await h.service.listQueue({pharmacistLineUserId:'U-PHARM-1'});
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['caseId','queuedAt','topicCategory','triageCategory','waitingSeconds'].sort());
  const serialized = JSON.stringify(result);
  for (const secret of ['SECRET','0811111111','U-CUSTOMER','CP-1','PRIVATE-LINE-ID']) assert.equal(serialized.includes(secret), false);
  assert.equal(result.items[0].topicCategory, 'drug_interaction');
});

test('repository queue SQL excludes unpaid and unprovisioned orders', async () => {
  const calls = [];
  const repository = createConsultationRepository({queryFn:async (sql,params) => { calls.push({sql:String(sql),params}); return {rows:[]}; }});
  await repository.listQueuedCases();
  assert.match(calls[0].sql, /o\.status = 'paid'/);
  assert.match(calls[0].sql, /o\.provisioning_status = 'provisioned'/);
  assert.match(calls[0].sql, /c\.state = 'queued'/);
});

test('direct case access also rejects an inconsistent unpaid/unprovisioned case', async () => {
  const h = harness({rows:[caseRow({order_status:'draft',provisioning_status:'pending'})]});
  await assert.rejects(
    () => h.service.getFamilyCase({caseId:'CASE-1',lineUserId:'U-CUSTOMER'}),
    (error) => error.code === 'CONSULTATION_NOT_PROVISIONED'
  );
  await assert.rejects(
    () => h.service.getPharmacistCase({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM-1'}),
    (error) => error.code === 'CONSULTATION_NOT_PROVISIONED'
  );
});

test('pharmacist can read only an assigned case and active status is rechecked', async () => {
  const h = harness();
  assert.equal((await h.service.getPharmacistCase({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM-1'})).caseId, 'CASE-1');
  await assert.rejects(() => h.service.getPharmacistCase({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM-2'}), (e)=>e.code==='CONSULTATION_ACCESS_DENIED');
  await assert.rejects(() => h.service.getPharmacistCase({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM-S'}), (e)=>e.code==='PHARMACIST_INACTIVE');
});

test('effective expiration makes case closed on reads without scheduler and preserves history', async () => {
  const h = harness({rows:[caseRow({database_now:'2026-08-26T01:00:00Z'})]});
  const detail = await h.service.getFamilyCase({caseId:'CASE-1',lineUserId:'U-CUSTOMER'});
  assert.equal(detail.state, 'closed');
  assert.equal(detail.waitingOn, 'none');
  assert.equal(detail.closedAt, '2026-08-26T01:00:00Z');
  assert.equal((await h.service.listCaseMessages({caseId:'CASE-1',lineUserId:'U-CUSTOMER'})).items.length, 3);
});

test('polling returns ordered messages, bounded cursor and no sender LINE IDs', async () => {
  const h = harness({messages:[message(3),message(1),message(2),message(4)]});
  h.repository.listMessages = async (caseId,{afterSequence,limit}) => [message(1),message(2),message(3),message(4)]
    .filter((item)=>item.message_sequence>afterSequence).slice(0,limit);
  const page = await h.service.listCaseMessages({caseId:'CASE-1',lineUserId:'U-CUSTOMER',afterSequence:'1',limit:'2'});
  assert.deepEqual(page.items.map((item)=>item.sequence), [2,3]);
  assert.equal(page.nextSequence, 3);
  assert.equal(page.hasMore, true);
  assert.equal(JSON.stringify(page).includes('PRIVATE-LINE-ID'), false);
});

test('polling validation rejects invalid cursor or excessive limit', async () => {
  const h = harness();
  await assert.rejects(() => h.service.listCaseMessages({caseId:'CASE-1',lineUserId:'U-CUSTOMER',afterSequence:'-1'}), (e)=>e.code==='INVALID_AFTER_SEQUENCE');
  await assert.rejects(() => h.service.listCaseMessages({caseId:'CASE-1',lineUserId:'U-CUSTOMER',limit:'51'}), (e)=>e.code==='INVALID_MESSAGE_LIMIT');
});

test('read projections expose no Care Profile, Health History, contact, or internal actor IDs', async () => {
  const h = harness();
  const result = {
    detail:await h.service.getFamilyCase({caseId:'CASE-1',lineUserId:'U-CUSTOMER'}),
    messages:await h.service.listCaseMessages({caseId:'CASE-1',lineUserId:'U-CUSTOMER'}),
  };
  const serialized = JSON.stringify(result);
  for (const key of ['customer_line_user_id','care_profile_id','sender_id','healthHistory','medication_list','phone']) assert.equal(serialized.includes(key), false);
});
