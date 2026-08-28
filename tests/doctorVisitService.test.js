const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const db = require('../backend/db');
const { createDoctorVisitService, deriveFollowUpSuggestions } = require('../backend/services/doctorVisitService');
const { DoctorVisitDomainError } = require('../backend/domain/doctorVisit');

function fixture({ failEventType = null, serviceOverrides = {} } = {}) {
  let sequence = 0;
  let state = { records: [], items: [], events: [] };
  const locks = new Map();
  const clone = (value) => structuredClone(value);
  const stamp = () => `2026-08-26T01:00:${String(sequence).padStart(2, '0')}.000Z`;
  const repository = {
    async createRecord(record) {
      if (state.records.some((row) => row.record_group_id === record.record_group_id
        && row.version_no === record.version_no)) {
        const error = new Error('unique'); error.code = '23505'; throw error;
      }
      const row = {
        ...clone(record), status: 'draft', confirmed_by_actor_type: null,
        confirmed_by_actor_id: null, confirmed_at: null, voided_at: null,
        void_reason: null, created_at: stamp(), updated_at: stamp(), database_now: stamp(),
      };
      state.records.push(row); return clone(row);
    },
    async insertItems(recordId, items, makeId) {
      const rows = items.map((item) => ({
        guidance_item_id: makeId(), visit_record_id: recordId,
        source_ordinal: item.sourceOrdinal, kind: item.kind,
        source_support: item.sourceSupport, normalized_summary: item.summary,
        due_at: item.dueAt, uncertainty: item.uncertainty,
        created_at: stamp(), updated_at: stamp(),
      }));
      state.items.push(...rows); return clone(rows);
    },
    async replaceItems(recordId, items, makeId) {
      const record = state.records.find((row) => row.visit_record_id === recordId);
      if (record?.status !== 'draft') throw new Error('immutable');
      state.items = state.items.filter((row) => row.visit_record_id !== recordId);
      return this.insertItems(recordId, items, makeId);
    },
    async insertEvent(record) {
      if (record.event_type === failEventType) throw new Error('event failure');
      if (record.idempotency_key && state.events.some((row) => row.idempotency_key === record.idempotency_key)) return null;
      const row = { ...clone(record), occurred_at: stamp() }; state.events.push(row); return clone(row);
    },
    async findRecord(recordId) { return clone(state.records.find((row) => row.visit_record_id === recordId) || null); },
    async findRecordForUpdate(recordId) { return this.findRecord(recordId); },
    async findLatestVersionForUpdate(groupId) {
      return clone(state.records.filter((row) => row.record_group_id === groupId)
        .sort((a, b) => b.version_no - a.version_no)[0] || null);
    },
    async listItems(recordId) {
      return clone(state.items.filter((row) => row.visit_record_id === recordId)
        .sort((a, b) => a.source_ordinal - b.source_ordinal));
    },
    async listEvents(recordId) {
      return clone(state.events.filter((row) => row.visit_record_id === recordId)
        .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)));
    },
    async updateDraftRecord(record) {
      const index = state.records.findIndex((row) => row.visit_record_id === record.visit_record_id && row.status === 'draft');
      if (index < 0) return null;
      state.records[index] = {
        ...state.records[index], appointment_id: record.appointment_id,
        visit_at: record.visit_at, hospital_name: record.hospital_name,
        department: record.department, doctor_name: record.doctor_name,
        source_text: record.source_text, structured_summary: record.structured_summary,
        updated_at: stamp(),
      };
      return clone(state.records[index]);
    },
    async confirmRecord(recordId, actor) {
      const index = state.records.findIndex((row) => row.visit_record_id === recordId && row.status === 'draft');
      if (index < 0) return null;
      state.records[index] = {
        ...state.records[index], status: 'confirmed',
        confirmed_by_actor_type: actor.actorType, confirmed_by_actor_id: actor.actorId,
        confirmed_at: stamp(), updated_at: stamp(),
      };
      return clone(state.records[index]);
    },
    async voidRecord(recordId, reason) {
      const index = state.records.findIndex((row) => row.visit_record_id === recordId && row.status === 'confirmed');
      if (index < 0) return null;
      state.records[index] = {
        ...state.records[index], status: 'voided', voided_at: stamp(),
        void_reason: reason, updated_at: stamp(),
      };
      return clone(state.records[index]);
    },
    async listRecords({ careProfileId, includeDrafts, includeHistory, cursor, limit }) {
      let rows = state.records.filter((row) => row.care_profile_id === careProfileId);
      if (!includeHistory) {
        const latestAuthoritative = new Map();
        for (const row of rows.filter((item) => ['confirmed', 'voided'].includes(item.status))) {
          if (!latestAuthoritative.has(row.record_group_id)
            || latestAuthoritative.get(row.record_group_id).version_no < row.version_no) {
            latestAuthoritative.set(row.record_group_id, row);
          }
        }
        rows = [...latestAuthoritative.values()].filter((row) => row.status === 'confirmed')
          .concat(includeDrafts ? rows.filter((row) => row.status === 'draft') : []);
      } else rows = rows.filter((row) => row.status !== 'draft' || includeDrafts);
      rows = rows.map((row) => ({ ...row,
        is_authoritative: row.status === 'confirmed'
          && !state.records.some((item) => item.record_group_id === row.record_group_id
            && ['confirmed', 'voided'].includes(item.status) && item.version_no > row.version_no),
        sort_time: row.visit_at || row.created_at }))
        .sort((a, b) => b.sort_time.localeCompare(a.sort_time) || b.visit_record_id.localeCompare(a.visit_record_id));
      if (cursor) rows = rows.filter((row) => row.sort_time < cursor.sortTime
        || (row.sort_time === cursor.sortTime && row.visit_record_id < cursor.visitRecordId));
      return clone(rows.slice(0, limit + 1));
    },
  };

  async function authorize({ lineUserId, careProfileId }) {
    if (careProfileId !== 'CP-1') throw new DoctorVisitDomainError('ACCESS_DENIED');
    const access = {
      OWNER: { principalType: 'family_owner', role: 'owner', permissions: ['*'] },
      EDIT: { principalType: 'family_caregiver', role: 'caregiver', permissions: ['view', 'edit_profile'] },
      VIEW: { principalType: 'family_caregiver', role: 'caregiver', permissions: ['view'] },
      STAFF: { principalType: 'center_staff', role: 'staff', permissions: ['view'] },
      MANAGER: { principalType: 'center_staff', role: 'manager', permissions: ['view', 'edit_profile'] },
      CENTER_OWNER: { principalType: 'center_staff', role: 'owner', permissions: ['*'] },
      PHARM: { principalType: 'pharmacist', role: 'pharmacist', permissions: [] },
    }[lineUserId];
    if (!access || lineUserId === 'REVOKED') throw new DoctorVisitDomainError('ACCESS_DENIED');
    return access;
  }

  async function transaction(lockKey, callback) {
    const previous = locks.get(lockKey) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    locks.set(lockKey, previous.then(() => gate));
    await previous;
    const before = clone(state);
    try { return await callback(); } catch (error) { state = before; throw error; } finally { release(); }
  }

  const service = createDoctorVisitService({
    repository, authorizeCareProfileAccess: authorize, withTransaction: transaction,
    idFactory: (prefix) => `${prefix}-${String(++sequence).padStart(4, '0')}`,
    findAppointment: async ({ appointmentId, careProfileId }) => appointmentId === 'APT-1' && careProfileId === 'CP-1',
    ...serviceOverrides,
  });
  return { service, state: () => clone(state) };
}

function draft(overrides = {}) {
  const sourceText = 'หมอให้หยุดยา A และนัดตรวจ HbA1c อีก 3 เดือน';
  return {
    appointmentId: 'APT-1', visitAt: '2026-08-25T03:00:00.000Z',
    hospitalName: 'โรงพยาบาลกลาง', sourceText,
    structuredSummary: 'ผู้บันทึกระบุว่ามีเรื่องยาและผลตรวจที่ต้องติดตาม',
    items: [
      { kind: 'medication_statement', sourceSupport: 'หมอให้หยุดยา A', summary: 'ผู้บันทึกระบุว่าหมอให้หยุดยา A' },
      { kind: 'lab_follow_up', sourceSupport: 'นัดตรวจ HbA1c อีก 3 เดือน', summary: 'ผู้บันทึกระบุว่ามีการติดตาม HbA1c อีก 3 เดือน' },
    ],
    ...overrides,
  };
}

test('owner creates and edits a clearly unconfirmed manual draft with source note preserved', async () => {
  const { service } = fixture();
  const created = await service.createDraft({ careProfileId: 'CP-1', lineUserId: 'OWNER', input: draft() });
  assert.equal(created.status, 'draft'); assert.equal(created.sourceText, draft().sourceText);
  assert.equal(created.items.length, 2); assert.equal('createdByActorId' in created, false);
  const updated = await service.updateDraft({
    careProfileId: 'CP-1', visitRecordId: created.visitRecordId, lineUserId: 'OWNER',
    patch: { doctorName: 'นพ.ตัวอย่าง' },
  });
  assert.equal(updated.doctorName, 'นพ.ตัวอย่าง');
});

test('items must be traceable to the exact user-recorded source note', async () => {
  const { service } = fixture();
  await assert.rejects(service.createDraft({
    careProfileId: 'CP-1', lineUserId: 'OWNER', input: draft({
      items: [{ kind: 'next_appointment', sourceSupport: 'นัด 20 ตุลาคม', summary: 'ผู้บันทึกระบุว่ามีนัด 20 ตุลาคม' }],
    }),
  }), (error) => error.code === 'ITEM_NOT_GROUNDED');
});

test('appointment linkage must belong to the same Care Profile', async () => {
  const { service } = fixture();
  await assert.rejects(service.createDraft({
    careProfileId: 'CP-1', lineUserId: 'OWNER', input: draft({ appointmentId: 'APT-OTHER' }),
  }), (error) => error.code === 'APPOINTMENT_NOT_FOUND');
});

test('edit-profile caregiver can create edit and confirm', async () => {
  const { service } = fixture();
  const record = await service.createDraft({ careProfileId: 'CP-1', lineUserId: 'EDIT', input: draft() });
  await service.updateDraft({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'EDIT', patch: { department: 'อายุรกรรม' } });
  assert.equal((await service.confirmDraft({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'EDIT' })).status, 'confirmed');
});

test('view-only caregiver reads confirmed history but cannot create or confirm drafts', async () => {
  const { service } = fixture();
  await assert.rejects(service.createDraft({ careProfileId: 'CP-1', lineUserId: 'VIEW', input: draft() }), (error) => error.code === 'ACCESS_DENIED');
  const record = await service.createDraft({ careProfileId: 'CP-1', lineUserId: 'OWNER', input: draft() });
  await assert.rejects(service.getRecord({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'VIEW' }), (error) => error.code === 'RECORD_NOT_FOUND');
  await service.confirmDraft({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'OWNER' });
  assert.equal((await service.getRecord({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'VIEW' })).status, 'confirmed');
});

test('center staff may draft but only center manager or owner may confirm', async () => {
  const { service } = fixture();
  const record = await service.createDraft({ careProfileId: 'CP-1', lineUserId: 'STAFF', input: draft() });
  await assert.rejects(service.confirmDraft({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'STAFF' }), (error) => error.code === 'ACCESS_DENIED');
  assert.equal((await service.confirmDraft({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'MANAGER' })).status, 'confirmed');
  const second = await service.createDraft({ careProfileId: 'CP-1', lineUserId: 'STAFF', input: draft() });
  assert.equal((await service.confirmDraft({ careProfileId: 'CP-1', visitRecordId: second.visitRecordId, lineUserId: 'CENTER_OWNER' })).status, 'confirmed');
});

test('revoked cross-profile and pharmacist ordinary access are denied', async () => {
  const { service } = fixture();
  for (const input of [
    { careProfileId: 'CP-1', lineUserId: 'REVOKED' },
    { careProfileId: 'CP-OTHER', lineUserId: 'OWNER' },
    { careProfileId: 'CP-1', lineUserId: 'PHARM' },
  ]) await assert.rejects(service.listRecords(input), (error) => ['ACCESS_DENIED'].includes(error.code));
});

test('confirmation is transactional, explicit and idempotently safe', async () => {
  const { service, state } = fixture();
  const record = await service.createDraft({ careProfileId: 'CP-1', lineUserId: 'OWNER', input: draft() });
  const first = await service.confirmDraft({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'OWNER' });
  const second = await service.confirmDraft({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'OWNER' });
  assert.equal(first.status, 'confirmed'); assert.equal(second.status, 'confirmed');
  assert.equal(state().events.filter((event) => event.event_type === 'confirmed').length, 1);
});

test('failed confirmation event rolls back the record transition', async () => {
  const { service, state } = fixture({ failEventType: 'confirmed' });
  const record = await service.createDraft({ careProfileId: 'CP-1', lineUserId: 'OWNER', input: draft() });
  await assert.rejects(service.confirmDraft({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'OWNER' }));
  assert.equal(state().records.find((row) => row.visit_record_id === record.visitRecordId).status, 'draft');
});

test('confirmed records and guidance cannot be changed through draft update', async () => {
  const { service, state } = fixture();
  const record = await service.createDraft({ careProfileId: 'CP-1', lineUserId: 'OWNER', input: draft() });
  await service.confirmDraft({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'OWNER' });
  const before = structuredClone(state());
  await assert.rejects(service.updateDraft({
    careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'OWNER', patch: { sourceText: 'เปลี่ยน' },
  }), (error) => error.code === 'RECORD_NOT_DRAFT');
  assert.deepEqual(state(), before);
});

test('correction creates a new draft version without mutating prior confirmed history', async () => {
  const { service, state } = fixture();
  const record = await service.createDraft({ careProfileId: 'CP-1', lineUserId: 'OWNER', input: draft() });
  const confirmed = await service.confirmDraft({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'OWNER' });
  const correction = await service.createCorrectionDraft({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'OWNER', reason: 'แก้ข้อความที่บันทึกผิด' });
  assert.equal(correction.status, 'draft'); assert.equal(correction.versionNo, 2);
  assert.equal(correction.recordGroupId, confirmed.recordGroupId);
  assert.equal(correction.supersedesVisitRecordId, confirmed.visitRecordId);
  assert.equal(state().records.find((row) => row.visit_record_id === confirmed.visitRecordId).status, 'confirmed');
});

test('correction and void require explicit reasons', async () => {
  const { service } = fixture();
  const record = await service.createDraft({ careProfileId: 'CP-1', lineUserId: 'OWNER', input: draft() });
  await service.confirmDraft({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'OWNER' });
  await assert.rejects(service.createCorrectionDraft({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'OWNER', reason: '' }), (error) => error.code === 'CORRECTION_REASON_REQUIRED');
  await assert.rejects(service.voidRecord({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'OWNER' }), (error) => error.code === 'VOID_REASON_REQUIRED');
});

test('void preserves confirmed source and event history without hard delete', async () => {
  const { service, state } = fixture();
  const record = await service.createDraft({ careProfileId: 'CP-1', lineUserId: 'OWNER', input: draft() });
  await service.confirmDraft({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'OWNER' });
  const voided = await service.voidRecord({ careProfileId: 'CP-1', visitRecordId: record.visitRecordId, lineUserId: 'OWNER', reason: 'บันทึกผิดคน' });
  assert.equal(voided.status, 'voided'); assert.equal(voided.sourceText, draft().sourceText);
  assert.equal(state().records.length, 1); assert.equal(state().events.some((event) => event.event_type === 'voided'), true);
});

test('voiding the latest Doctor Visit correction never resurrects V1 and duplicate void is idempotent', async () => {
  const { service, state } = fixture();
  const first = await service.createDraft({ careProfileId:'CP-1', lineUserId:'OWNER', input:draft() });
  await service.confirmDraft({ careProfileId:'CP-1', visitRecordId:first.visitRecordId, lineUserId:'OWNER' });
  const second = await service.createCorrectionDraft({
    careProfileId:'CP-1', visitRecordId:first.visitRecordId, lineUserId:'OWNER', reason:'แก้ไข',
  });
  await service.confirmDraft({ careProfileId:'CP-1', visitRecordId:second.visitRecordId, lineUserId:'OWNER' });
  await service.voidRecord({
    careProfileId:'CP-1', visitRecordId:second.visitRecordId, lineUserId:'OWNER', reason:'ฉบับแก้ไขผิด',
  });
  await service.voidRecord({
    careProfileId:'CP-1', visitRecordId:second.visitRecordId, lineUserId:'OWNER', reason:'retry',
  });
  assert.equal((await service.listRecords({ careProfileId:'CP-1', lineUserId:'OWNER' })).items.length, 0);
  const history = await service.listRecords({ careProfileId:'CP-1', lineUserId:'OWNER', includeHistory:true });
  assert.deepEqual(history.items.map((item) => [item.versionNo, item.status, item.isCurrent]), [
    [2, 'voided', false], [1, 'confirmed', false],
  ]);
  assert.equal(state().events.filter((event) => event.visit_record_id === second.visitRecordId
    && event.event_type === 'voided').length, 1);
  assert.equal(state().records.length, 2);
});

test('Center-authored Doctor Visit correction and void remain manager/owner-only', async () => {
  db.resetAll();
  await db.Residents.insert({ resident_id:'RES-1', care_profile_id:'CP-1', center_id:'CTR-1', status:'active' });
  for (const [staffId, lineUserId, role] of [
    ['STF-1', 'STAFF', 'staff'], ['STF-2', 'MANAGER', 'manager'], ['STF-3', 'CENTER_OWNER', 'owner'],
  ]) await db.CenterStaff.insert({ staff_id:staffId, line_user_id:lineUserId, center_id:'CTR-1', role, status:'active' });
  const { service } = fixture();
  const first = await service.createDraft({
    careProfileId:'CP-1', lineUserId:'STAFF', centerId:'CTR-1', input:draft(),
  });
  await service.confirmDraft({
    careProfileId:'CP-1', visitRecordId:first.visitRecordId, lineUserId:'MANAGER', centerId:'CTR-1',
  });
  await assert.rejects(service.createCorrectionDraft({
    careProfileId:'CP-1', visitRecordId:first.visitRecordId, lineUserId:'OWNER', reason:'ไม่ควรผ่าน',
  }), { code:'ACCESS_DENIED' });
  const correction = await service.createCorrectionDraft({
    careProfileId:'CP-1', visitRecordId:first.visitRecordId, lineUserId:'MANAGER', centerId:'CTR-1', reason:'แก้ไข',
  });
  await assert.rejects(service.confirmDraft({
    careProfileId:'CP-1', visitRecordId:correction.visitRecordId, lineUserId:'OWNER',
  }), { code:'ACCESS_DENIED' });
  await service.confirmDraft({
    careProfileId:'CP-1', visitRecordId:correction.visitRecordId, lineUserId:'MANAGER', centerId:'CTR-1',
  });
  assert.equal((await service.voidRecord({
    careProfileId:'CP-1', visitRecordId:correction.visitRecordId, lineUserId:'CENTER_OWNER',
    centerId:'CTR-1', reason:'ยกเลิก',
  })).status, 'voided');
});

test('confirmed item kinds create deterministic review suggestions but no automatic writes', () => {
  assert.deepEqual(deriveFollowUpSuggestions([
    { kind: 'medication_statement' }, { kind: 'next_appointment' }, { kind: 'test_or_monitoring' },
  ]).map((item) => item.code), ['REVIEW_MEDICATIONS', 'REVIEW_NEXT_APPOINTMENT', 'REVIEW_LAB_FOLLOW_UP']);
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'backend', 'services', 'doctorVisitService.js'), 'utf8');
  assert.doesNotMatch(source, /MedicationSnapshots\.(?:insert|update)|Appointments\.(?:insert|update)|lab_reports\s+SET/i);
});

test('pagination and draft visibility stay permission-scoped', async () => {
  const { service } = fixture();
  for (let i = 0; i < 3; i += 1) await service.createDraft({ careProfileId: 'CP-1', lineUserId: 'OWNER', input: draft({ visitAt: `2026-08-2${i + 1}T03:00:00Z` }) });
  const first = await service.listRecords({ careProfileId: 'CP-1', lineUserId: 'OWNER', includeDrafts: true, limit: 2 });
  assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  const viewOnly = await service.listRecords({ careProfileId: 'CP-1', lineUserId: 'VIEW', includeDrafts: true });
  assert.equal(viewOnly.items.length, 0);
});

test('API projections omit internal actor IDs, LINE IDs, contacts and unrelated clinical history', async () => {
  const { service } = fixture();
  const record = await service.createDraft({ careProfileId: 'CP-1', lineUserId: 'OWNER', input: draft() });
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /U-OWNER|lineUserId|phone|emergency|healthHistory/i);
  assert.equal(record.createdByActorType, 'family_owner');
});
