const { decodeMedicalImage } = require('../utils/imageUpload');
const aiProvider = require('../providers/aiProvider');
const { MEDICATION_FIELDS } = require('../providers/documentAI');
const { AI_ERROR_CODES } = require('../providers/aiErrors');

const CANONICAL_FIELDS = new Set(MEDICATION_FIELDS);
const SAFE_AI_ERROR_CODES = new Set(Object.values(AI_ERROR_CODES));
const EXTRACTION_UNAVAILABLE_MESSAGE = 'ระบบอ่านฉลากยาชั่วคราวไม่ได้ กรุณาลองอีกครั้ง';

class MedicationImageDraftError extends Error {
  constructor(code, status, message, { diagnosticCode = null } = {}) {
    super(message);
    this.name = 'MedicationImageDraftError';
    this.code = code;
    this.status = status;
    this.diagnosticCode = diagnosticCode;
  }
}

function canonicalDraft(value = {}) {
  const item = {};
  for (const field of MEDICATION_FIELDS) item[field] = typeof value[field] === 'string' ? value[field] : '';
  return item;
}

function reviewProjection(value = {}, extractedIndex) {
  const uncertainFields = [...new Set((Array.isArray(value.uncertainFields) ? value.uncertainFields : [])
    .filter((field) => CANONICAL_FIELDS.has(field)))];
  return { extractedIndex, state:uncertainFields.length ? 'review' : 'read', uncertainFields };
}

function safeOperationalLog(logger, stage, detail = {}) {
  if (typeof logger !== 'function') return;
  try {
    logger({ event:'medication_image_extraction', stage, ...detail });
  } catch (_) { /* observability must not alter the draft flow */ }
}

function diagnosticCode(error) {
  return SAFE_AI_ERROR_CODES.has(error?.code) ? error.code : AI_ERROR_CODES.AI_PROVIDER_ERROR;
}

function validateMedicationResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.medications)) return false;
  return value.medications.every((item) => item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.name === 'string' && item.name.trim()
    && MEDICATION_FIELDS.every((field) => item[field] === undefined || typeof item[field] === 'string')
    && (item.uncertainFields === undefined || Array.isArray(item.uncertainFields)));
}

function createMedicationImageDraftService({
  decode = decodeMedicalImage,
  interpret = aiProvider.interpretDocument,
  operationalLogger = console.info,
} = {}) {
  async function extractImage(input = {}) {
    const image = decode(input.imageBase64, input.imageMimeType);
    if (!image.ok) {
      safeOperationalLog(operationalLogger, 'image_rejected', { safeErrorCode:image.error });
      throw new MedicationImageDraftError(image.error, image.status, image.message);
    }
    safeOperationalLog(operationalLogger, 'image_decoded');
    safeOperationalLog(operationalLogger, 'provider_invoked');
    let parsed;
    try {
      parsed = await interpret(image.buffer, image.mimeType);
    } catch (error) {
      const safeCode = diagnosticCode(error);
      safeOperationalLog(operationalLogger,
        safeCode === AI_ERROR_CODES.AI_INVALID_RESPONSE ? 'response_validation_failed' : 'provider_failed',
        { safeErrorCode:safeCode });
      throw new MedicationImageDraftError('MEDICATION_EXTRACTION_UNAVAILABLE', 503,
        EXTRACTION_UNAVAILABLE_MESSAGE, { diagnosticCode:safeCode });
    }
    safeOperationalLog(operationalLogger, 'provider_succeeded');
    if (!validateMedicationResponse(parsed)) {
      safeOperationalLog(operationalLogger, 'response_validation_failed',
        { safeErrorCode:AI_ERROR_CODES.AI_INVALID_RESPONSE });
      throw new MedicationImageDraftError('MEDICATION_EXTRACTION_UNAVAILABLE', 503,
        EXTRACTION_UNAVAILABLE_MESSAGE, { diagnosticCode:AI_ERROR_CODES.AI_INVALID_RESPONSE });
    }
    const source = parsed.medications.slice(0, 30);
    const items = source.map(canonicalDraft);
    safeOperationalLog(operationalLogger, 'response_validated', { medicationCandidateCount:items.length });
    return {
      items,
      review:source.map(reviewProjection),
      status:items.length ? 'read' : 'no_medication_detected',
    };
  }

  return { extractImage };
}

const defaultService = createMedicationImageDraftService();

module.exports = {
  MedicationImageDraftError, canonicalDraft, reviewProjection, validateMedicationResponse,
  createMedicationImageDraftService,
  extractImage:defaultService.extractImage,
};
