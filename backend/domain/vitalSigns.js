const VITAL_SET_STATUSES = Object.freeze(['recorded', 'voided']);
const VITAL_SOURCE_TYPES = Object.freeze(['native_phimor', 'external_integration']);
const VITAL_MEASUREMENT_TYPES = Object.freeze([
  'temperature',
  'blood_pressure_systolic',
  'blood_pressure_diastolic',
  'pulse',
  'spo2',
  'respiratory_rate',
  'blood_glucose',
  'weight',
]);

const BLOOD_GLUCOSE_CONTEXTS = Object.freeze([
  'fasting',
  'before_meal',
  'after_meal',
  'random',
  'unspecified',
]);

const UNIT_RULES = Object.freeze({
  temperature: Object.freeze({ canonical:'Cel', accepted:Object.freeze(['Cel', '°C', 'C']) }),
  blood_pressure_systolic: Object.freeze({ canonical:'mm[Hg]', accepted:Object.freeze(['mm[Hg]', 'mmHg']) }),
  blood_pressure_diastolic: Object.freeze({ canonical:'mm[Hg]', accepted:Object.freeze(['mm[Hg]', 'mmHg']) }),
  pulse: Object.freeze({ canonical:'/min', accepted:Object.freeze(['/min', 'bpm']) }),
  spo2: Object.freeze({ canonical:'%', accepted:Object.freeze(['%']) }),
  respiratory_rate: Object.freeze({ canonical:'/min', accepted:Object.freeze(['/min', 'breaths/min']) }),
  blood_glucose: Object.freeze({
    canonicalBySource:Object.freeze({ 'mg/dL':'mg/dL', 'mmol/L':'mmol/L' }),
    accepted:Object.freeze(['mg/dL', 'mmol/L']),
  }),
  weight: Object.freeze({ canonical:'kg', accepted:Object.freeze(['kg']) }),
});

class VitalSignsError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'VitalSignsError';
    this.code = code;
    this.status = status;
  }
}

function requiredId(value, label = 'identifier') {
  const clean = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(clean)) {
    throw new VitalSignsError('INVALID_IDENTIFIER', `${label} ไม่ถูกต้อง`, 400);
  }
  return clean;
}

function requiredTimestamp(value, code = 'INVALID_OCCURRED_AT') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new VitalSignsError(code, 'วันเวลาบันทึกไม่ถูกต้อง', 400);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new VitalSignsError(code, 'วันเวลาบันทึกไม่ถูกต้อง', 400);
  return timestamp.toISOString();
}

function optionalText(value, max = 200) {
  if (value === undefined || value === null || value === '') return null;
  const clean = String(value).trim();
  if (!clean) return null;
  if (clean.length > max) throw new VitalSignsError('VALUE_TOO_LONG', 'ข้อความยาวเกินกำหนด', 400);
  return clean;
}

function normalizeObservation(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new VitalSignsError('INVALID_OBSERVATION', 'ข้อมูลสัญญาณชีพไม่ถูกต้อง', 400);
  }
  const type = String(input.measurementType || input.measurement_type || '').trim();
  if (!VITAL_MEASUREMENT_TYPES.includes(type)) {
    throw new VitalSignsError('UNSUPPORTED_MEASUREMENT', 'ไม่รองรับประเภทสัญญาณชีพนี้', 400);
  }
  const numeric = Number(input.numericValue ?? input.value);
  if (!Number.isFinite(numeric) || Math.abs(numeric) > 1000000) {
    throw new VitalSignsError('INVALID_NUMERIC_VALUE', 'ค่าสัญญาณชีพต้องเป็นตัวเลขที่ถูกต้อง', 400);
  }
  const sourceUnit = optionalText(input.sourceUnit ?? input.unit, 32);
  const rule = UNIT_RULES[type];
  if (!sourceUnit || !rule.accepted.includes(sourceUnit)) {
    throw new VitalSignsError('UNSUPPORTED_UNIT', `หน่วยของ ${type} ไม่รองรับ`, 400);
  }
  const suppliedContext = optionalText(input.context ?? input.measurementContext ?? input.measurement_context, 32);
  let measurementContext = null;
  if (type === 'blood_glucose') {
    measurementContext = suppliedContext || 'unspecified';
    if (!BLOOD_GLUCOSE_CONTEXTS.includes(measurementContext)) {
      throw new VitalSignsError('INVALID_GLUCOSE_CONTEXT', 'บริบทการตรวจน้ำตาลในเลือดไม่รองรับ', 400);
    }
  } else if (suppliedContext) {
    throw new VitalSignsError('MEASUREMENT_CONTEXT_NOT_ALLOWED', `ไม่รองรับบริบทสำหรับ ${type}`, 400);
  }
  return {
    sourceOrdinal: index + 1,
    measurementType: type,
    sourceValueText: optionalText(input.sourceValueText, 80) || String(input.numericValue ?? input.value),
    numericValue: numeric,
    sourceUnit,
    canonicalUnit: rule.canonicalBySource?.[sourceUnit] || rule.canonical,
    measurementContext,
  };
}

function normalizeObservations(observations) {
  if (!Array.isArray(observations) || observations.length < 1 || observations.length > VITAL_MEASUREMENT_TYPES.length) {
    throw new VitalSignsError('OBSERVATIONS_REQUIRED', 'ต้องมีสัญญาณชีพอย่างน้อยหนึ่งรายการ', 400);
  }
  const normalized = observations.map(normalizeObservation);
  if (new Set(normalized.map((item) => item.measurementType)).size !== normalized.length) {
    throw new VitalSignsError('DUPLICATE_MEASUREMENT', 'สัญญาณชีพประเภทเดียวกันซ้ำในชุดเดียวกัน', 400);
  }
  return normalized;
}

module.exports = {
  VITAL_SET_STATUSES,
  VITAL_SOURCE_TYPES,
  VITAL_MEASUREMENT_TYPES,
  BLOOD_GLUCOSE_CONTEXTS,
  UNIT_RULES,
  VitalSignsError,
  requiredId,
  requiredTimestamp,
  optionalText,
  normalizeObservation,
  normalizeObservations,
};
