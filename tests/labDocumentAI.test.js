const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { DOCUMENT_PROMPT, validateDocumentResult } = require('../backend/providers/documentAI');
const {
  validateLabExtractionResult, parseNumericSourceValue, parseExplicitReferenceRange,
} = require('../backend/providers/labDocumentAI');
const aiProvider = require('../backend/providers/aiProvider');

function medical(overrides = {}) {
  return {
    documentType: 'medical', unrelatedNote: '', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.9,
    appointment: null, medications: [], doctorNote: null, ...overrides,
  };
}

test('classifier routes an explicit Lab report to the dedicated subtype', () => {
  assert.equal(validateDocumentResult(medical({ documentSubtype: 'lab_report' })).documentSubtype, 'lab_report');
});

test('legacy medication, appointment and doctor-note results retain their existing flow', () => {
  assert.equal(validateDocumentResult(medical({ medications: [{ name: 'Metformin', dose: '500 mg' }] })).documentSubtype, 'medication');
  assert.equal(validateDocumentResult(medical({ appointment: { hospital: 'รพ.', datetime: null } })).documentSubtype, 'appointment');
  assert.equal(validateDocumentResult(medical({ doctorNote: 'ติดตามอาการ' })).documentSubtype, 'doctor_note');
  assert.equal(validateDocumentResult(medical({ documentSubtype: 'mixed' })).documentSubtype, 'mixed');
  assert.match(DOCUMENT_PROMPT, /บันทึก\/คำสั่งแพทย์เป็น doctor_note/);
  assert.doesNotMatch(DOCUMENT_PROMPT, /ถ้าไม่ใช่ใบนัด ซองยา หรือผลตรวจ ให้ตอบ unrelated/);
});

test('unrelated documents cannot become a Lab draft', () => {
  const result = validateDocumentResult({ documentType: 'unrelated', unrelatedNote: 'ไม่ใช่เอกสารทางการแพทย์' });
  assert.equal(result.documentSubtype, null);
});

test('Lab extraction preserves source analyte/value order and parses only plain finite numbers', () => {
  const result = validateLabExtractionResult({
    report: {}, observations: [
      { analyteNameSource: 'HbA1c (%)', sourceValueText: '6.8', sourceUnit: '%', extractionConfidence: 0.91 },
      { analyteNameSource: 'Urine protein', sourceValueText: 'Trace' },
    ],
  });
  assert.deepEqual(result.observations.map((item) => item.sourceOrdinal), [1, 2]);
  assert.equal(result.observations[0].analyteNameSource, 'HbA1c (%)');
  assert.equal(result.observations[0].numericValue, 6.8);
  assert.equal(result.observations[0].textValue, null);
  assert.equal(result.observations[1].numericValue, null);
  assert.equal(result.observations[1].textValue, 'Trace');
  assert.equal(parseNumericSourceValue('1,000'), null);
  assert.equal(parseNumericSourceValue('<5'), null);
});

test('missing source fields remain null and future coding/trend fields are never invented', () => {
  const observation = validateLabExtractionResult({
    report: {}, observations: [{ analyteNameSource: 'Creatinine', sourceValueText: '1.1' }],
  }).observations[0];
  assert.equal(observation.sourceUnit, null);
  assert.equal(observation.referenceRangeText, null);
  assert.equal(observation.abnormalFlagSource, null);
  assert.equal(observation.specimenSource, null);
  assert.equal(observation.methodSource, null);
  assert.equal(observation.loincCode, null);
  assert.equal(observation.ucumUnit, null);
  assert.equal(observation.comparisonKey, null);
});

test('reference bounds are parsed only from an explicit plain numeric range', () => {
  assert.deepEqual(parseExplicitReferenceRange('4.0 - 10.0'), { referenceLow: 4, referenceHigh: 10 });
  assert.deepEqual(parseExplicitReferenceRange('< 200'), { referenceLow: null, referenceHigh: null });
  assert.deepEqual(parseExplicitReferenceRange('ตามอายุ'), { referenceLow: null, referenceHigh: null });
});

test('invalid or uncertain timestamps remain missing rather than being guessed', () => {
  const report = validateLabExtractionResult({
    report: { specimenCollectedAt: '25/08/2569', reportedAt: '2026-08-25T09:30:00+07:00' },
    observations: [],
  }).report;
  assert.equal(report.specimenCollectedAt, null);
  assert.equal(report.reportedAt, '2026-08-25T02:30:00.000Z');
});

test('Lab extractor uses its dedicated provider task and schema', async () => {
  let call;
  aiProvider.clearMockQueue();
  aiProvider.setProviderForTests({
    async generateStructured(input) {
      call = input;
      return input.outputSchema({ report: {}, observations: [{ analyteNameSource: 'WBC', sourceValueText: '7.2' }] });
    },
  });
  const result = await aiProvider.interpretLabDocument(Buffer.from('synthetic-image'));
  assert.equal(call.task, 'lab_document_extraction');
  assert.match(call.systemInstructions, /ห้ามสร้างหน่วย/);
  assert.equal(result.observations[0].numericValue, 7.2);
  aiProvider.clearMockQueue();
});

test('Lab extractor rejects structurally invalid observations instead of fabricating placeholders', () => {
  assert.throws(() => validateLabExtractionResult({ report: {}, observations: [{ analyteNameSource: 'WBC' }] }), /source analyte and value/);
});
