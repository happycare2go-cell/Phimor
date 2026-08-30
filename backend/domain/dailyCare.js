// `recorded` is retained only for rows created by the approved P0-P6 checkpoint.
// New native and integration writes use the explicit review/finalization states.
const DAILY_REPORT_STATUSES = Object.freeze([
  'recorded', 'submitted', 'changes_requested', 'finalized', 'voided',
]);
const DAILY_EVENT_TYPES = Object.freeze([
  'recorded', 'submitted', 'returned', 'finalized', 'correction_submitted', 'voided',
]);
const DAILY_SOURCE_TYPES = Object.freeze(['native_phimor', 'external_integration']);
const DAILY_ITEM_TYPES = Object.freeze([
  'shift', 'nutrition', 'fluid_intake', 'sleep_rest', 'bowel_movement',
  'urination', 'activity', 'mood_behavior', 'general_condition', 'symptom_note',
]);
const DAILY_ITEM_ALIASES = Object.freeze({
  fluid:'fluid_intake', sleep:'sleep_rest', bowel:'bowel_movement', mood:'mood_behavior',
});
const DAILY_VALUE_TYPES = Object.freeze(['text', 'numeric', 'boolean']);
const SHIFT_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

class DailyCareError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.name = 'DailyCareError'; this.code = code; this.status = status;
  }
}

function requiredId(value, label = 'identifier') {
  const clean = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(clean)) {
    throw new DailyCareError('INVALID_IDENTIFIER', `${label} ไม่ถูกต้อง`, 400);
  }
  return clean;
}

function requiredTimestamp(value, code = 'INVALID_OCCURRED_AT') {
  if (typeof value !== 'string' || !value.trim()) throw new DailyCareError(code, 'วันเวลาบันทึกไม่ถูกต้อง', 400);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new DailyCareError(code, 'วันเวลาบันทึกไม่ถูกต้อง', 400);
  return date.toISOString();
}

function optionalText(value, max = 1000) {
  if (value === undefined || value === null || value === '') return null;
  const clean = String(value).trim();
  if (!clean) return null;
  if (clean.length > max) throw new DailyCareError('VALUE_TOO_LONG', 'ข้อความยาวเกินกำหนด', 400);
  return clean;
}

function optionalCareDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const clean = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    throw new DailyCareError('INVALID_CARE_DATE', 'วันที่ดูแลไม่ถูกต้อง', 400);
  }
  const date = new Date(`${clean}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== clean) {
    throw new DailyCareError('INVALID_CARE_DATE', 'วันที่ดูแลไม่ถูกต้อง', 400);
  }
  return clean;
}

function normalizeShift(input) {
  if (input === undefined || input === null) return { code:null, sourceLabel:null };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DailyCareError('INVALID_SHIFT', 'ข้อมูลช่วงเวรไม่ถูกต้อง', 400);
  }
  const code = optionalText(input.code, 40);
  if (code && !SHIFT_CODE_PATTERN.test(code)) {
    throw new DailyCareError('INVALID_SHIFT_CODE', 'รหัสช่วงเวรไม่ถูกต้อง', 400);
  }
  return { code, sourceLabel:optionalText(input.sourceLabel ?? input.source_label, 120) };
}

function normalizeItem(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DailyCareError('INVALID_DAILY_ITEM', 'ข้อมูลการดูแลประจำวันไม่ถูกต้อง', 400);
  }
  const requestedType = String(input.itemType || input.item_type || '').trim();
  const itemType = DAILY_ITEM_ALIASES[requestedType] || requestedType;
  if (!DAILY_ITEM_TYPES.includes(itemType)) throw new DailyCareError('UNSUPPORTED_DAILY_ITEM', 'ไม่รองรับประเภทข้อมูลนี้', 400);
  const valueType = String(input.valueType || input.value_type || '').trim();
  if (!DAILY_VALUE_TYPES.includes(valueType)) throw new DailyCareError('INVALID_DAILY_VALUE_TYPE', 'รูปแบบค่าไม่ถูกต้อง', 400);
  let textValue = null; let numericValue = null; let booleanValue = null;
  if (valueType === 'text') {
    textValue = optionalText(input.textValue ?? input.value, 1000);
    if (!textValue) throw new DailyCareError('DAILY_TEXT_REQUIRED', 'กรุณาระบุข้อมูล', 400);
  } else if (valueType === 'numeric') {
    numericValue = Number(input.numericValue ?? input.value);
    if (!Number.isFinite(numericValue) || Math.abs(numericValue) > 1000000) {
      throw new DailyCareError('INVALID_DAILY_NUMERIC_VALUE', 'ค่าตัวเลขไม่ถูกต้อง', 400);
    }
  } else {
    const raw = input.booleanValue ?? input.value;
    if (typeof raw !== 'boolean') throw new DailyCareError('INVALID_DAILY_BOOLEAN_VALUE', 'ค่าใช่/ไม่ใช่ไม่ถูกต้อง', 400);
    booleanValue = raw;
  }
  const sourceUnit = optionalText(input.sourceUnit ?? input.unit, 40);
  if (valueType !== 'numeric' && sourceUnit) throw new DailyCareError('UNIT_NOT_ALLOWED', 'หน่วยใช้ได้กับค่าตัวเลขเท่านั้น', 400);
  return {
    sourceOrdinal:index + 1, itemType, valueType, textValue, numericValue,
    booleanValue, sourceUnit, sourceValueText:optionalText(input.sourceValueText, 1000),
  };
}

function normalizeItems(items, { allowEmpty = false } = {}) {
  if (!Array.isArray(items) || items.length > 30 || (!allowEmpty && items.length < 1)) {
    throw new DailyCareError('DAILY_ITEMS_REQUIRED', 'ต้องมีข้อมูลการดูแล 1–30 รายการ', 400);
  }
  return items.map(normalizeItem);
}

module.exports = {
  DAILY_REPORT_STATUSES, DAILY_EVENT_TYPES, DAILY_SOURCE_TYPES, DAILY_ITEM_TYPES,
  DAILY_ITEM_ALIASES, DAILY_VALUE_TYPES, SHIFT_CODE_PATTERN,
  DailyCareError, requiredId, requiredTimestamp, optionalText, optionalCareDate,
  normalizeShift, normalizeItem, normalizeItems,
};
