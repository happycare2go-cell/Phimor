const crypto = require('node:crypto');
const { INTEGRATION_EVENT_TYPES } = require('./platform');

class IntegrationEventError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.name = 'IntegrationEventError'; this.code = code; this.status = status;
  }
}

function exactKeys(object, allowed, code) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    throw new IntegrationEventError(code, 'รูปแบบ event ไม่ถูกต้อง', 400);
  }
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new IntegrationEventError(code, `ไม่รองรับ field ${key}`, 400);
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function aliased(object, camel, snake) {
  const camelPresent = Object.prototype.hasOwnProperty.call(object, camel);
  const snakePresent = Object.prototype.hasOwnProperty.call(object, snake);
  if (camelPresent && snakePresent && stableStringify(object[camel]) !== stableStringify(object[snake])) {
    throw new IntegrationEventError('CONFLICTING_EVENT_FIELDS', `ข้อมูล ${camel} ซ้ำกันและไม่ตรงกัน`, 400);
  }
  return camelPresent ? object[camel] : object[snake];
}

function aliasedMany(object, keys, label) {
  const present = keys.filter((key) => Object.prototype.hasOwnProperty.call(object, key));
  if (present.length > 1) {
    const first = stableStringify(object[present[0]]);
    if (present.some((key) => stableStringify(object[key]) !== first)) {
      throw new IntegrationEventError('CONFLICTING_EVENT_FIELDS', `ข้อมูล ${label} ซ้ำกันและไม่ตรงกัน`, 400);
    }
  }
  return present.length ? object[present[0]] : undefined;
}

function normalizeObservation(input) {
  exactKeys(input, [
    'measurementType','measurement_type','type','numericValue','numeric_value','value',
    'sourceUnit','source_unit','unit','sourceValueText','source_value_text',
    'context','measurementContext','measurement_context',
  ], 'INVALID_EVENT_OBSERVATION');
  const measurementType = aliasedMany(input, ['measurementType','measurement_type','type'], 'measurement type');
  const numericValue = aliasedMany(input, ['numericValue','numeric_value','value'], 'measurement value');
  const sourceUnit = aliasedMany(input, ['sourceUnit','source_unit','unit'], 'measurement unit');
  if (measurementType === undefined || numericValue === undefined || numericValue === null
    || numericValue === '' || sourceUnit === undefined) {
    throw new IntegrationEventError('INVALID_EVENT_OBSERVATION', 'ข้อมูล observation ไม่ครบถ้วน', 400);
  }
  const normalized = { measurementType, numericValue, sourceUnit };
  const sourceValueText = aliasedMany(input, ['sourceValueText','source_value_text'], 'source value text');
  const context = aliasedMany(input, ['context','measurementContext','measurement_context'], 'measurement context');
  if (sourceValueText !== undefined) normalized.sourceValueText = sourceValueText;
  if (context !== undefined) normalized.context = context;
  return normalized;
}

function normalizeCareItem(input) {
  exactKeys(input, [
    'itemType','item_type','valueType','value_type','value','textValue','text_value',
    'numericValue','numeric_value','booleanValue','boolean_value','sourceUnit','source_unit','unit',
    'sourceValueText','source_value_text',
  ], 'INVALID_EVENT_DAILY_ITEM');
  const itemType = aliasedMany(input, ['itemType','item_type'], 'care item type');
  const valueType = aliasedMany(input, ['valueType','value_type'], 'care item value type');
  const value = aliasedMany(input, ['value','textValue','text_value','numericValue','numeric_value','booleanValue','boolean_value'], 'care item value');
  if (itemType === undefined || valueType === undefined || value === undefined || value === null) {
    throw new IntegrationEventError('INVALID_EVENT_DAILY_ITEM', 'ข้อมูล care item ไม่ครบถ้วน', 400);
  }
  const normalized = { itemType, valueType, value };
  const sourceUnit = aliasedMany(input, ['sourceUnit','source_unit','unit'], 'care item unit');
  const sourceValueText = aliasedMany(input, ['sourceValueText','source_value_text'], 'care item source value');
  if (sourceUnit !== undefined) normalized.sourceUnit = sourceUnit;
  if (sourceValueText !== undefined) normalized.sourceValueText = sourceValueText;
  return normalized;
}

function requiredId(value, label = 'identifier', code = 'INVALID_EVENT_IDENTIFIER') {
  const clean = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(clean)) {
    throw new IntegrationEventError(code, `${label} ไม่ถูกต้อง`, 400);
  }
  return clean;
}

function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new IntegrationEventError('INVALID_EVENT_TIME', 'วันเวลา event ไม่ถูกต้อง', 400);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new IntegrationEventError('INVALID_EVENT_TIME', 'วันเวลา event ไม่ถูกต้อง', 400);
  return date.toISOString();
}

function text(value, max) {
  if (value === undefined || value === null || value === '') return null;
  const clean = String(value).trim();
  if (!clean) return null;
  if (clean.length > max) throw new IntegrationEventError('EVENT_VALUE_TOO_LONG', 'ข้อมูล event ยาวเกินกำหนด', 400);
  return clean;
}

function staffProjection(input, code, { required = false } = {}) {
  if (input === undefined || input === null) {
    if (required) throw new IntegrationEventError(code, 'ไม่พบผู้ยืนยันข้อมูล', 400);
    return null;
  }
  if (typeof input === 'string') {
    const externalStaffId = input.trim();
    if (!externalStaffId || externalStaffId.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(externalStaffId)) {
      throw new IntegrationEventError(code, 'ข้อมูลผู้บันทึกหรือผู้ยืนยันไม่ถูกต้อง', 400);
    }
    return { externalStaffId, displayName:null };
  }
  exactKeys(input, ['externalStaffId', 'external_staff_id', 'displayName', 'display_name'], code);
  const result = {
    externalStaffId:text(aliased(input, 'externalStaffId', 'external_staff_id'), 160),
    displayName:text(aliased(input, 'displayName', 'display_name'), 160),
  };
  if (!result.externalStaffId && !result.displayName) {
    if (required) throw new IntegrationEventError(code, 'ไม่พบผู้ยืนยันข้อมูล', 400);
    return null;
  }
  return result;
}

function normalizeSubject(input) {
  exactKeys(input, [
    'externalCenterId', 'external_center_id', 'center_external_id',
    'externalResidentId', 'external_resident_id', 'resident_external_id',
    'expectedLineGroupId', 'expected_line_group_id', 'firstName', 'first_name',
    'lastName', 'last_name', 'displayName', 'display_name', 'room', 'display',
  ], 'INVALID_EVENT_SUBJECT');
  let display = {};
  if (input.display !== undefined && input.display !== null) {
    exactKeys(input.display, ['firstName', 'first_name', 'lastName', 'last_name', 'displayName', 'display_name', 'room'], 'INVALID_EVENT_SUBJECT_DISPLAY');
    display = input.display;
  }
  const pickDisplay = (camel, snake) => aliased(input, camel, snake) ?? aliased(display, camel, snake);
  return {
    externalCenterId:requiredId(aliasedMany(input, ['externalCenterId','external_center_id','center_external_id'], 'external Center ID'), 'External Center ID'),
    externalResidentId:requiredId(aliasedMany(input, ['externalResidentId','external_resident_id','resident_external_id'], 'external Resident ID'), 'External Resident ID'),
    expectedLineGroupId:text(aliased(input, 'expectedLineGroupId', 'expected_line_group_id'), 255),
    firstName:text(pickDisplay('firstName', 'first_name'), 120),
    lastName:text(pickDisplay('lastName', 'last_name'), 120),
    displayName:text(pickDisplay('displayName', 'display_name'), 240),
    room:text(input.room ?? display.room, 80),
  };
}

function normalizeFinalizedDailyData(input) {
  exactKeys(input, [
    'externalRecordId', 'external_record_id', 'careDate', 'care_date', 'shift',
    'observations', 'careItems', 'care_items', 'recordedBy', 'recorded_by',
    'finalizedBy', 'finalized_by', 'recordedAt', 'recorded_at',
    'finalizedAt', 'finalized_at',
  ], 'INVALID_EVENT_DATA');
  const externalRecordId = requiredId(aliased(input, 'externalRecordId', 'external_record_id'), 'External record ID', 'INVALID_EXTERNAL_RECORD_ID');
  const careDate = String(aliased(input, 'careDate', 'care_date') || '').trim();
  const careDateValue = new Date(`${careDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(careDate)
    || !Number.isFinite(careDateValue.getTime()) || careDateValue.toISOString().slice(0, 10) !== careDate) {
    throw new IntegrationEventError('INVALID_CARE_DATE', 'วันที่ดูแลไม่ถูกต้อง', 400);
  }
  let shift = null;
  if (input.shift !== undefined && input.shift !== null) {
    exactKeys(input.shift, ['code', 'sourceLabel', 'source_label'], 'INVALID_EVENT_SHIFT');
    const code = text(input.shift.code, 40);
    if (code && !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(code)) {
      throw new IntegrationEventError('INVALID_SHIFT_CODE', 'รหัสช่วงเวรไม่ถูกต้อง', 400);
    }
    shift = { code, sourceLabel:text(aliased(input.shift, 'sourceLabel', 'source_label'), 120) };
  }
  const observations = input.observations === undefined ? [] : input.observations;
  const careItems = aliased(input, 'careItems', 'care_items');
  if (!Array.isArray(observations)) throw new IntegrationEventError('EVENT_OBSERVATIONS_REQUIRED', 'observations ต้องเป็นรายการ', 400);
  if (!Array.isArray(careItems)) throw new IntegrationEventError('EVENT_DAILY_ITEMS_REQUIRED', 'ต้องมี careItems', 400);
  const recordedAt = timestamp(aliased(input, 'recordedAt', 'recorded_at'));
  const finalizedAt = timestamp(aliased(input, 'finalizedAt', 'finalized_at'));
  if (new Date(finalizedAt) < new Date(recordedAt)) {
    throw new IntegrationEventError('FINALIZED_BEFORE_RECORDED', 'เวลายืนยันต้องไม่ก่อนเวลาบันทึก', 400);
  }
  return {
    externalRecordId, careDate, shift,
    observations:observations.map(normalizeObservation),
    careItems:careItems.map(normalizeCareItem),
    recordedBy:staffProjection(aliased(input, 'recordedBy', 'recorded_by'), 'INVALID_EVENT_RECORDER'),
    finalizedBy:staffProjection(aliased(input, 'finalizedBy', 'finalized_by'), 'INVALID_EVENT_FINALIZER', { required:true }),
    recordedAt, finalizedAt,
  };
}

function normalizeEnvelope(input) {
  exactKeys(input, [
    'schemaVersion', 'schema_version', 'eventId', 'event_id', 'eventType', 'event_type',
    'occurredAt', 'occurred_at', 'subject', 'recorder', 'data',
  ], 'INVALID_EVENT_ENVELOPE');
  if (aliased(input, 'schemaVersion', 'schema_version') !== '1.0') {
    throw new IntegrationEventError('UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion ไม่รองรับ', 400);
  }
  const eventId = requiredId(aliased(input, 'eventId', 'event_id'), 'Event ID');
  const eventType = String(aliased(input, 'eventType', 'event_type') || '').trim();
  if (!INTEGRATION_EVENT_TYPES.includes(eventType)) {
    throw new IntegrationEventError('UNSUPPORTED_EVENT_TYPE', 'eventType ไม่รองรับ', 400);
  }
  const subject = normalizeSubject(input.subject);
  const occurredAt = timestamp(aliased(input, 'occurredAt', 'occurred_at'));
  let recorder = null;
  let data;
  if (eventType === 'care.vitals.recorded') {
    recorder = staffProjection(input.recorder, 'INVALID_EVENT_RECORDER');
    exactKeys(input.data, ['externalRecordId', 'external_record_id', 'observations'], 'INVALID_EVENT_DATA');
    if (!Array.isArray(input.data.observations)) {
      throw new IntegrationEventError('EVENT_OBSERVATIONS_REQUIRED', 'ต้องมี observations', 400);
    }
    data = {
      externalRecordId:aliased(input.data, 'externalRecordId', 'external_record_id')
        ? requiredId(aliased(input.data, 'externalRecordId', 'external_record_id'), 'External record ID', 'INVALID_EXTERNAL_RECORD_ID') : eventId,
      observations:input.data.observations.map(normalizeObservation),
    };
  } else {
    if (input.recorder !== undefined && input.recorder !== null) {
      throw new IntegrationEventError('FINALIZED_RECORDER_MUST_BE_IN_DATA', 'ข้อมูลผู้บันทึก final report ต้องอยู่ใน data.recordedBy', 400);
    }
    data = normalizeFinalizedDailyData(input.data);
  }
  const envelope = { schemaVersion:'1.0', eventId, eventType, occurredAt, subject, recorder, data };
  const serialized = stableStringify(envelope);
  if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) {
    throw new IntegrationEventError('EVENT_TOO_LARGE', 'event มีขนาดใหญ่เกินกำหนด', 413);
  }
  return {
    envelope, serialized,
    payloadSha256:crypto.createHash('sha256').update(serialized).digest('hex'),
  };
}

module.exports = { IntegrationEventError, normalizeEnvelope, stableStringify };
