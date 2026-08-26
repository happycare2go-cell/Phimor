const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { AI_ERROR_CODES } = require('../backend/providers/aiErrors');
const { PlusEntitlementError } = require('../backend/services/plusEntitlementService');
const {
  DOCTOR_VISIT_INSTRUCTIONS, validateDoctorVisitOrganization,
} = require('../backend/providers/doctorVisitAI');
const {
  createDoctorVisitOrganizationService, validateGrounding,
} = require('../backend/services/doctorVisitOrganizationService');

const SOURCE = 'หมอให้หยุดยา A ขนาด 10 mg และนัดตรวจเลือดอีก 3 เดือน ข้อมูลวันนัดยังไม่ชัดเจน';

function response(overrides = {}) {
  return {
    summary: 'ผู้บันทึกระบุว่ามีข้อมูลเกี่ยวกับยาและการติดตามผลตรวจ',
    items: [
      {
        id: 'provider-id', kind: 'medication_statement',
        sourceSupport: 'หมอให้หยุดยา A ขนาด 10 mg',
        summary: 'ผู้บันทึกระบุว่าหมอให้หยุดยา A ขนาด 10 mg',
        dueAt: null, uncertainty: null,
      },
      {
        id: 'provider-id-2', kind: 'lab_follow_up',
        sourceSupport: 'นัดตรวจเลือดอีก 3 เดือน',
        summary: 'ผู้บันทึกระบุว่ามีการนัดตรวจเลือดอีก 3 เดือน',
        dueAt: null, uncertainty: 'ยังไม่มีวันนัดที่ชัดเจน',
      },
    ],
    missingInformation: ['ยังไม่มีวันนัดที่ชัดเจน'],
    reviewNotice: 'โปรดเทียบกับข้อความต้นทางและเอกสารก่อนยืนยัน',
    ...overrides,
  };
}

function fixture({ providerResponse = response(), providerError = null, entitlementError = null } = {}) {
  const calls = { apply: [], audits: [], entitlement: 0, provider: 0 };
  const record = {
    visitRecordId: 'DVR-1', status: 'draft', sourceText: SOURCE,
    appointmentId: null, items: [],
  };
  const service = createDoctorVisitOrganizationService({
    config: { ai: { provider: 'gemini', explanationModel: 'mock', timeoutMs: 1000 } },
    flags: { plus: { enabled: true, aiExplanation: true } },
    authorizeCareProfileAccess: async () => ({ principalType: 'family_owner', permissions: ['*'] }),
    requirePlusFeature: async () => { calls.entitlement += 1; if (entitlementError) throw entitlementError; },
    doctorVisitService: {
      async getRecord() { return record; },
      async applyAIOrganization(input) {
        calls.apply.push(input);
        return { ...record, structuredSummary: input.patch.structuredSummary, items: input.patch.items };
      },
    },
    provider: {
      async generateStructured(input) {
        calls.provider += 1;
        assert.equal(input.task, 'doctor_visit_organization');
        assert.doesNotMatch(input.context, /LINE|phone|emergency/i);
        if (providerError) throw providerError;
        return providerResponse;
      },
    },
    recordAudit: async (metadata) => { calls.audits.push(metadata); },
  });
  return { service, calls };
}

test('valid AI organization remains a draft and reuses the human draft update path', async () => {
  const { service, calls } = fixture();
  const result = await service({ careProfileId: 'CP-1', visitRecordId: 'DVR-1', lineUserId: 'OWNER' });
  assert.equal(result.status, 'draft'); assert.equal(calls.apply.length, 1);
  assert.equal(calls.apply[0].patch.items[0].kind, 'medication_statement');
  assert.equal('confirmedAt' in calls.apply[0].patch, false);
});

test('AI structured output requires explicit user-recorded attribution and strict fields', () => {
  assert.throws(() => validateDoctorVisitOrganization({ ...response(), summary: 'หมอให้หยุดยา' }), /AI|Summary/);
  assert.throws(() => validateDoctorVisitOrganization({ ...response(), finalDiagnosis: 'เบาหวาน' }), /AI|Invalid/);
  assert.equal(validateDoctorVisitOrganization(response()).items[0].id, 'DVI1');
});

test('fabricated unsupported statements are rejected and never written', async () => {
  const invalid = response({ items: [{
    id: 'x', kind: 'next_appointment', sourceSupport: 'นัดวันที่ 20 ตุลาคม',
    summary: 'ผู้บันทึกระบุว่ามีนัดวันที่ 20 ตุลาคม', dueAt: null, uncertainty: null,
  }] });
  const { service, calls } = fixture({ providerResponse: invalid });
  const result = await service({ careProfileId: 'CP-1', visitRecordId: 'DVR-1', lineUserId: 'OWNER' });
  assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, AI_ERROR_CODES.AI_INVALID_RESPONSE);
  assert.equal(calls.apply.length, 0);
});

test('numbers absent from source support cannot be introduced by AI', () => {
  const result = validateDoctorVisitOrganization(response({ items: [{
    id: 'x', kind: 'medication_statement', sourceSupport: 'หมอให้หยุดยา A',
    summary: 'ผู้บันทึกระบุว่าหมอให้หยุดยา A ขนาด 20 mg', dueAt: null, uncertainty: null,
  }] }));
  assert.throws(() => validateGrounding(result, SOURCE), (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
});

test('AI cannot infer an appointment date from an ambiguous interval', async () => {
  const invalid = response({ items: [{
    id: 'x', kind: 'next_appointment', sourceSupport: 'นัดตรวจเลือดอีก 3 เดือน',
    summary: 'ผู้บันทึกระบุว่ามีนัดตรวจเลือดอีก 3 เดือน',
    dueAt: '2026-11-26T00:00:00.000Z', uncertainty: null,
  }] });
  const { service, calls } = fixture({ providerResponse: invalid });
  assert.equal((await service({ careProfileId: 'CP-1', visitRecordId: 'DVR-1', lineUserId: 'OWNER' })).status, 'unavailable');
  assert.equal(calls.apply.length, 0);
});

test('provider failure leaves the manual draft usable', async () => {
  const error = new Error('timeout'); error.code = AI_ERROR_CODES.AI_TIMEOUT;
  const { service, calls } = fixture({ providerError: error });
  const result = await service({ careProfileId: 'CP-1', visitRecordId: 'DVR-1', lineUserId: 'OWNER' });
  assert.equal(result.status, 'unavailable'); assert.match(result.message, /บันทึก.*ด้วยตนเอง/);
  assert.equal(calls.apply.length, 0);
});

test('AI organization requires existing Plus entitlement without changing manual capability', async () => {
  const { service, calls } = fixture({ entitlementError: new PlusEntitlementError('NO_PLUS_ENTITLEMENT') });
  await assert.rejects(service({ careProfileId: 'CP-1', visitRecordId: 'DVR-1', lineUserId: 'OWNER' }), (error) => error.code === 'NO_PLUS_ENTITLEMENT');
  assert.equal(calls.provider, 0); assert.equal(calls.apply.length, 0);
});

test('AI audit is metadata-only and excludes source note, guidance, LINE identity and clinical payload', async () => {
  const { service, calls } = fixture();
  await service({ careProfileId: 'CP-1', visitRecordId: 'DVR-1', lineUserId: 'U-SECRET-LINE' });
  assert.equal(calls.audits.length, 1);
  const serialized = JSON.stringify(calls.audits[0]);
  assert.equal(calls.audits[0].purpose, 'doctor_visit_organization');
  assert.doesNotMatch(serialized, /หยุดยา|ตรวจเลือด|U-SECRET-LINE|sourceText|guidance/i);
});

test('prompt prohibits diagnosis, invention and automatic canonical writes', () => {
  assert.match(DOCTOR_VISIT_INSTRUCTIONS, /not an electronically verified doctor order/i);
  assert.match(DOCTOR_VISIT_INSTRUCTIONS, /Do not diagnose/i);
  assert.match(DOCTOR_VISIT_INSTRUCTIONS, /Never apply or recommend/i);
  assert.match(DOCTOR_VISIT_INSTRUCTIONS, /not automatic actions/i);
});
