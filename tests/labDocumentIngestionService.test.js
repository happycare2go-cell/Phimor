const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { createLabDocumentIngestionService } = require('../backend/services/labDocumentIngestionService');
const { AIProviderError, AI_ERROR_CODES } = require('../backend/providers/aiErrors');

function fixture(overrides = {}) {
  const state = {
    cards: [{
      card_id: 'CARD-1', center_id: 'CENTER-1', resident_id: 'RES-1', status: 'pending',
      document_subtype: 'lab_report', ai_result: { documentSubtype: 'lab_report' },
      image_base64: Buffer.from('PRIVATE IMAGE').toString('base64'), image_mime_type: 'image/jpeg',
      image_byte_size: 13, created_at: '2026-08-26T00:00:00.000Z', edited_fields: [],
    }],
    residents: [{ resident_id: 'RES-1', center_id: 'CENTER-1', care_profile_id: 'CP-1', status: 'active' }],
    reports: [], calls: [], audits: [], purged: [],
  };
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const PendingCards = {
    async findOne(predicate) { return clone(state.cards.find(predicate) || null); },
    async update(predicate, patch) {
      const index = state.cards.findIndex(predicate); if (index < 0) return null;
      state.cards[index] = { ...state.cards[index], ...clone(patch) }; return clone(state.cards[index]);
    },
  };
  const Residents = { async findOne(predicate) { return clone(state.residents.find(predicate) || null); } };
  const repository = {
    async findReportByPendingCardId(cardId) {
      return clone(state.reports.find((item) => item.pending_card_id === cardId) || null);
    },
    async markPendingCardSourcePurged(cardId, purgedAt) {
      state.purged.push({ cardId, purgedAt }); return [{ source_id: 'SRC-1', report_id: 'LABR-1' }];
    },
  };
  const labResultService = {
    async createDraft(input) {
      state.calls.push({ operation: 'createDraft', input: clone(input) });
      if (input.careProfileId !== 'CP-1' || input.centerId !== 'CENTER-1') throw Object.assign(new Error('denied'), { code: 'ACCESS_DENIED' });
      const report = {
        reportId: 'LABR-1', status: 'draft', ...input.input,
        sources: clone(input.input.sources), observations: clone(input.input.observations),
      };
      state.reports.push({ report_id: 'LABR-1', status: 'draft', pending_card_id: 'CARD-1', report });
      return clone(report);
    },
    async getReport(input) {
      state.calls.push({ operation: 'getReport', input: clone(input) });
      return clone(state.reports.find((item) => item.report_id === input.reportId)?.report);
    },
    async updateDraft(input) {
      state.calls.push({ operation: 'updateDraft', input: clone(input) });
      const record = state.reports.find((item) => item.report_id === input.reportId);
      record.report = { ...record.report, ...clone(input.patch) };
      return clone(record.report);
    },
    async confirmDraft(input) {
      state.calls.push({ operation: 'confirmDraft', input: clone(input) });
      const record = state.reports.find((item) => item.report_id === input.reportId);
      record.status = 'confirmed'; record.report.status = 'confirmed';
      return clone(record.report);
    },
  };
  const service = createLabDocumentIngestionService({
    PendingCards, Residents, repository, labResultService,
    withTransaction: async (_key, callback) => callback(),
    interpretLabDocument: overrides.interpretLabDocument || (async () => ({
      report: { laboratoryName: 'ห้อง Lab' },
      observations: [{ sourceOrdinal: 1, analyteNameSource: 'HbA1c', sourceValueText: '6.8', valueType: 'numeric', numericValue: 6.8, textValue: null }],
      uncertainFields: [],
    })),
    recordAIInteractionMetadata: async (metadata) => { state.audits.push(clone(metadata)); return { recorded: true }; },
    loadV2Config: () => ({ ai: { provider: 'gemini', documentModel: 'test-model' } }),
  });
  return { service, state, PendingCards, labResultService };
}

test('Lab extraction audit is metadata-only and contains no image, values, or LINE identity', async () => {
  const { service, state } = fixture();
  await service.extractDraftCandidate({ imageBuffer: Buffer.from('PRIVATE IMAGE'), careProfileId: 'CP-1' });
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].purpose, 'lab_document_extraction');
  assert.equal(state.audits[0].requesterLineId, null);
  const serialized = JSON.stringify(state.audits);
  assert.doesNotMatch(serialized, /PRIVATE IMAGE|HbA1c|6\.8|U-/);
});

test('Pending Card extraction creates one Lab 1A draft with provenance and no Base64 copy', async () => {
  const { service, state } = fixture();
  const extraction = await service.extractDraftCandidate({ imageBuffer: Buffer.from('PRIVATE IMAGE') });
  const first = await service.ensureDraftForPendingCard({ cardId: 'CARD-1', lineUserId: 'U-STAFF', extraction });
  const second = await service.ensureDraftForPendingCard({ cardId: 'CARD-1', lineUserId: 'U-STAFF' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(state.calls.filter((call) => call.operation === 'createDraft').length, 1);
  const input = state.calls.find((call) => call.operation === 'createDraft').input.input;
  assert.equal(input.sources[0].sourceKind, 'pending_card');
  assert.equal(input.sources[0].pendingCardId, 'CARD-1');
  assert.equal(input.sources[0].mimeType, 'image/jpeg');
  assert.equal(input.sources[0].byteSize, 13);
  assert.equal(input.sources[0].storageStatus, 'available');
  assert.doesNotMatch(JSON.stringify(input), /PRIVATE IMAGE|image_base64/i);
  assert.equal(state.cards[0].lab_extraction_candidate, null);
});

test('uncertain resident identity and missing Care Profile stop before draft creation', async () => {
  const noResident = fixture();
  noResident.state.cards[0].resident_id = null;
  assert.equal((await noResident.service.ensureDraftForPendingCard({ cardId: 'CARD-1', lineUserId: 'U-STAFF' })).needsResidentSelection, true);
  assert.equal(noResident.state.calls.length, 0);

  const noProfile = fixture();
  noProfile.state.residents[0].care_profile_id = null;
  assert.equal((await noProfile.service.ensureDraftForPendingCard({ cardId: 'CARD-1', lineUserId: 'U-STAFF' })).needsCareProfile, true);
  assert.equal(noProfile.state.calls.length, 0);
});

test('draft binding uses the resident Care Profile and preserves centralized authorization inputs', async () => {
  const { service, state } = fixture();
  await service.ensureDraftForPendingCard({ cardId: 'CARD-1', lineUserId: 'U-CENTER-STAFF' });
  const call = state.calls.find((item) => item.operation === 'createDraft').input;
  assert.deepEqual({ careProfileId: call.careProfileId, lineUserId: call.lineUserId, centerId: call.centerId }, {
    careProfileId: 'CP-1', lineUserId: 'U-CENTER-STAFF', centerId: 'CENTER-1',
  });
});

test('review updates delegate to Lab 1A and strip coding/normalization/trend fields', async () => {
  const { service, state } = fixture();
  await service.ensureDraftForPendingCard({ cardId: 'CARD-1', lineUserId: 'U-MANAGER' });
  await service.updateReview({
    cardId: 'CARD-1', lineUserId: 'U-MANAGER', labReport: {
      hospitalName: 'โรงพยาบาลทดสอบ', rawImage: 'BASE64',
      observations: [{
        sourceOrdinal: 99, analyteNameSource: 'Creatinine', sourceValueText: '1.2',
        valueType: 'text', numericValue: 999, textValue: 'wrong', referenceRangeText: '0.6 - 1.3',
        loincCode: 'SHOULD-NOT-PASS', ucumUnit: 'mg/dL', comparisonKey: 'unsafe',
      }],
    },
  });
  const patch = state.calls.find((item) => item.operation === 'updateDraft').input.patch;
  assert.equal(patch.rawImage, undefined);
  assert.equal(patch.observations[0].loincCode, null);
  assert.equal(patch.observations[0].ucumUnit, null);
  assert.equal(patch.observations[0].comparisonKey, null);
  assert.equal(patch.observations[0].sourceOrdinal, 1);
  assert.equal(patch.observations[0].valueType, 'numeric');
  assert.equal(patch.observations[0].numericValue, 1.2);
  assert.equal(patch.observations[0].textValue, null);
  assert.equal(patch.observations[0].referenceLow, 0.6);
  assert.equal(patch.observations[0].referenceHigh, 1.3);
});

test('human confirmation delegates exclusively to Lab 1A confirmDraft', async () => {
  const { service, state } = fixture();
  await service.ensureDraftForPendingCard({ cardId: 'CARD-1', lineUserId: 'U-MANAGER' });
  await service.updateReview({
    cardId: 'CARD-1', lineUserId: 'U-MANAGER',
    labReport: { observations: [{ analyteNameSource: 'HbA1c', sourceValueText: '6.8' }] },
  });
  const result = await service.confirmReview({ cardId: 'CARD-1', lineUserId: 'U-MANAGER' });
  assert.equal(result.report.status, 'confirmed');
  assert.equal(state.calls.filter((call) => call.operation === 'confirmDraft').length, 1);
});

test('Pending Card Lab confirmation requires a persisted human review state', async () => {
  const { service, state } = fixture();
  await service.ensureDraftForPendingCard({ cardId: 'CARD-1', lineUserId: 'U-MANAGER' });
  await assert.rejects(
    service.confirmReview({ cardId: 'CARD-1', lineUserId: 'U-MANAGER' }),
    (error) => error.code === 'LAB_REVIEW_REQUIRED' && error.status === 409,
  );
  assert.equal(state.calls.filter((call) => call.operation === 'confirmDraft').length, 0);
  assert.equal(state.reports[0].status, 'draft');
});

test('AI extraction failure records a safe failure and creates no report or confirmed data', async () => {
  const failure = new AIProviderError(AI_ERROR_CODES.AI_TIMEOUT, 'private provider detail');
  const { service, state } = fixture({ interpretLabDocument: async () => { throw failure; } });
  await assert.rejects(service.extractDraftCandidate({ imageBuffer: Buffer.from('PRIVATE IMAGE') }), failure);
  assert.equal(state.reports.length, 0);
  assert.equal(state.audits[0].resultStatus, 'error');
  assert.equal(state.audits[0].errorCode, 'AI_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(state.audits), /private provider detail|PRIVATE IMAGE/);
});

test('source image purge updates provenance status without deleting structured report data', async () => {
  const { service, state } = fixture();
  await service.ensureDraftForPendingCard({ cardId: 'CARD-1', lineUserId: 'U-STAFF' });
  await service.markSourcePurged({ pendingCardId: 'CARD-1', purgedAt: '2026-11-26T00:00:00.000Z' });
  assert.deepEqual(state.purged, [{ cardId: 'CARD-1', purgedAt: '2026-11-26T00:00:00.000Z' }]);
  assert.equal(state.reports.length, 1);
});

test('review projection contains no LINE IDs, contacts, or Lab Base64 field', async () => {
  const { service } = fixture();
  await service.ensureDraftForPendingCard({ cardId: 'CARD-1', lineUserId: 'U-STAFF' });
  const review = await service.getReview({ cardId: 'CARD-1', lineUserId: 'U-STAFF' });
  const labProjection = JSON.stringify({ card: review.card, labDraft: review.labDraft });
  assert.doesNotMatch(labProjection, /submitted_by|line_user|family_phone|emergency|image_base64|PRIVATE IMAGE/i);
  assert.ok(review.imageBase64, 'authorized Pending Card reviewer still receives the existing source-image channel');
  assert.deepEqual(review.sourceImage, { status: 'available', mimeType: 'image/jpeg', purgedAt: null });
});

test('review projection distinguishes purged, unavailable, and unsupported source images safely', async () => {
  const purged = fixture();
  purged.state.cards[0].image_base64 = null;
  purged.state.cards[0].source_image_purged_at = '2026-11-26T00:00:00.000Z';
  await purged.service.ensureDraftForPendingCard({ cardId: 'CARD-1', lineUserId: 'U-STAFF' });
  await purged.service.updateReview({
    cardId: 'CARD-1', lineUserId: 'U-MANAGER',
    labReport: { observations: [{ analyteNameSource: 'HbA1c', sourceValueText: '6.8' }] },
  });
  await purged.service.confirmReview({ cardId: 'CARD-1', lineUserId: 'U-MANAGER' });
  const purgedReview = await purged.service.getReview({ cardId: 'CARD-1', lineUserId: 'U-STAFF' });
  assert.deepEqual(purgedReview.sourceImage, { status: 'purged', mimeType: null, purgedAt: '2026-11-26T00:00:00.000Z' });
  assert.equal(purgedReview.imageBase64, null);
  assert.equal(purgedReview.labDraft.status, 'confirmed');
  assert.equal(purgedReview.labDraft.observations[0].analyteNameSource, 'HbA1c');

  const unavailable = fixture();
  unavailable.state.cards[0].image_base64 = null;
  await unavailable.service.ensureDraftForPendingCard({ cardId: 'CARD-1', lineUserId: 'U-STAFF' });
  assert.equal((await unavailable.service.getReview({ cardId: 'CARD-1', lineUserId: 'U-STAFF' })).sourceImage.status, 'unavailable');

  const unsupported = fixture();
  unsupported.state.cards[0].image_mime_type = 'image/svg+xml';
  await unsupported.service.ensureDraftForPendingCard({ cardId: 'CARD-1', lineUserId: 'U-STAFF' });
  const unsupportedReview = await unsupported.service.getReview({ cardId: 'CARD-1', lineUserId: 'U-STAFF' });
  assert.equal(unsupportedReview.sourceImage.status, 'unsupported');
  assert.equal(unsupportedReview.imageBase64, null);
  assert.equal(unsupportedReview.imageMimeType, null);
});

test('review projection preserves only bounded uncertain-field labels for human attention', async () => {
  const { service, state } = fixture();
  await service.ensureDraftForPendingCard({ cardId: 'CARD-1', lineUserId: 'U-STAFF' });
  state.cards[0].lab_uncertain_fields = [' observations[0].sourceUnit ', null, '', '<b>hospitalName</b>'];
  const review = await service.getReview({ cardId: 'CARD-1', lineUserId: 'U-STAFF' });
  assert.deepEqual(review.uncertainFields, ['observations[0].sourceUnit', '<b>hospitalName</b>']);
});
