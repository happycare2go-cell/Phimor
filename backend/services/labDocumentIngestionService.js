const { PendingCards, Residents, withTransaction } = require('../db');
const aiProvider = require('../providers/aiProvider');
const { AI_ERROR_CODES } = require('../providers/aiErrors');
const { loadV2Config } = require('../config/v2Config');
const { recordAIInteractionMetadata } = require('./aiAuditService');
const { createLabRepository } = require('./labRepository');
const { parseNumericSourceValue, parseExplicitReferenceRange } = require('../providers/labDocumentAI');

const SAFE_REVIEW_REPORT_FIELDS = Object.freeze([
  'appointmentId', 'laboratoryName', 'hospitalName', 'specimenCollectedAt', 'reportedAt', 'observations',
]);
const SAFE_REVIEW_OBSERVATION_FIELDS = Object.freeze([
  'sourceOrdinal', 'analyteNameSource', 'sourceValueText', 'valueType', 'numericValue', 'textValue',
  'sourceUnit', 'referenceRangeText', 'referenceLow', 'referenceHigh', 'abnormalFlagSource',
  'specimenSource', 'methodSource', 'sourcePage', 'sourceRegion', 'extractionConfidence',
]);

class LabDocumentIngestionError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'LabDocumentIngestionError';
    this.code = code;
    this.status = status;
  }
}

function safeCardProjection(card) {
  return {
    cardId: card.card_id,
    centerId: card.center_id,
    residentId: card.resident_id,
    status: card.status,
    documentSubtype: card.document_subtype || card.ai_result?.documentSubtype || null,
    labExtractionStatus: card.lab_extraction_status || null,
    labExtractionErrorCode: card.lab_extraction_error_code || null,
    createdAt: card.created_at,
  };
}

function normalizeReviewPatch(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new LabDocumentIngestionError('INVALID_LAB_REVIEW');
  }
  const patch = {};
  for (const field of SAFE_REVIEW_REPORT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    if (field !== 'observations') patch[field] = input[field];
  }
  if (Object.prototype.hasOwnProperty.call(input, 'observations')) {
    if (!Array.isArray(input.observations)) throw new LabDocumentIngestionError('INVALID_LAB_REVIEW');
    patch.observations = input.observations.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new LabDocumentIngestionError('INVALID_LAB_REVIEW');
      }
      const observation = {};
      for (const field of SAFE_REVIEW_OBSERVATION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(item, field)) observation[field] = item[field];
      }
      // Lab 1B never accepts coding, normalization, or comparison metadata from
      // the extraction/reviewer surface.
      const sourceValueText = observation.sourceValueText;
      const numericValue = typeof sourceValueText === 'string'
        ? parseNumericSourceValue(sourceValueText) : null;
      const range = parseExplicitReferenceRange(observation.referenceRangeText || null);
      return {
        ...observation,
        sourceOrdinal: index + 1,
        valueType: numericValue === null ? 'text' : 'numeric',
        numericValue,
        textValue: numericValue === null ? sourceValueText : null,
        ...range,
        loincCode: null,
        loincVerificationSource: null,
        ucumUnit: null,
        normalizedNumericValue: null,
        unitNormalizationSource: null,
        comparisonKey: null,
      };
    });
  }
  return patch;
}

function candidateToDraftInput(candidate, card) {
  const report = candidate?.report && typeof candidate.report === 'object' ? candidate.report : {};
  const observations = Array.isArray(candidate?.observations) ? candidate.observations : [];
  const purgedAt = card.source_image_purged_at || null;
  return {
    laboratoryName: report.laboratoryName ?? null,
    hospitalName: report.hospitalName ?? null,
    specimenCollectedAt: report.specimenCollectedAt ?? null,
    reportedAt: report.reportedAt ?? null,
    observations,
    sources: [{
      sourceKind: 'pending_card',
      pendingCardId: card.card_id,
      sourceReference: `pending-card:${card.card_id}`,
      mimeType: card.image_mime_type || null,
      byteSize: Number.isSafeInteger(card.image_byte_size) ? card.image_byte_size : null,
      storageStatus: card.image_base64 ? 'available' : (purgedAt ? 'purged' : 'not_retained'),
      purgedAt,
      retentionUntil: null,
    }],
  };
}

function createLabDocumentIngestionService(overrides = {}) {
  const cards = overrides.PendingCards || PendingCards;
  const residents = overrides.Residents || Residents;
  const transaction = overrides.withTransaction || withTransaction;
  const repository = overrides.repository || createLabRepository(overrides.repositoryOptions);
  const labs = overrides.labResultService
    || require('./labResultService').createLabResultService(overrides.labServiceOptions);
  const interpretLabDocument = overrides.interpretLabDocument || aiProvider.interpretLabDocument;
  const recordAudit = overrides.recordAIInteractionMetadata || recordAIInteractionMetadata;
  const configLoader = overrides.loadV2Config || loadV2Config;

  async function auditExtraction({ careProfileId = null, resultStatus, errorCode = null }) {
    const config = configLoader();
    await recordAudit({
      requesterLineId: null,
      careProfileId,
      requesterType: 'system',
      purpose: 'lab_document_extraction',
      intent: 'structured_lab_draft',
      provider: config.ai.provider,
      model: config.ai.documentModel || null,
      promptVersion: 'lab-document-extraction-v1',
      contextVersion: 'lab-draft-v1',
      requestedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      resultStatus,
      errorCode,
      inputCharacterCount: 0,
      outputCharacterCount: 0,
    });
  }

  async function extractDraftCandidate({ imageBuffer, imageMimeType = 'image/jpeg', careProfileId = null } = {}) {
    try {
      const candidate = await interpretLabDocument(imageBuffer, imageMimeType);
      await auditExtraction({ careProfileId, resultStatus: 'needs_review' });
      return candidate;
    } catch (error) {
      const errorCode = Object.values(AI_ERROR_CODES).includes(error?.code)
        ? error.code : AI_ERROR_CODES.AI_PROVIDER_ERROR;
      await auditExtraction({ careProfileId, resultStatus: 'error', errorCode });
      throw error;
    }
  }

  async function ensureDraftForPendingCard({ cardId, lineUserId, extraction = null } = {}) {
    return transaction(`lab-ingest:pending-card:${cardId}`, async () => {
      const card = await cards.findOne((item) => item.card_id === cardId);
      if (!card) throw new LabDocumentIngestionError('CARD_NOT_FOUND', 404);
      if ((card.document_subtype || card.ai_result?.documentSubtype) !== 'lab_report') {
        throw new LabDocumentIngestionError('NOT_A_LAB_DOCUMENT');
      }
      const resident = card.resident_id
        ? await residents.findOne((item) => item.resident_id === card.resident_id
          && item.center_id === card.center_id && item.status === 'active')
        : null;
      if (!resident) return { ok: false, needsResidentSelection: true };
      if (!resident.care_profile_id) return { ok: false, needsCareProfile: true };

      const existing = await repository.findReportByPendingCardId(cardId);
      if (existing) {
        const report = await labs.getReport({
          careProfileId: resident.care_profile_id,
          reportId: existing.report_id,
          lineUserId,
          centerId: card.center_id,
        });
        if (card.lab_report_id !== existing.report_id) {
          await cards.update((item) => item.card_id === cardId, {
            lab_report_id: existing.report_id,
            lab_extraction_status: existing.status === 'draft' ? 'draft_created' : existing.status,
            lab_extraction_candidate: null,
          });
        }
        return { ok: true, created: false, report, careProfileId: resident.care_profile_id };
      }

      const candidate = extraction || card.lab_extraction_candidate || { report: {}, observations: [] };
      const report = await labs.createDraft({
        careProfileId: resident.care_profile_id,
        lineUserId,
        centerId: card.center_id,
        input: candidateToDraftInput(candidate, card),
      });
      await cards.update((item) => item.card_id === cardId, {
        lab_report_id: report.reportId,
        lab_extraction_status: 'draft_created',
        lab_extraction_candidate: null,
        lab_uncertain_fields: Array.isArray(candidate.uncertainFields) ? candidate.uncertainFields : [],
      });
      return { ok: true, created: true, report, careProfileId: resident.care_profile_id };
    });
  }

  async function getReview({ cardId, lineUserId } = {}) {
    const ensured = await ensureDraftForPendingCard({ cardId, lineUserId });
    if (!ensured.ok) return ensured;
    const card = await cards.findOne((item) => item.card_id === cardId);
    return {
      ok: true,
      card: safeCardProjection(card),
      labDraft: ensured.report,
      reviewStatus: ensured.report.status === 'draft' ? 'รอตรวจสอบ' : 'ยืนยันแล้ว',
      uncertainFields: Array.isArray(card.lab_uncertain_fields) ? card.lab_uncertain_fields : [],
      imageBase64: card.image_base64 || null,
      imageMimeType: card.image_mime_type || null,
    };
  }

  async function updateReview({ cardId, lineUserId, labReport } = {}) {
    const ensured = await ensureDraftForPendingCard({ cardId, lineUserId });
    if (!ensured.ok) return ensured;
    const card = await cards.findOne((item) => item.card_id === cardId);
    const report = await labs.updateDraft({
      careProfileId: ensured.careProfileId,
      reportId: ensured.report.reportId,
      lineUserId,
      centerId: card.center_id,
      patch: normalizeReviewPatch(labReport),
    });
    await cards.update((item) => item.card_id === cardId, {
      lab_extraction_status: 'reviewed',
      edited_fields: [...new Set([...(card.edited_fields || []), 'labReport'])],
    });
    return { ok: true, report };
  }

  async function confirmReview({ cardId, lineUserId } = {}) {
    const ensured = await ensureDraftForPendingCard({ cardId, lineUserId });
    if (!ensured.ok) return ensured;
    const card = await cards.findOne((item) => item.card_id === cardId);
    if (ensured.report.status === 'confirmed') {
      return { ok: true, report: ensured.report, careProfileId: ensured.careProfileId, alreadyConfirmed: true };
    }
    const report = await labs.confirmDraft({
      careProfileId: ensured.careProfileId,
      reportId: ensured.report.reportId,
      lineUserId,
      centerId: card.center_id,
    });
    return { ok: true, report, careProfileId: ensured.careProfileId };
  }

  async function markSourcePurged({ pendingCardId, purgedAt }) {
    return repository.markPendingCardSourcePurged(pendingCardId, purgedAt);
  }

  return {
    extractDraftCandidate, ensureDraftForPendingCard, getReview, updateReview,
    confirmReview, markSourcePurged,
  };
}

module.exports = {
  createLabDocumentIngestionService, LabDocumentIngestionError,
  safeCardProjection, normalizeReviewPatch, candidateToDraftInput,
};
