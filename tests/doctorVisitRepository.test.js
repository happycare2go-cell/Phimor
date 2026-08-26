const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { createDoctorVisitRepository } = require('../backend/services/doctorVisitRepository');

test('repository writes relational records with parameterized SQL', async () => {
  const calls = [];
  const repository = createDoctorVisitRepository({ queryFn: async (sql, params) => {
    calls.push({ sql: String(sql), params }); return { rows: [{ visit_record_id: params[0] }] };
  } });
  await repository.createRecord({
    visit_record_id: 'DVR-1', record_group_id: 'DVG-1', version_no: 1,
    care_profile_id: 'CP-1', appointment_id: null, visit_at: null,
    hospital_name: "รพ. ' ทดสอบ", department: null, doctor_name: null,
    source_text: "หมอบอกว่า 'ติดตาม'", structured_summary: null,
    supersedes_visit_record_id: null, correction_reason: null,
    created_by_actor_type: 'family_owner', created_by_actor_id: 'U-1', created_source: 'family_liff',
  });
  assert.match(calls[0].sql, /INSERT INTO doctor_visit_records/);
  assert.doesNotMatch(calls[0].sql, /หมอบอก|รพ\./);
  assert.equal(calls[0].params[9], "หมอบอกว่า 'ติดตาม'");
});

test('guidance and event persistence use allowlisted relational columns and idempotency', async () => {
  const calls = [];
  const repository = createDoctorVisitRepository({ queryFn: async (sql, params) => {
    calls.push({ sql: String(sql), params }); return { rows: [{}] };
  } });
  await repository.insertItems('DVR-1', [{
    sourceOrdinal: 1, kind: 'medication_statement', sourceSupport: 'หมอเพิ่มยา A',
    summary: 'ผู้บันทึกระบุว่าหมอเพิ่มยา A', dueAt: null, uncertainty: null,
  }], () => 'DVI-1');
  await repository.insertEvent({
    event_id: 'DVE-1', visit_record_id: 'DVR-1', event_type: 'confirmed',
    actor_type: 'family_owner', actor_id: 'U-1', source: 'family_liff',
    idempotency_key: 'doctor-visit:confirmed:DVR-1', metadata: { versionNo: 1 },
  });
  assert.match(calls[0].sql, /INSERT INTO doctor_visit_guidance_items/);
  assert.match(calls[1].sql, /ON CONFLICT \(idempotency_key\).*DO NOTHING/s);
  assert.doesNotMatch(calls[1].params[7], /หมอเพิ่มยา/);
});

test('confirmed list is Care Profile scoped, bounded and never uses generic JSONB makeTable', async () => {
  let seen;
  const repository = createDoctorVisitRepository({ queryFn: async (sql, params) => {
    seen = { sql: String(sql), params }; return { rows: [] };
  } });
  await repository.listRecords({ careProfileId: 'CP-1', includeDrafts: false, includeHistory: false, cursor: null, limit: 20 });
  assert.match(seen.sql, /FROM doctor_visit_records WHERE care_profile_id = \$1/);
  assert.match(seen.sql, /LIMIT \$4/);
  assert.deepEqual(seen.params, ['CP-1', false, false, 21]);
  assert.doesNotMatch(seen.sql, /data\s*->|SELECT data|makeTable/i);
});

test('confirmation and void updates are status-guarded and use database time', async () => {
  const calls = [];
  const repository = createDoctorVisitRepository({ queryFn: async (sql, params) => {
    calls.push({ sql: String(sql), params }); return { rows: [{}] };
  } });
  await repository.confirmRecord('DVR-1', { actorType: 'family_owner', actorId: 'U-1' });
  await repository.voidRecord('DVR-1', 'บันทึกผิดคน');
  assert.match(calls[0].sql, /WHERE visit_record_id = \$1 AND status = 'draft'/);
  assert.match(calls[0].sql, /confirmed_at = CURRENT_TIMESTAMP/);
  assert.match(calls[1].sql, /WHERE visit_record_id = \$1 AND status = 'confirmed'/);
  assert.match(calls[1].sql, /voided_at = CURRENT_TIMESTAMP/);
});
