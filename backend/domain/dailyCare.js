const DAILY_REPORT_STATUSES = Object.freeze(['recorded', 'voided']);
const DAILY_SOURCE_TYPES = Object.freeze(['native_phimor', 'external_integration']);
const DAILY_ITEM_TYPES = Object.freeze([
  'shift', 'nutrition', 'fluid_intake', 'sleep_rest', 'bowel_movement',
  'urination', 'activity', 'mood_behavior', 'general_condition', 'symptom_note',
]);
const DAILY_ITEM_ALIASES = Object.freeze({
  fluid:'fluid_intake', sleep:'sleep_rest', bowel:'bowel_movement', mood:'mood_behavior',
});
const DAILY_VALUE_TYPES = Object.freeze(['text', 'numeric', 'boolean']);

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

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) {
    throw new DailyCareError('DAILY_ITEMS_REQUIRED', 'ต้องมีข้อมูลการดูแล 1–30 รายการ', 400);
  }
  return items.map(normalizeItem);
}

module.exports = {
  DAILY_REPORT_STATUSES, DAILY_SOURCE_TYPES, DAILY_ITEM_TYPES, DAILY_ITEM_ALIASES, DAILY_VALUE_TYPES,
  DailyCareError, requiredId, requiredTimestamp, optionalText, normalizeItem, normalizeItems,
};
