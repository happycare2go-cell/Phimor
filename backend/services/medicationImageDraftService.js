const { decodeMedicalImage } = require('../utils/imageUpload');
const aiProvider = require('../providers/aiProvider');
const { MEDICATION_FIELDS } = require('../providers/documentAI');

const CANONICAL_FIELDS = new Set(MEDICATION_FIELDS);

class MedicationImageDraftError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'MedicationImageDraftError';
    this.code = code;
    this.status = status;
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

function createMedicationImageDraftService({ decode = decodeMedicalImage, interpret = aiProvider.interpretDocument } = {}) {
  async function extractImage(input = {}) {
    const image = decode(input.imageBase64, input.imageMimeType);
    if (!image.ok) throw new MedicationImageDraftError(image.error, image.status, image.message);
    let parsed;
    try {
      parsed = await interpret(image.buffer, image.mimeType);
    } catch (_) {
      throw new MedicationImageDraftError('MEDICATION_IMAGE_UNREADABLE', 422,
        'อ่านข้อมูลจากรูปนี้ไม่ได้ กรุณาถ่ายใหม่หรือกรอกข้อมูลเอง');
    }
    const source = (Array.isArray(parsed?.medications) ? parsed.medications : [])
      .filter((item) => typeof item?.name === 'string' && item.name.trim())
      .slice(0, 30);
    const items = source.map(canonicalDraft);
    return {
      items,
      review:source.map(reviewProjection),
      status:items.length ? 'read' : 'unreadable',
    };
  }

  return { extractImage };
}

const defaultService = createMedicationImageDraftService();

module.exports = {
  MedicationImageDraftError, canonicalDraft, reviewProjection, createMedicationImageDraftService,
  extractImage:defaultService.extractImage,
};
