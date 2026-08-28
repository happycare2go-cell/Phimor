const LAB_REPORT_STATUSES = Object.freeze(['draft', 'confirmed', 'voided']);
const LAB_SOURCE_KINDS = Object.freeze(['pending_card', 'family_upload', 'center_upload', 'api', 'manual']);
const LAB_VALUE_TYPES = Object.freeze(['numeric', 'text']);
const LAB_STORAGE_STATUSES = Object.freeze(['available', 'purged', 'not_retained']);
const LAB_EVENT_TYPES = Object.freeze([
  'draft_created', 'draft_updated', 'confirmed', 'correction_draft_created', 'voided',
]);
const LAB_ACTOR_TYPES = Object.freeze([
  'family_owner', 'family_caregiver', 'center_staff', 'center_owner', 'center_manager',
]);
const LAB_CREATED_SOURCES = Object.freeze(['family_liff', 'center_liff', 'api']);
const LAB_VERIFICATION_SOURCES = Object.freeze(['source_document', 'human_verified', 'trusted_api']);

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const REPORT_INPUT_FIELDS = new Set([
  'appointmentId', 'laboratoryName', 'hospitalName', 'specimenCollectedAt',
  'reportedAt', 'retentionUntil', 'observations', 'sources',
]);
const OBSERVATION_INPUT_FIELDS = new Set([
  'sourceOrdinal', 'analyteNameSource', 'sourceValueText', 'valueType',
  'numericValue', 'textValue', 'sourceUnit', 'referenceRangeText',
  'referenceLow', 'referenceHigh', 'abnormalFlagSource', 'specimenSource',
  'methodSource', 'loincCode', 'loincVerificationSource', 'loincVerifiedBy',
  'loincVerifiedAt', 'ucumUnit', 'normalizedNumericValue',
  'unitNormalizationSource', 'comparisonKey', 'sourcePage', 'sourceRegion',
  'extractionConfidence',
]);
const SOURCE_INPUT_FIELDS = new Set([
  'sourceKind', 'pendingCardId', 'sourceReference', 'contentSha256', 'mimeType',
  'byteSize', 'pageNumber', 'storageStatus', 'retentionUntil', 'purgedAt',
]);

const ERROR_DEFINITIONS = Object.freeze({
  INVALID_INPUT: { status: 400, message: 'ข้อมูลผลตรวจไม่ถูกต้อง' },
  INVALID_IDENTIFIER: { status: 400, message: 'รหัสข้อมูลผลตรวจไม่ถูกต้อง' },
  UNSUPPORTED_FIELD: { status: 400, message: 'พบข้อมูลที่ระบบไม่รองรับ' },
  ACCESS_DENIED: { status: 403, message: 'ไม่พบข้อมูลหรือคุณไม่มีสิทธิ์เข้าถึง' },
  REPORT_NOT_FOUND: { status: 404, message: 'ไม่พบผลตรวจหรือคุณไม่มีสิทธิ์เข้าถึง' },
  REPORT_NOT_DRAFT: { status: 409, message: 'ผลตรวจนี้ไม่อยู่ในสถานะรอตรวจทาน' },
  REPORT_NOT_CONFIRMED: { status: 409, message: 'ผลตรวจนี้ยังไม่ได้รับการยืนยัน' },
  REPORT_ALREADY_VOIDED: { status: 409, message: 'ผลตรวจนี้ถูกยกเลิกแล้ว' },
  APPOINTMENT_NOT_FOUND: { status: 400, message: 'นัดหมายที่เชื่อมโยงไม่ถูกต้อง' },
  SOURCE_REFERENCE_INVALID: { status: 400, message: 'แหล่งที่มาของผลตรวจไม่ถูกต้อง' },
  INVALID_OBSERVATION: { status: 400, message: 'รายการผลตรวจไม่ถูกต้อง' },
  CONFIRMATION_REQUIRES_OBSERVATIONS: { status: 400, message: 'ต้องมีรายการผลตรวจก่อนยืนยัน' },
  CORRECTION_REASON_REQUIRED: { status: 400, message: 'กรุณาระบุเหตุผลในการแก้ไข' },
  VOID_REASON_REQUIRED: { status: 400, message: 'กรุณาระบุเหตุผลในการยกเลิกผลตรวจ' },
  RECORD_PROVENANCE_AMBIGUOUS: { status: 409, message: 'ไม่สามารถยืนยันแหล่งอำนาจของผลตรวจนี้ได้' },
  VERSION_CONFLICT: { status: 409, message: 'มีการสร้างฉบับแก้ไขพร้อมกัน กรุณาลองใหม่' },
});

class LabDomainError extends Error {
  constructor(code, details = {}) {
    const definition = ERROR_DEFINITIONS[code] || ERROR_DEFINITIONS.INVALID_INPUT;
    super(definition.message);
    this.name = 'LabDomainError';
    this.code = code;
    this.status = definition.status;
    Object.defineProperty(this, 'details', { value: details, enumerable: false });
  }
}

function fail(code, details) {
  throw new LabDomainError(code, details);
}

function assertPlainObject(value, code = 'INVALID_INPUT') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
}

function assertAllowedFields(value, allowlist) {
  assertPlainObject(value);
  const unsupported = Object.keys(value).filter((key) => !allowlist.has(key));
  if (unsupported.length) fail('UNSUPPORTED_FIELD', { fields: unsupported });
}

function normalizeIdentifier(value, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === '') && nullable) return null;
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) fail('INVALID_IDENTIFIER');
  return value;
}

function normalizeText(value, { nullable = true, required = false, max = 2000 } = {}) {
  if (value === null || value === undefined) {
    if (required) fail('INVALID_INPUT');
    return nullable ? null : '';
  }
  if (typeof value !== 'string') fail('INVALID_INPUT');
  const normalized = value.normalize('NFC').trim();
  if (!normalized && required) fail('INVALID_INPUT');
  if (!normalized && nullable) return null;
  if (normalized.length > max) fail('INVALID_INPUT');
  return normalized;
}

function normalizeTimestamp(value, { nullable = true } = {}) {
  if (value === null || value === undefined || value === '') return nullable ? null : fail('INVALID_INPUT');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail('INVALID_INPUT');
  return date.toISOString();
}

function normalizeFiniteNumber(value, { nullable = true, min = null, max = null } = {}) {
  if (value === null || value === undefined || value === ''
    || (typeof value === 'string' && !value.trim())) return nullable ? null : fail('INVALID_INPUT');
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) fail('INVALID_INPUT');
  if (min !== null && number < min) fail('INVALID_INPUT');
  if (max !== null && number > max) fail('INVALID_INPUT');
  return number;
}

function normalizePositiveInteger(value, { nullable = true } = {}) {
  if (value === null || value === undefined || value === ''
    || (typeof value === 'string' && !value.trim())) return nullable ? null : fail('INVALID_INPUT');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) fail('INVALID_INPUT');
  return number;
}

function normalizeReportInput(input, { partial = false } = {}) {
  assertAllowedFields(input, REPORT_INPUT_FIELDS);
  const result = {};
  const assign = (field, normalizer) => {
    if (!partial || Object.prototype.hasOwnProperty.call(input, field)) result[field] = normalizer(input[field]);
  };
  assign('appointmentId', (value) => normalizeIdentifier(value, { nullable: true }));
  assign('laboratoryName', (value) => normalizeText(value, { max: 500 }));
  assign('hospitalName', (value) => normalizeText(value, { max: 500 }));
  assign('specimenCollectedAt', normalizeTimestamp);
  assign('reportedAt', normalizeTimestamp);
  assign('retentionUntil', normalizeTimestamp);
  if (Object.prototype.hasOwnProperty.call(input, 'observations')) {
    if (!Array.isArray(input.observations)) fail('INVALID_INPUT');
    result.observations = normalizeObservations(input.observations);
  } else if (!partial) result.observations = [];
  if (Object.prototype.hasOwnProperty.call(input, 'sources')) {
    if (!Array.isArray(input.sources)) fail('INVALID_INPUT');
    result.sources = input.sources.map(normalizeSource);
  } else if (!partial) result.sources = [];
  return result;
}

function normalizeObservation(input, index = 0) {
  assertAllowedFields(input, OBSERVATION_INPUT_FIELDS);
  const valueType = normalizeText(input.valueType, { required: true, nullable: false, max: 16 });
  if (!LAB_VALUE_TYPES.includes(valueType)) fail('INVALID_OBSERVATION');
  const sourceOrdinal = input.sourceOrdinal === undefined
    ? index + 1 : normalizePositiveInteger(input.sourceOrdinal, { nullable: false });
  const numericValue = normalizeFiniteNumber(input.numericValue);
  const textValue = normalizeText(input.textValue, { max: 4000 });
  if (valueType === 'numeric' && (numericValue === null || textValue !== null)) fail('INVALID_OBSERVATION');
  if (valueType === 'text' && (numericValue !== null || textValue === null)) fail('INVALID_OBSERVATION');

  const referenceLow = normalizeFiniteNumber(input.referenceLow);
  const referenceHigh = normalizeFiniteNumber(input.referenceHigh);
  if (referenceLow !== null && referenceHigh !== null && referenceLow > referenceHigh) fail('INVALID_OBSERVATION');

  const loincCode = normalizeText(input.loincCode, { max: 64 });
  const loincVerificationSource = normalizeText(input.loincVerificationSource, { max: 80 });
  const loincVerifiedBy = normalizeText(input.loincVerifiedBy, { max: 128 });
  const loincVerifiedAt = normalizeTimestamp(input.loincVerifiedAt);
  if ((loincVerificationSource && !LAB_VERIFICATION_SOURCES.includes(loincVerificationSource))
    || Boolean(loincCode) !== Boolean(loincVerificationSource)
    || Boolean(loincVerifiedBy) !== Boolean(loincVerifiedAt)) {
    fail('INVALID_OBSERVATION', { reason: 'unverified_loinc' });
  }

  const normalizedNumericValue = normalizeFiniteNumber(input.normalizedNumericValue);
  const ucumUnit = normalizeText(input.ucumUnit, { max: 80 });
  const unitNormalizationSource = normalizeText(input.unitNormalizationSource, { max: 80 });
  if (unitNormalizationSource && !LAB_VERIFICATION_SOURCES.includes(unitNormalizationSource)) {
    fail('INVALID_OBSERVATION', { reason: 'invalid_unit_normalization_source' });
  }
  const hasNormalization = normalizedNumericValue !== null || ucumUnit !== null || unitNormalizationSource !== null;
  if (hasNormalization && (valueType !== 'numeric' || normalizedNumericValue === null || !ucumUnit || !unitNormalizationSource)) {
    fail('INVALID_OBSERVATION', { reason: 'incomplete_unit_normalization' });
  }

  let sourceRegion = null;
  if (input.sourceRegion !== null && input.sourceRegion !== undefined) {
    assertPlainObject(input.sourceRegion, 'INVALID_OBSERVATION');
    const allowedRegionFields = new Set(['x', 'y', 'width', 'height', 'page']);
    if (Object.keys(input.sourceRegion).some((key) => !allowedRegionFields.has(key))) {
      fail('INVALID_OBSERVATION', { reason: 'invalid_source_region' });
    }
    sourceRegion = {};
    for (const [key, value] of Object.entries(input.sourceRegion)) {
      sourceRegion[key] = key === 'page'
        ? normalizePositiveInteger(value, { nullable: false })
        : normalizeFiniteNumber(value, { nullable: false, min: 0 });
    }
  }

  return {
    sourceOrdinal,
    analyteNameSource: normalizeText(input.analyteNameSource, { required: true, nullable: false, max: 500 }),
    sourceValueText: normalizeText(input.sourceValueText, { required: true, nullable: false, max: 4000 }),
    valueType, numericValue, textValue,
    sourceUnit: normalizeText(input.sourceUnit, { max: 160 }),
    referenceRangeText: normalizeText(input.referenceRangeText, { max: 1000 }),
    referenceLow, referenceHigh,
    abnormalFlagSource: normalizeText(input.abnormalFlagSource, { max: 160 }),
    specimenSource: normalizeText(input.specimenSource, { max: 500 }),
    methodSource: normalizeText(input.methodSource, { max: 500 }),
    loincCode, loincVerificationSource, loincVerifiedBy, loincVerifiedAt,
    ucumUnit, normalizedNumericValue, unitNormalizationSource,
    comparisonKey: normalizeText(input.comparisonKey, { max: 160 }),
    sourcePage: normalizePositiveInteger(input.sourcePage), sourceRegion,
    extractionConfidence: normalizeFiniteNumber(input.extractionConfidence, { min: 0, max: 1 }),
  };
}

function normalizeObservations(observations) {
  const normalized = observations.map(normalizeObservation);
  const ordinals = new Set(normalized.map((item) => item.sourceOrdinal));
  if (ordinals.size !== normalized.length) fail('INVALID_OBSERVATION', { reason: 'duplicate_source_ordinal' });
  return normalized.sort((a, b) => a.sourceOrdinal - b.sourceOrdinal);
}

function normalizeSource(input) {
  assertAllowedFields(input, SOURCE_INPUT_FIELDS);
  const sourceKind = normalizeText(input.sourceKind, { required: true, nullable: false, max: 32 });
  const storageStatus = normalizeText(input.storageStatus ?? 'not_retained', {
    required: true, nullable: false, max: 24,
  });
  if (!LAB_SOURCE_KINDS.includes(sourceKind) || !LAB_STORAGE_STATUSES.includes(storageStatus)) fail('INVALID_INPUT');
  const pendingCardId = normalizeIdentifier(input.pendingCardId, { nullable: true });
  if (sourceKind === 'pending_card' && !pendingCardId) fail('INVALID_INPUT');
  const contentSha256 = normalizeText(input.contentSha256, { max: 64 });
  if (contentSha256 && !SHA256_PATTERN.test(contentSha256.toLowerCase())) fail('INVALID_INPUT');
  const purgedAt = normalizeTimestamp(input.purgedAt);
  if ((storageStatus === 'purged') !== Boolean(purgedAt)) fail('INVALID_INPUT');
  return {
    sourceKind, pendingCardId,
    sourceReference: normalizeText(input.sourceReference, { max: 2000 }),
    contentSha256: contentSha256 ? contentSha256.toLowerCase() : null,
    mimeType: normalizeText(input.mimeType, { max: 160 }),
    byteSize: input.byteSize === null || input.byteSize === undefined || input.byteSize === ''
      || (typeof input.byteSize === 'string' && !input.byteSize.trim())
      ? null : (() => {
        const parsed = Number(input.byteSize);
        if (!Number.isSafeInteger(parsed) || parsed < 0) fail('INVALID_INPUT');
        return parsed;
      })(),
    pageNumber: normalizePositiveInteger(input.pageNumber), storageStatus,
    retentionUntil: normalizeTimestamp(input.retentionUntil), purgedAt,
  };
}

function deriveLabActor(access) {
  if (access?.principalType === 'family_owner') return { actorType: 'family_owner', source: 'family_liff' };
  if (access?.principalType === 'family_caregiver') return { actorType: 'family_caregiver', source: 'family_liff' };
  if (access?.principalType === 'center_staff' && access.role === 'owner') return { actorType: 'center_owner', source: 'center_liff' };
  if (access?.principalType === 'center_staff' && access.role === 'manager') return { actorType: 'center_manager', source: 'center_liff' };
  if (access?.principalType === 'center_staff' && access.role === 'staff') return { actorType: 'center_staff', source: 'center_liff' };
  fail('ACCESS_DENIED');
}

function hasEditProfile(access) {
  return access?.permissions?.includes('*') || access?.permissions?.includes('edit_profile');
}

function canEditDraft(access) {
  if (access?.principalType === 'family_owner') return true;
  if (access?.principalType === 'family_caregiver') return hasEditProfile(access);
  return access?.principalType === 'center_staff' && ['owner', 'manager', 'staff'].includes(access.role);
}

function canConfirm(access) {
  if (access?.principalType === 'family_owner') return true;
  if (access?.principalType === 'family_caregiver') return hasEditProfile(access);
  return access?.principalType === 'center_staff' && ['owner', 'manager'].includes(access.role);
}

function requireDraftEdit(access) {
  if (!canEditDraft(access)) fail('ACCESS_DENIED');
}

function requireConfirmation(access) {
  if (!canConfirm(access)) fail('ACCESS_DENIED');
}

function requireConfirmableReport(report, observations) {
  if (!report || report.status !== 'draft') fail('REPORT_NOT_DRAFT');
  if (!Array.isArray(observations) || observations.length === 0) fail('CONFIRMATION_REQUIRES_OBSERVATIONS');
  normalizeObservations(observations.map((item) => ({
    sourceOrdinal: item.sourceOrdinal ?? item.source_ordinal,
    analyteNameSource: item.analyteNameSource ?? item.analyte_name_source,
    sourceValueText: item.sourceValueText ?? item.source_value_text,
    valueType: item.valueType ?? item.value_type,
    numericValue: item.numericValue ?? item.numeric_value,
    textValue: item.textValue ?? item.text_value,
    sourceUnit: item.sourceUnit ?? item.source_unit,
    referenceRangeText: item.referenceRangeText ?? item.reference_range_text,
    referenceLow: item.referenceLow ?? item.reference_low,
    referenceHigh: item.referenceHigh ?? item.reference_high,
    abnormalFlagSource: item.abnormalFlagSource ?? item.abnormal_flag_source,
    specimenSource: item.specimenSource ?? item.specimen_source,
    methodSource: item.methodSource ?? item.method_source,
    loincCode: item.loincCode ?? item.loinc_code,
    loincVerificationSource: item.loincVerificationSource ?? item.loinc_verification_source,
    loincVerifiedBy: item.loincVerifiedBy ?? item.loinc_verified_by,
    loincVerifiedAt: item.loincVerifiedAt ?? item.loinc_verified_at,
    ucumUnit: item.ucumUnit ?? item.ucum_unit,
    normalizedNumericValue: item.normalizedNumericValue ?? item.normalized_numeric_value,
    unitNormalizationSource: item.unitNormalizationSource ?? item.unit_normalization_source,
    comparisonKey: item.comparisonKey ?? item.comparison_key,
    sourcePage: item.sourcePage ?? item.source_page,
    sourceRegion: item.sourceRegion ?? item.source_region,
    extractionConfidence: item.extractionConfidence ?? item.extraction_confidence,
  })));
}

function sanitizeEventMetadata(metadata = {}) {
  const allowed = new Set([
    'reasonCode', 'changedFields', 'versionNo', 'previousVersionNo',
    'supersedesReportId', 'observationCount', 'sourceCount',
  ]);
  assertPlainObject(metadata);
  const safe = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!allowed.has(key)) continue;
    if (key === 'changedFields') {
      if (!Array.isArray(value)) continue;
      safe[key] = value.filter((item) => typeof item === 'string').slice(0, 20);
    } else if (typeof value === 'string' || Number.isSafeInteger(value)) safe[key] = value;
  }
  return safe;
}

module.exports = {
  LAB_REPORT_STATUSES, LAB_SOURCE_KINDS, LAB_VALUE_TYPES, LAB_STORAGE_STATUSES,
  LAB_EVENT_TYPES, LAB_ACTOR_TYPES, LAB_CREATED_SOURCES, LAB_VERIFICATION_SOURCES, IDENTIFIER_PATTERN,
  LabDomainError, fail, normalizeIdentifier, normalizeText, normalizeTimestamp,
  normalizeReportInput, normalizeObservation, normalizeObservations, normalizeSource,
  deriveLabActor, canEditDraft, canConfirm, requireDraftEdit, requireConfirmation,
  requireConfirmableReport, sanitizeEventMetadata,
};
