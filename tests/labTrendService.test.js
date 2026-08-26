const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const {
  NON_COMPARABLE_REASONS, buildDeterministicTrend, createLabTrendService,
  encodeCursor, decodeCursor,
} = require('../backend/services/labTrendService');

const LOINC = { loincCode: '4548-4' };
const COMPARISON = { comparisonKey: 'hba1c-blood' };

function row(overrides = {}) {
  return {
    reportId: 'LABR-1', observationId: 'LABO-1', reportStatus: 'confirmed',
    specimenCollectedAt: '2026-01-01T08:00:00.000Z', analyteNameSource: 'HbA1c',
    sourceValueText: '6.1', valueType: 'numeric', numericValue: 6.1,
    sourceUnit: '%', referenceRangeText: '4.0-6.0', referenceLow: 4, referenceHigh: 6,
    abnormalFlagSource: null, specimenSource: 'Whole blood', methodSource: 'HPLC',
    loincCode: '4548-4', loincVerificationSource: 'human_verified',
    loincVerifiedBy: 'ACTOR-1', loincVerifiedAt: '2026-01-02T08:00:00.000Z',
    comparisonKey: 'hba1c-blood', ucumUnit: null, normalizedNumericValue: null,
    unitNormalizationSource: null, ...overrides,
  };
}

function pair(second = {}) {
  return [row(), row({
    reportId: 'LABR-2', observationId: 'LABO-2',
    specimenCollectedAt: '2026-02-01T08:00:00.000Z', sourceValueText: '6.5', numericValue: 6.5,
    ...second,
  })];
}

test('trend includes confirmed data only and excludes draft and voided observations', () => {
  const result = buildDeterministicTrend([
    ...pair(), row({ reportId: 'LABR-D', reportStatus: 'draft', numericValue: 99 }),
    row({ reportId: 'LABR-V', reportStatus: 'voided', numericValue: 88 }),
  ], LOINC);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.observations.map((item) => item.reportId), ['LABR-1', 'LABR-2']);
});

test('verified identical LOINC and confirmed comparison key are deterministic identities', () => {
  assert.equal(buildDeterministicTrend(pair(), LOINC).status, 'available');
  assert.equal(buildDeterministicTrend(pair(), COMPARISON).status, 'available');
});

test('display-name similarity alone and unverified LOINC never establish identity', () => {
  assert.equal(buildDeterministicTrend(pair(), {}).reasonCode, NON_COMPARABLE_REASONS.ANALYTE_IDENTITY_UNVERIFIED);
  const unverified = pair().map((item) => ({ ...item, loincVerificationSource: null, loincVerifiedBy: null, loincVerifiedAt: null }));
  assert.equal(buildDeterministicTrend(unverified, LOINC).reasonCode, NON_COMPARABLE_REASONS.ANALYTE_IDENTITY_UNVERIFIED);
  const similar = pair().map((item, index) => ({ ...item, comparisonKey: index ? 'hba-1-c' : 'hba1c' }));
  assert.equal(buildDeterministicTrend(similar, { comparisonKey: 'hba1c' }).reasonCode, NON_COMPARABLE_REASONS.INSUFFICIENT_CONFIRMED_HISTORY);
});

test('numeric history is comparable while text history is preserved without numeric trend', () => {
  assert.equal(buildDeterministicTrend(pair(), LOINC).status, 'available');
  const text = pair().map((item, index) => ({
    ...item, valueType: 'text', numericValue: null, sourceValueText: index ? 'Positive' : 'Negative',
  }));
  const result = buildDeterministicTrend(text, LOINC);
  assert.equal(result.reasonCode, NON_COMPARABLE_REASONS.NON_NUMERIC_RESULT);
  assert.deepEqual(result.observations.map((item) => item.sourceValueText), ['Negative', 'Positive']);
});

test('missing specimen collection time blocks comparison', () => {
  const result = buildDeterministicTrend(pair({ specimenCollectedAt: null }), LOINC);
  assert.equal(result.reasonCode, NON_COMPARABLE_REASONS.SPECIMEN_TIME_MISSING);
});

test('specimen mismatch and missing specimen block comparison', () => {
  assert.equal(buildDeterministicTrend(pair({ specimenSource: 'Serum' }), LOINC).reasonCode,
    NON_COMPARABLE_REASONS.SPECIMEN_MISMATCH);
  assert.equal(buildDeterministicTrend(pair({ specimenSource: null }), LOINC).reasonCode,
    NON_COMPARABLE_REASONS.SPECIMEN_MISMATCH);
});

test('method mismatch blocks while exact normalized method spelling remains comparable', () => {
  assert.equal(buildDeterministicTrend(pair({ methodSource: 'Immunoassay' }), LOINC).reasonCode,
    NON_COMPARABLE_REASONS.METHOD_MISMATCH);
  assert.equal(buildDeterministicTrend(pair({ methodSource: '  hplc  ' }), LOINC).status, 'available');
});

test('identical source unit works and no source value is changed', () => {
  const input = pair();
  const result = buildDeterministicTrend(input, LOINC);
  assert.equal(result.status, 'available');
  assert.equal(result.comparisonUnit, '%');
  assert.equal(result.normalizationBasis, 'exact_source_unit');
  assert.deepEqual(result.observations.map((item) => item.sourceValueText), ['6.1', '6.5']);
  assert.deepEqual(input.map((item) => item.sourceValueText), ['6.1', '6.5']);
});

test('existing verified normalized UCUM values permit comparison without inferred conversion', () => {
  const rows = pair({
    sourceUnit: 'mmol/mol', numericValue: 48, sourceValueText: '48', ucumUnit: '%',
    normalizedNumericValue: 6.5, unitNormalizationSource: 'human_verified',
  });
  rows[0] = { ...rows[0], ucumUnit: '%', normalizedNumericValue: 6.1, unitNormalizationSource: 'human_verified' };
  const result = buildDeterministicTrend(rows, LOINC);
  assert.equal(result.status, 'available');
  assert.equal(result.normalizationBasis, 'verified_ucum_value');
  assert.equal(result.comparisonUnit, '%');
});

test('unknown unit conversion or unverified normalized values are rejected', () => {
  const rows = pair({ sourceUnit: 'mmol/mol', numericValue: 48, sourceValueText: '48' });
  assert.equal(buildDeterministicTrend(rows, LOINC).reasonCode, NON_COMPARABLE_REASONS.UNIT_INCOMPATIBLE);
  rows[0] = { ...rows[0], ucumUnit: '%', normalizedNumericValue: 6.1, unitNormalizationSource: 'future_ai' };
  rows[1] = { ...rows[1], ucumUnit: '%', normalizedNumericValue: 6.5, unitNormalizationSource: 'future_ai' };
  assert.equal(buildDeterministicTrend(rows, LOINC).reasonCode, NON_COMPARABLE_REASONS.UNIT_INCOMPATIBLE);
});

test('duplicate candidates for the same identity in one report are ambiguous', () => {
  const rows = [...pair(), row({ observationId: 'LABO-1B', numericValue: 6.2, sourceValueText: '6.2' })];
  assert.equal(buildDeterministicTrend(rows, LOINC).reasonCode, NON_COMPARABLE_REASONS.AMBIGUOUS_OBSERVATION);
  const sameCollectionTime = pair({ specimenCollectedAt: '2026-01-01T08:00:00.000Z' });
  assert.equal(buildDeterministicTrend(sameCollectionTime, LOINC).reasonCode,
    NON_COMPARABLE_REASONS.AMBIGUOUS_OBSERVATION);
});

test('source-specific differing ranges are preserved and flagged without clinical judgment', () => {
  const result = buildDeterministicTrend(pair({
    referenceRangeText: '4.2-6.2', referenceLow: 4.2, referenceHigh: 6.2,
  }), LOINC);
  assert.equal(result.rangesDiffer, true);
  assert.deepEqual(result.observations.map((item) => item.referenceRangeText), ['4.0-6.0', '4.2-6.2']);
  assert.equal('improved' in result, false);
  assert.equal('worsened' in result, false);
});

test('chronological ordering and increase decrease unchanged directions are factual', () => {
  const reversed = pair().reverse();
  const increased = buildDeterministicTrend(reversed, LOINC);
  assert.deepEqual(increased.observations.map((item) => item.reportId), ['LABR-1', 'LABR-2']);
  assert.equal(increased.direction, 'increased');
  assert.ok(Math.abs(increased.absoluteChange - 0.4) < 1e-9);
  assert.equal(buildDeterministicTrend(pair({ numericValue: 5.9, sourceValueText: '5.9' }), LOINC).direction, 'decreased');
  assert.equal(buildDeterministicTrend(pair({ numericValue: 6.1, sourceValueText: '6.1' }), LOINC).direction, 'unchanged');
});

test('one confirmed observation is insufficient confirmed history', () => {
  assert.equal(buildDeterministicTrend([row()], LOINC).reasonCode,
    NON_COMPARABLE_REASONS.INSUFFICIENT_CONFIRMED_HISTORY);
});

test('trend service reuses Care Profile authorization for owner and caregiver', async () => {
  const principals = [];
  const service = createLabTrendService({
    repository: { async listConfirmedObservationHistory() { return pair(); } },
    async authorizeCareProfileAccess(input) {
      principals.push(input);
      return { principalType: input.lineUserId === 'OWNER' ? 'family_owner' : 'family_caregiver', permissions: ['view'] };
    },
  });
  assert.equal((await service({ careProfileId: 'CP-1', lineUserId: 'OWNER', identity: LOINC })).status, 'available');
  assert.equal((await service({ careProfileId: 'CP-1', lineUserId: 'CAREGIVER', identity: LOINC })).status, 'available');
  assert.ok(principals.every((item) => item.permission === 'view' && item.careProfileId === 'CP-1'));
});

test('revoked caregiver, cross-profile caller and pharmacist are denied', async () => {
  for (const principal of ['revoked', 'cross-profile']) {
    const service = createLabTrendService({
      repository: { async listConfirmedObservationHistory() { throw new Error('must not query'); } },
      async authorizeCareProfileAccess() { const error = new Error(principal); error.code = 'ACCESS_DENIED'; throw error; },
    });
    await assert.rejects(() => service({ careProfileId: 'CP-1', lineUserId: 'USER', identity: LOINC }), /revoked|cross-profile/);
  }
  const pharmacist = createLabTrendService({
    repository: { async listConfirmedObservationHistory() { throw new Error('must not query'); } },
    async authorizeCareProfileAccess() { return { principalType: 'pharmacist', permissions: ['view'] }; },
  });
  await assert.rejects(() => pharmacist({ careProfileId: 'CP-1', lineUserId: 'PHARM', identity: LOINC }),
    (error) => error.code === 'ACCESS_DENIED');
});

test('history reads are bounded and expose an opaque cursor', async () => {
  let seen;
  const service = createLabTrendService({
    repository: { async listConfirmedObservationHistory(input) { seen = input; return [...pair(), row({ reportId: 'LABR-3' })]; } },
    async authorizeCareProfileAccess() { return { principalType: 'family_owner', permissions: ['*'] }; },
  });
  const result = await service({ careProfileId: 'CP-1', lineUserId: 'OWNER', identity: LOINC, limit: 2 });
  assert.equal(seen.limit, 2);
  assert.equal(result.hasMore, true);
  assert.equal(decodeCursor(result.nextCursor), 2);
  assert.equal(decodeCursor(encodeCursor(4)), 4);
});
