const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { AIProviderError, AI_ERROR_CODES } = require('../backend/providers/aiErrors');
const {
  LAB_EXPLANATION_INSTRUCTIONS, validateLabExplanation,
} = require('../backend/providers/labExplanationAI');
const {
  createLabExplanationService, minimizedLabContext,
} = require('../backend/services/labExplanationService');

const FLAGS = Object.freeze({
  plus: Object.freeze({ enabled: true, internalEntitlementOnly: true, aiExplanation: true }),
});

function point(overrides = {}) {
  return {
    reportId: 'LABR-1', observationId: 'LABO-1', specimenCollectedAt: '2026-01-01T08:00:00.000Z',
    analyteNameSource: 'HbA1c', sourceValueText: '6.1', numericValue: 6.1, sourceUnit: '%',
    referenceRangeText: '4.0-6.0', referenceLow: 4, referenceHigh: 6,
    abnormalFlagSource: null, specimenSource: 'Whole blood', methodSource: 'HPLC',
    ...overrides,
  };
}

function trend(overrides = {}) {
  return {
    status: 'available', reasonCode: null, direction: 'increased', absoluteChange: 0.4,
    comparisonUnit: '%', rangesDiffer: false, hasMore: false, nextCursor: null,
    observations: [point(), point({
      reportId: 'LABR-2', observationId: 'LABO-2', specimenCollectedAt: '2026-02-01T08:00:00.000Z',
      sourceValueText: '6.5', numericValue: 6.5,
    })], ...overrides,
  };
}

function providerResponse(overrides = {}) {
  return {
    summary: 'สรุปค่าที่ได้รับการยืนยัน', testExplanation: 'การตรวจนี้ใช้ติดตามค่าที่ระบุในรายงาน',
    confirmedFacts: [], trendExplanation: 'ค่าตัวเลขเพิ่มขึ้นตามลำดับเวลา', rangeCaveat: null,
    questionsForClinician: ['ควรติดตามผลครั้งต่อไปเมื่อใด'],
    safetyNotice: 'ควรให้บุคลากรทางการแพทย์พิจารณาร่วมกับบริบทอื่น',
    disclaimer: 'ข้อมูลนี้ไม่ใช่การวินิจฉัยหรือคำสั่งรักษา', unavailableReason: null,
    ...overrides,
  };
}

function createHarness(overrides = {}) {
  const calls = { provider: [], audit: [], entitlement: [], trend: [] };
  const service = createLabExplanationService({
    flags: FLAGS,
    config: { ai: { provider: 'gemini', explanationModel: 'test-model', timeoutMs: 5000 } },
    provider: overrides.provider || {
      async generateStructured(input) { calls.provider.push(input); return providerResponse(); },
    },
    async getLabTrend(input) { calls.trend.push(input); return overrides.trend || trend(); },
    async requirePlusFeature(input) { calls.entitlement.push(input); if (overrides.entitlementError) throw overrides.entitlementError; return { allowed: true }; },
    async recordAudit(input) { calls.audit.push(input); if (overrides.auditError) throw overrides.auditError; return { recorded: true }; },
    auditLogger: overrides.auditLogger,
  });
  return { service, calls };
}

test('strict Lab explanation schema accepts structured output and rejects untrusted fields or AI facts', () => {
  assert.equal(validateLabExplanation(providerResponse()).summary, 'สรุปค่าที่ได้รับการยืนยัน');
  assert.throws(() => validateLabExplanation(providerResponse({ diagnosis: 'โรค' })),
    (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
  assert.throws(() => validateLabExplanation(providerResponse({ confirmedFacts: ['AI invented fact'] })),
    (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
  assert.throws(() => validateLabExplanation(providerResponse({ summary: 'แสดงว่าคุณเป็นโรคเบาหวาน' })),
    (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
  assert.throws(() => validateLabExplanation(providerResponse({ safetyNotice: 'ควรหยุดยาเดิมทันที' })),
    (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
  assert.throws(() => validateLabExplanation(providerResponse({ trendExplanation: 'ผลแย่ลง' })),
    (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
});

test('prompt prohibits diagnosis medication changes invented ranges and deterministic override', () => {
  assert.match(LAB_EXPLANATION_INSTRUCTIONS, /Never override a non-comparable reason/i);
  assert.match(LAB_EXPLANATION_INSTRUCTIONS, /Never invent.*critical threshold/i);
  assert.match(LAB_EXPLANATION_INSTRUCTIONS, /Do not diagnose/i);
  assert.match(LAB_EXPLANATION_INSTRUCTIONS, /starting, stopping, changing or adjusting medication/i);
});

test('AI receives minimized confirmed context only and response facts remain backend-derived', async () => {
  const { service, calls } = createHarness();
  const result = await service({
    careProfileId: 'CP-1', lineUserId: 'U-1', identity: { loincCode: '4548-4' }, question: 'ช่วยอธิบายผลนี้',
  });
  assert.equal(result.status, 'answer');
  assert.equal(calls.entitlement[0].feature, 'ai_explanation');
  const serialized = calls.provider[0].context;
  assert.match(serialized, /confirmed_lab_only/);
  for (const forbidden of ['LINE-U-1', 'family_phone', 'emergency_contact', 'image_base64', 'Pending Card', 'draft', 'voided']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(result.confirmedFacts.map((item) => item.sourceValueText), ['6.1', '6.5']);
  assert.equal(result.confirmedFacts.some((item) => 'diagnosis' in item), false);
});

test('minimized context omits report and observation identifiers and source images', () => {
  const context = minimizedLabContext(trend());
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes('LABR-1'), false);
  assert.equal(serialized.includes('LABO-1'), false);
  assert.equal(serialized.includes('base64'), false);
  assert.equal(serialized.includes('lineUserId'), false);
});

test('deterministic non-comparable result cannot be overridden by AI', async () => {
  const { service } = createHarness({ trend: trend({
    status: 'not_comparable', reasonCode: 'METHOD_MISMATCH', direction: null,
    absoluteChange: null, comparisonUnit: null,
  }) });
  const result = await service({ careProfileId: 'CP-1', lineUserId: 'U-1', identity: { loincCode: '4548-4' } });
  assert.equal(result.status, 'answer');
  assert.equal(result.trendExplanation, null);
  assert.equal(result.deterministicTrend.direction, null);
  assert.equal(result.unavailableReason, 'METHOD_MISMATCH');
});

test('differing source ranges force a deterministic caveat without normalization', async () => {
  const differing = trend({ rangesDiffer: true });
  differing.observations[1] = point({
    reportId: 'LABR-2', observationId: 'LABO-2', specimenCollectedAt: '2026-02-01T08:00:00.000Z',
    sourceValueText: '6.5', numericValue: 6.5, referenceRangeText: '4.2-6.2', referenceLow: 4.2, referenceHigh: 6.2,
  });
  const { service } = createHarness({ trend: differing });
  const result = await service({ careProfileId: 'CP-1', lineUserId: 'U-1', identity: { loincCode: '4548-4' } });
  assert.match(result.rangeCaveat, /ช่วงอ้างอิง.*แตกต่าง/);
  assert.equal(result.confirmedFacts[0].referenceRangeText, '4.0-6.0');
  assert.equal(result.confirmedFacts[1].referenceRangeText, '4.2-6.2');
});

test('no confirmed Lab data returns deterministic unavailable without provider call', async () => {
  const { service, calls } = createHarness({ trend: trend({ observations: [], status: 'not_comparable', reasonCode: 'INSUFFICIENT_CONFIRMED_HISTORY' }) });
  const result = await service({ careProfileId: 'CP-1', lineUserId: 'U-1', identity: { comparisonKey: 'x' } });
  assert.equal(result.errorCode, 'CONFIRMED_LAB_NOT_FOUND');
  assert.equal(calls.provider.length, 0);
});

test('malformed provider response and provider failures return safe unavailable states', async () => {
  for (const scenario of [
    { async generateStructured() { return { summary: 'invalid' }; } },
    { async generateStructured() { throw new AIProviderError(AI_ERROR_CODES.AI_TIMEOUT, 'raw timeout'); } },
    { async generateStructured() { throw new AIProviderError(AI_ERROR_CODES.AI_RATE_LIMIT, 'raw rate'); } },
    { async generateStructured() { throw new Error('secret provider error'); } },
  ]) {
    const { service } = createHarness({ provider: scenario });
    const result = await service({ careProfileId: 'CP-1', lineUserId: 'U-1', identity: { loincCode: '4548-4' } });
    assert.equal(result.status, 'unavailable');
    assert.equal(JSON.stringify(result).includes('secret provider error'), false);
    assert.equal(JSON.stringify(result).includes('raw timeout'), false);
  }
});

test('emergency symptom question uses existing deterministic safety signal and never calls AI', async () => {
  const { service, calls } = createHarness();
  const result = await service({
    careProfileId: 'CP-1', lineUserId: 'U-1', identity: { loincCode: '4548-4' }, question: 'ตอนนี้หายใจไม่ออก',
  });
  assert.equal(result.status, 'escalation');
  assert.equal(result.reasonCode, 'POSSIBLE_EMERGENCY');
  assert.equal(calls.provider.length, 0);
  assert.equal(calls.audit[0].resultStatus, 'escalated');
});

test('explicit source critical flag produces safe source-attributed escalation wording', async () => {
  const critical = trend();
  critical.observations[1] = { ...critical.observations[1], abnormalFlagSource: 'critical' };
  const { service } = createHarness({ trend: critical });
  const result = await service({ careProfileId: 'CP-1', lineUserId: 'U-1', identity: { loincCode: '4548-4' } });
  assert.match(result.safetyNotice, /รายงานต้นฉบับระบุธง/);
  assert.doesNotMatch(result.safetyNotice, /วินิจฉัย/);
});

test('AI audit is metadata-only with no LINE ID or raw Lab content', async () => {
  const { service, calls } = createHarness();
  await service({ careProfileId: 'CP-1', lineUserId: 'LINE-SECRET', identity: { loincCode: '4548-4' }, question: 'คำถามลับ' });
  const audit = calls.audit.at(-1);
  assert.equal(audit.purpose, 'lab_explanation');
  assert.equal(audit.requesterLineId, null);
  assert.equal(audit.resultStatus, 'success');
  const { requestedAt, completedAt, ...nonTemporalAudit } = audit;
  assert.ok(requestedAt); assert.ok(completedAt);
  const serialized = JSON.stringify(nonTemporalAudit);
  for (const forbidden of ['LINE-SECRET', 'คำถามลับ', '6.1', '6.5', 'HbA1c']) assert.equal(serialized.includes(forbidden), false);
  assert.ok(audit.inputCharacterCount > 0);
});

test('AI audit failure is fail-open and logs only a safe operational code', async () => {
  const logs = [];
  const { service } = createHarness({ auditError: new Error('sql secret'), auditLogger: (event) => logs.push(event) });
  const result = await service({ careProfileId: 'CP-1', lineUserId: 'U-1', identity: { loincCode: '4548-4' } });
  assert.equal(result.status, 'answer');
  assert.deepEqual(logs, [{ event: 'lab_ai_audit_write_failed', errorCode: 'AI_AUDIT_WRITE_FAILED', interactionId: logs[0].interactionId }]);
  assert.equal(JSON.stringify(logs).includes('sql secret'), false);
});

test('existing Plus ai_explanation entitlement is required before trend or provider access', async () => {
  const denied = new Error('Plus denied'); denied.code = 'PLUS_FEATURE_NOT_INCLUDED'; denied.status = 403;
  const { service, calls } = createHarness({ entitlementError: denied });
  await assert.rejects(() => service({ careProfileId: 'CP-1', lineUserId: 'U-1', identity: { loincCode: '4548-4' } }), /Plus denied/);
  assert.equal(calls.trend.length, 0);
  assert.equal(calls.provider.length, 0);
});

test('real Plus entitlement semantics accept active internal ai_explanation feature', async () => {
  const service = createLabExplanationService({
    flags: FLAGS,
    config: { ai: { provider: 'gemini', explanationModel: 'test-model', timeoutMs: 5000 } },
    entitlementQueryFn: async () => ({ rows: [{
      entitlement_id: 'PLUS-1', status: 'active', source: 'internal',
      starts_at: '2026-01-01T00:00:00Z', expires_at: '2030-01-01T00:00:00Z', features: ['ai_explanation'],
    }] }),
    async getLabTrend() { return trend(); },
    provider: { async generateStructured() { return providerResponse(); } },
    async recordAudit() { return { recorded: true }; },
  });
  const result = await service({ careProfileId: 'CP-1', lineUserId: 'U-1', identity: { loincCode: '4548-4' } });
  assert.equal(result.status, 'answer');
});
