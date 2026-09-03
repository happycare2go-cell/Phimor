const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_RESEARCH_MESSAGES, MAX_RESEARCH_CONVERSATION_CHARS,
  minimizeResearchConversation, createConsultationResearchContextBuilder,
} = require('../backend/services/consultationResearchContextBuilder');

function caseRow(overrides = {}) {
  return {
    case_id:'CASE-PRIVATE', care_profile_id:'CP-PRIVATE', customer_line_user_id:'U-PRIVATE',
    assigned_pharmacist_id:'PH-1', state:'active', order_status:'paid',
    provisioning_status:'provisioned', expires_at:'2026-09-04T00:00:00Z',
    database_now:'2026-09-03T00:00:00Z', initial_question:'ยาสองตัวนี้กินพร้อมกันได้ไหม',
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const calls = [];
  const deps = {
    pharmacistAccounts:{ async requireActive() { return { pharmacistId:'PH-1' }; } },
    repository:{
      async findCaseForRead() { return caseRow(overrides.case); },
      async listResearchMessages(_caseId, { limit }) {
        calls.push(['messages', limit]);
        return { rows:[
          { message_sequence:1, sender_type:'customer', body:'ฉันใช้ Drug A', created_at:'2026-09-03T00:01:00Z' },
          { message_sequence:2, sender_type:'pharmacist', body:'ขอข้อมูล Drug B เพิ่มเติม', created_at:'2026-09-03T00:02:00Z' },
        ], totalCount:2 };
      },
    },
    async authorizeCareProfileAccess(input) { calls.push(['authorize', input]); return { principalType:'family_owner' }; },
    async buildCareProfileContext() {
      return { context:{ profile:{
        patientName:'ผู้ป่วย ทดสอบ', gender:'female', weightKg:52,
        chronicConditions:['ภาวะทดสอบ'], drugAllergies:'สารทดสอบ', foodAllergies:'',
      } } };
    },
    clinicalContextService:{ async getContext() { return {
      currentMedications:[{ name:'Drug A', strength:'10 mg', dose:'1', unit:'เม็ด', frequency:'วันละ 1 ครั้ง' }],
      recentVitals:[{ occurredAt:'2026-09-02T00:00:00Z', observations:[{ measurementType:'pulse', numericValue:70, canonicalUnit:'beats/min' }] }],
    }; } },
    async compareLatestMedicationSnapshots() { return { status:'INSUFFICIENT_HISTORY' }; },
    async getUpcomingAppointmentSummary() { return [{ hospital:'โรงพยาบาลทดสอบ', datetime:'2026-09-10T09:00:00Z' }]; },
    labRepository:{ async listRecentConfirmedObservations() { return [{
      report_status:'confirmed', analyte_name_source:'Creatinine', source_value_text:'1.0',
      value_type:'numeric', numeric_value:1, source_unit:'mg/dL', specimen_collected_at:'2026-09-01T00:00:00Z',
    }]; } },
    ...overrides.dependencies,
  };
  return { deps, calls };
}

test('research context is assigned-pharmacist-only and always loads bounded authoritative clinical facts', async () => {
  const { deps, calls } = dependencies();
  const result = await createConsultationResearchContextBuilder(deps)({
    caseId:'CASE-PRIVATE', pharmacistLineUserId:'U-PHARM', now:new Date('2026-09-03T00:00:00Z'),
  });
  assert.equal(result.context.conversation.analyzedMessageCount, 3);
  assert.equal(result.context.conversation.totalMessageCount, 3);
  assert.equal(result.context.conversation.analyzedThroughSequence, 2);
  assert.equal(result.context.currentMedications[0].name, 'Drug A');
  assert.equal(result.context.vitalFacts[0].sourceCategory, 'vital_sign');
  assert.equal(result.context.confirmedLabs[0].sourceCategory, 'lab_result');
  assert.equal(result.context.appointments[0].sourceCategory, 'appointment');
  assert.deepStrictEqual(calls[0], ['authorize', {
    lineUserId:'U-PRIVATE', careProfileId:'CP-PRIVATE', permission:'view', requireActiveCenter:true,
  }]);
  assert.deepStrictEqual(calls.find((item) => item[0] === 'messages'), ['messages', MAX_RESEARCH_MESSAGES]);
  const serialized = JSON.stringify(result.context);
  assert.doesNotMatch(serialized, /CASE-PRIVATE|CP-PRIVATE|U-PRIVATE|ผู้ป่วย ทดสอบ/);
  assert.ok(result.privacy.blockedTerms.includes('CP-PRIVATE'));
});

test('research conversation represents the complete thread within bounds and reports deterministic truncation', () => {
  const complete = minimizeResearchConversation('initial', [
    { sender_type:'customer', body:'one', message_sequence:1 },
    { sender_type:'pharmacist', body:'two', message_sequence:2 },
  ], { totalCount:2 });
  assert.equal(complete.conversationTruncated, false);
  const rows = Array.from({ length:MAX_RESEARCH_MESSAGES + 1 }, (_, index) => ({
    sender_type:index % 2 ? 'pharmacist' : 'customer', body:'x'.repeat(400), message_sequence:index + 1,
  }));
  const truncated = minimizeResearchConversation('initial', rows, { totalCount:rows.length });
  assert.equal(truncated.conversationTruncated, true);
  assert.ok(truncated.analyzedMessageCount <= MAX_RESEARCH_MESSAGES + 1);
  assert.ok(JSON.stringify(truncated).length < MAX_RESEARCH_CONVERSATION_CHARS + 20000);
  assert.ok(truncated.analyzedThroughSequence < rows.length);
});

test('wrong assignment and expired case fail before clinical context is read', async () => {
  let clinicalReads = 0;
  for (const candidate of [
    caseRow({ assigned_pharmacist_id:'PH-OTHER' }),
    caseRow({ database_now:'2026-09-05T00:00:00Z' }),
  ]) {
    const { deps } = dependencies({
      case:candidate,
      dependencies:{ clinicalContextService:{ async getContext() { clinicalReads += 1; return {}; } } },
    });
    await assert.rejects(createConsultationResearchContextBuilder(deps)({
      caseId:'CASE-PRIVATE', pharmacistLineUserId:'U-PHARM', now:new Date('2026-09-03T00:00:00Z'),
    }));
  }
  assert.equal(clinicalReads, 0);
});
