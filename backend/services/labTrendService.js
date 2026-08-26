const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { createLabRepository } = require('./labRepository');
const { LabDomainError, normalizeIdentifier } = require('../domain/lab');

const NON_COMPARABLE_REASONS = Object.freeze({
  ANALYTE_IDENTITY_UNVERIFIED: 'ANALYTE_IDENTITY_UNVERIFIED',
  NON_NUMERIC_RESULT: 'NON_NUMERIC_RESULT',
  SPECIMEN_TIME_MISSING: 'SPECIMEN_TIME_MISSING',
  SPECIMEN_MISMATCH: 'SPECIMEN_MISMATCH',
  METHOD_MISMATCH: 'METHOD_MISMATCH',
  UNIT_INCOMPATIBLE: 'UNIT_INCOMPATIBLE',
  AMBIGUOUS_OBSERVATION: 'AMBIGUOUS_OBSERVATION',
  INSUFFICIENT_CONFIRMED_HISTORY: 'INSUFFICIENT_CONFIRMED_HISTORY',
});
const SAFE_NON_COMPARABLE_MESSAGE = 'ไม่สามารถเปรียบเทียบแนวโน้มได้อย่างปลอดภัย';
const VERIFIED_NORMALIZATION_SOURCES = new Set(['source_document', 'human_verified', 'trusted_api']);
const IDENTITY_TYPES = Object.freeze(['loinc_code', 'comparison_key']);

function exactText(value) {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function value(row, camel, snake) {
  return row?.[camel] ?? row?.[snake] ?? null;
}

function validateIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new LabDomainError('INVALID_INPUT');
  }
  const keys = Object.keys(identity);
  if (keys.length !== 1 || !['loincCode', 'comparisonKey'].includes(keys[0])) {
    throw new LabDomainError('INVALID_INPUT');
  }
  const raw = identity[keys[0]];
  if (typeof raw !== 'string') throw new LabDomainError('INVALID_INPUT');
  const identityValue = raw.normalize('NFC').trim();
  if (!identityValue || identityValue.length > 160) throw new LabDomainError('INVALID_INPUT');
  return Object.freeze({
    type: keys[0] === 'loincCode' ? 'loinc_code' : 'comparison_key',
    value: identityValue,
  });
}

function identityMatches(row, identity) {
  if (identity.type === 'loinc_code') {
    return value(row, 'loincCode', 'loinc_code') === identity.value
      && Boolean(value(row, 'loincVerificationSource', 'loinc_verification_source'))
      && Boolean(value(row, 'loincVerifiedBy', 'loinc_verified_by'))
      && Boolean(value(row, 'loincVerifiedAt', 'loinc_verified_at'));
  }
  return value(row, 'comparisonKey', 'comparison_key') === identity.value;
}

function confirmedRows(rows, identity) {
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    value(row, 'reportStatus', 'report_status') === 'confirmed' && identityMatches(row, identity));
}

function rawPoint(row) {
  const specimenCollectedAt = value(row, 'specimenCollectedAt', 'specimen_collected_at');
  const parsedTime = specimenCollectedAt ? new Date(specimenCollectedAt) : null;
  return {
    reportId: value(row, 'reportId', 'report_id'),
    observationId: value(row, 'observationId', 'observation_id'),
    analyteNameSource: value(row, 'analyteNameSource', 'analyte_name_source'),
    specimenCollectedAt: parsedTime && !Number.isNaN(parsedTime.getTime()) ? parsedTime.toISOString() : null,
    sourceValueText: value(row, 'sourceValueText', 'source_value_text'),
    valueType: value(row, 'valueType', 'value_type'),
    numericValue: finite(value(row, 'numericValue', 'numeric_value')),
    sourceUnit: value(row, 'sourceUnit', 'source_unit'),
    referenceRangeText: value(row, 'referenceRangeText', 'reference_range_text'),
    referenceLow: finite(value(row, 'referenceLow', 'reference_low')),
    referenceHigh: finite(value(row, 'referenceHigh', 'reference_high')),
    abnormalFlagSource: value(row, 'abnormalFlagSource', 'abnormal_flag_source'),
    specimenSource: value(row, 'specimenSource', 'specimen_source'),
    methodSource: value(row, 'methodSource', 'method_source'),
    ucumUnit: value(row, 'ucumUnit', 'ucum_unit'),
    normalizedNumericValue: finite(value(row, 'normalizedNumericValue', 'normalized_numeric_value')),
    unitNormalizationSource: value(row, 'unitNormalizationSource', 'unit_normalization_source'),
  };
}

function nonComparable(reasonCode, identity, points) {
  return Object.freeze({
    status: 'not_comparable', reasonCode, message: SAFE_NON_COMPARABLE_MESSAGE,
    identity, sourceDisplayName: points.at(-1)?.analyteNameSource || points[0]?.analyteNameSource || null,
    observations: Object.freeze(points.map(Object.freeze)), rangesDiffer: false,
    absoluteChange: null, direction: null, comparisonUnit: null,
  });
}

function rangeFingerprint(point) {
  return JSON.stringify([
    point.referenceRangeText ?? null, point.referenceLow ?? null, point.referenceHigh ?? null,
  ]);
}

function buildDeterministicTrend(rows, identityInput) {
  let identity;
  try { identity = validateIdentity(identityInput); } catch (_) {
    return nonComparable(NON_COMPARABLE_REASONS.ANALYTE_IDENTITY_UNVERIFIED, null, []);
  }
  const confirmed = (Array.isArray(rows) ? rows : []).filter((row) =>
    value(row, 'reportStatus', 'report_status') === 'confirmed');
  const matched = confirmedRows(rows, identity);
  if (identity.type === 'loinc_code' && matched.length === 0
    && confirmed.some((row) => value(row, 'loincCode', 'loinc_code') === identity.value)) {
    return nonComparable(NON_COMPARABLE_REASONS.ANALYTE_IDENTITY_UNVERIFIED, identity, []);
  }
  const points = matched.map(rawPoint).sort((left, right) => {
    const leftTime = left.specimenCollectedAt ? new Date(left.specimenCollectedAt).getTime() : Number.NEGATIVE_INFINITY;
    const rightTime = right.specimenCollectedAt ? new Date(right.specimenCollectedAt).getTime() : Number.NEGATIVE_INFINITY;
    return leftTime - rightTime || String(left.reportId).localeCompare(String(right.reportId));
  });
  if (points.length < 2) return nonComparable(NON_COMPARABLE_REASONS.INSUFFICIENT_CONFIRMED_HISTORY, identity, points);
  const reportCounts = new Map();
  for (const point of points) reportCounts.set(point.reportId, (reportCounts.get(point.reportId) || 0) + 1);
  if ([...reportCounts.values()].some((count) => count > 1)) {
    return nonComparable(NON_COMPARABLE_REASONS.AMBIGUOUS_OBSERVATION, identity, points);
  }
  if (points.some((point) => !point.specimenCollectedAt)) {
    return nonComparable(NON_COMPARABLE_REASONS.SPECIMEN_TIME_MISSING, identity, points);
  }
  const specimenTimes = new Set(points.map((point) => point.specimenCollectedAt));
  if (specimenTimes.size !== points.length) {
    return nonComparable(NON_COMPARABLE_REASONS.AMBIGUOUS_OBSERVATION, identity, points);
  }
  if (points.some((point) => point.valueType !== 'numeric' || point.numericValue === null)) {
    return nonComparable(NON_COMPARABLE_REASONS.NON_NUMERIC_RESULT, identity, points);
  }
  const specimens = new Set(points.map((point) => exactText(point.specimenSource)));
  if (specimens.has('') || specimens.size !== 1) {
    return nonComparable(NON_COMPARABLE_REASONS.SPECIMEN_MISMATCH, identity, points);
  }
  const methods = new Set(points.map((point) => exactText(point.methodSource)));
  if (methods.has('') || methods.size !== 1) {
    return nonComparable(NON_COMPARABLE_REASONS.METHOD_MISMATCH, identity, points);
  }

  const sourceUnits = new Set(points.map((point) => exactText(point.sourceUnit)));
  let normalizedValues;
  let comparisonUnit;
  let normalizationBasis;
  if (!sourceUnits.has('') && sourceUnits.size === 1) {
    normalizedValues = points.map((point) => point.numericValue);
    comparisonUnit = points[0].sourceUnit;
    normalizationBasis = 'exact_source_unit';
  } else {
    const ucumUnits = new Set(points.map((point) => exactText(point.ucumUnit)));
    const verified = points.every((point) => point.normalizedNumericValue !== null
      && VERIFIED_NORMALIZATION_SOURCES.has(point.unitNormalizationSource));
    if (ucumUnits.has('') || ucumUnits.size !== 1 || !verified) {
      return nonComparable(NON_COMPARABLE_REASONS.UNIT_INCOMPATIBLE, identity, points);
    }
    normalizedValues = points.map((point) => point.normalizedNumericValue);
    comparisonUnit = points[0].ucumUnit;
    normalizationBasis = 'verified_ucum_value';
  }
  const projectedPoints = points.map((point, index) => Object.freeze({
    ...point, normalizedValue: normalizedValues[index], normalizationBasis,
  }));
  const change = normalizedValues.at(-1) - normalizedValues[0];
  const direction = change > 0 ? 'increased' : change < 0 ? 'decreased' : 'unchanged';
  const rangesDiffer = new Set(points.map(rangeFingerprint)).size > 1;
  return Object.freeze({
    status: 'available', reasonCode: null, message: null, identity,
    sourceDisplayName: points.at(-1).analyteNameSource,
    observations: Object.freeze(projectedPoints), rangesDiffer,
    absoluteChange: change, direction, comparisonUnit, normalizationBasis,
  });
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 10000) throw new Error('invalid');
    return value.offset;
  } catch (_) { throw new LabDomainError('INVALID_INPUT'); }
}

function createLabTrendService(overrides = {}) {
  const repository = overrides.repository || createLabRepository(overrides.repositoryOptions);
  const authorize = overrides.authorizeCareProfileAccess || authorizeCareProfileAccess;

  return async function getLabTrend({
    careProfileId, lineUserId, centerId = null, identity, limit = 20, cursor = null,
  } = {}) {
    normalizeIdentifier(careProfileId);
    if (typeof lineUserId !== 'string' || !lineUserId.trim() || lineUserId.length > 128) {
      throw new LabDomainError('ACCESS_DENIED');
    }
    const parsedIdentity = validateIdentity(identity);
    const parsedLimit = Number(limit || 20);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 2 || parsedLimit > 50) {
      throw new LabDomainError('INVALID_INPUT');
    }
    const access = await authorize({
      lineUserId, careProfileId, permission: 'view', centerId: centerId || null,
      requireActiveCenter: true,
    });
    if (!['family_owner', 'family_caregiver', 'center_staff'].includes(access?.principalType)) {
      throw new LabDomainError('ACCESS_DENIED');
    }
    const offset = decodeCursor(cursor);
    const rows = await repository.listConfirmedObservationHistory({
      careProfileId, identityType: parsedIdentity.type, identityValue: parsedIdentity.value,
      limit: parsedLimit, offset,
    });
    const hasMore = rows.length > parsedLimit;
    const visible = rows.slice(0, parsedLimit);
    return Object.freeze({
      ...buildDeterministicTrend(visible, identity),
      nextCursor: hasMore ? encodeCursor(offset + parsedLimit) : null,
      hasMore,
    });
  };
}

module.exports = {
  NON_COMPARABLE_REASONS, SAFE_NON_COMPARABLE_MESSAGE, IDENTITY_TYPES,
  validateIdentity, buildDeterministicTrend, encodeCursor, decodeCursor,
  createLabTrendService,
};
