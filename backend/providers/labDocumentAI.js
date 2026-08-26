const { AI_ERROR_CODES, AIProviderError } = require('./aiErrors');

const LAB_DOCUMENT_PROMPT = `คุณคือระบบสกัดข้อมูลจากเอกสารผลตรวจทางห้องปฏิบัติการภาษาไทย
ตอบเป็น JSON เท่านั้น และคัดลอกเฉพาะข้อมูลที่เห็นชัดในเอกสาร ห้ามอธิบายผล ห้ามวินิจฉัย และห้ามเดา
โครงสร้าง:
{
  "report": {
    "laboratoryName": "ชื่อห้องปฏิบัติการหรือ null",
    "hospitalName": "ชื่อโรงพยาบาลหรือ null",
    "specimenCollectedAt": "ISO 8601 เมื่อระบุชัด หรือ null",
    "reportedAt": "ISO 8601 เมื่อระบุชัด หรือ null"
  },
  "observations": [{
    "analyteNameSource": "ชื่อรายการตรวจตามต้นฉบับ",
    "sourceValueText": "ผลตามต้นฉบับ",
    "sourceUnit": "หน่วยตามต้นฉบับหรือ null",
    "referenceRangeText": "ช่วงอ้างอิงตามต้นฉบับหรือ null",
    "abnormalFlagSource": "ธงผิดปกติตามต้นฉบับหรือ null",
    "specimenSource": "สิ่งส่งตรวจตามต้นฉบับหรือ null",
    "methodSource": "วิธีตรวจตามต้นฉบับหรือ null",
    "sourcePage": "เลขหน้าหรือ null",
    "sourceRegion": { "x": 0, "y": 0, "width": 0, "height": 0, "page": 1 },
    "extractionConfidence": 0.0
  }],
  "uncertainFields": ["ตำแหน่ง field ที่ต้องให้มนุษย์ตรวจ เช่น observations[0].sourceUnit"]
}
ห้ามสร้างหน่วย ช่วงอ้างอิง ธงผิดปกติ สิ่งส่งตรวจ วิธีตรวจ LOINC UCUM ค่า normal ค่า critical หรือ comparison key เมื่อไม่มีในเอกสาร ให้ใช้ null`;

function invalid(message) {
  throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, message);
}

function nullableSourceText(value, field, maxLength = 4000) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') invalid(`${field} must be a string or null`);
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > maxLength) invalid(`${field} is invalid`);
  return normalized;
}

function safeTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

function parseNumericSourceValue(sourceValueText) {
  const trimmed = sourceValueText.trim();
  if (!NUMBER_PATTERN.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseExplicitReferenceRange(referenceRangeText) {
  if (!referenceRangeText) return { referenceLow: null, referenceHigh: null };
  const match = referenceRangeText.match(/^\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:-|–|—|to)\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*$/i);
  if (!match) return { referenceLow: null, referenceHigh: null };
  const referenceLow = Number(match[1]);
  const referenceHigh = Number(match[2]);
  if (!Number.isFinite(referenceLow) || !Number.isFinite(referenceHigh) || referenceLow > referenceHigh) {
    return { referenceLow: null, referenceHigh: null };
  }
  return { referenceLow, referenceHigh };
}

function normalizeSourceRegion(value, fallbackPage = null) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = ['x', 'y', 'width', 'height'];
  const region = {};
  for (const key of allowed) {
    if (value[key] === undefined) continue;
    const parsed = Number(value[key]);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    region[key] = parsed;
  }
  const page = value.page === undefined || value.page === null ? fallbackPage : Number(value.page);
  if (page !== null) {
    if (!Number.isSafeInteger(page) || page < 1) return null;
    region.page = page;
  }
  return Object.keys(region).length ? region : null;
}

function normalizeObservation(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Lab observation must be an object');
  const analyteNameSource = nullableSourceText(value.analyteNameSource, 'analyteNameSource', 500);
  const sourceValueText = nullableSourceText(value.sourceValueText, 'sourceValueText');
  if (!analyteNameSource || !sourceValueText) invalid('Lab observation requires source analyte and value');
  const numericValue = parseNumericSourceValue(sourceValueText);
  const sourcePage = value.sourcePage === undefined || value.sourcePage === null || value.sourcePage === ''
    ? null : Number(value.sourcePage);
  const safeSourcePage = Number.isSafeInteger(sourcePage) && sourcePage > 0 ? sourcePage : null;
  const referenceRangeText = nullableSourceText(value.referenceRangeText, 'referenceRangeText', 1000);
  const range = parseExplicitReferenceRange(referenceRangeText);
  const confidence = Number(value.extractionConfidence);
  return {
    sourceOrdinal: index + 1,
    analyteNameSource,
    sourceValueText,
    valueType: numericValue === null ? 'text' : 'numeric',
    numericValue,
    textValue: numericValue === null ? sourceValueText : null,
    sourceUnit: nullableSourceText(value.sourceUnit, 'sourceUnit', 160),
    referenceRangeText,
    ...range,
    abnormalFlagSource: nullableSourceText(value.abnormalFlagSource, 'abnormalFlagSource', 160),
    specimenSource: nullableSourceText(value.specimenSource, 'specimenSource', 500),
    methodSource: nullableSourceText(value.methodSource, 'methodSource', 500),
    loincCode: null,
    loincVerificationSource: null,
    ucumUnit: null,
    normalizedNumericValue: null,
    unitNormalizationSource: null,
    comparisonKey: null,
    sourcePage: safeSourcePage,
    sourceRegion: normalizeSourceRegion(value.sourceRegion, safeSourcePage),
    extractionConfidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null,
  };
}

function validateLabExtractionResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Lab extraction must be an object');
  const report = value.report === undefined || value.report === null ? {} : value.report;
  if (!report || typeof report !== 'object' || Array.isArray(report)) invalid('Lab report metadata must be an object');
  if (!Array.isArray(value.observations)) invalid('Lab observations must be an array');
  const uncertainFields = Array.isArray(value.uncertainFields)
    ? value.uncertainFields.filter((item) => typeof item === 'string' && item.trim()).slice(0, 100).map((item) => item.trim().slice(0, 200))
    : [];
  return {
    report: {
      laboratoryName: nullableSourceText(report.laboratoryName, 'laboratoryName', 500),
      hospitalName: nullableSourceText(report.hospitalName, 'hospitalName', 500),
      specimenCollectedAt: safeTimestamp(report.specimenCollectedAt),
      reportedAt: safeTimestamp(report.reportedAt),
    },
    observations: value.observations.map(normalizeObservation),
    uncertainFields,
  };
}

module.exports = {
  LAB_DOCUMENT_PROMPT, validateLabExtractionResult, parseNumericSourceValue,
  parseExplicitReferenceRange,
};
