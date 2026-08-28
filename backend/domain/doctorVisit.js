const DOCTOR_VISIT_STATUSES = Object.freeze(['draft', 'confirmed', 'voided']);
const DOCTOR_VISIT_ITEM_KINDS = Object.freeze([
  'doctor_guidance', 'medication_statement', 'lab_follow_up', 'next_appointment',
  'test_or_monitoring', 'lifestyle_or_care_instruction', 'question_response', 'other',
]);
const DOCTOR_VISIT_EVENT_TYPES = Object.freeze([
  'draft_created', 'draft_updated', 'ai_organized', 'confirmed',
  'correction_draft_created', 'voided',
]);
const DOCTOR_VISIT_ACTOR_TYPES = Object.freeze([
  'family_owner', 'family_caregiver', 'center_staff', 'center_owner', 'center_manager',
]);
const DOCTOR_VISIT_CREATED_SOURCES = Object.freeze(['family_liff', 'center_liff', 'api']);

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RECORD_INPUT_FIELDS = new Set([
  'appointmentId', 'visitAt', 'hospitalName', 'department', 'doctorName',
  'sourceText', 'structuredSummary', 'items',
]);
const ITEM_INPUT_FIELDS = new Set([
  'sourceOrdinal', 'kind', 'sourceSupport', 'summary', 'dueAt', 'uncertainty',
]);

const ERROR_DEFINITIONS = Object.freeze({
  INVALID_INPUT: { status: 400, message: 'ข้อมูลบันทึกจากการพบแพทย์ไม่ถูกต้อง' },
  INVALID_IDENTIFIER: { status: 400, message: 'รหัสบันทึกจากการพบแพทย์ไม่ถูกต้อง' },
  UNSUPPORTED_FIELD: { status: 400, message: 'พบข้อมูลที่ระบบไม่รองรับ' },
  ACCESS_DENIED: { status: 403, message: 'ไม่พบข้อมูลหรือคุณไม่มีสิทธิ์เข้าถึง' },
  RECORD_NOT_FOUND: { status: 404, message: 'ไม่พบบันทึกหรือคุณไม่มีสิทธิ์เข้าถึง' },
  RECORD_NOT_DRAFT: { status: 409, message: 'บันทึกนี้ไม่อยู่ในสถานะรอตรวจสอบ' },
  RECORD_NOT_CONFIRMED: { status: 409, message: 'บันทึกนี้ยังไม่ได้รับการยืนยัน' },
  RECORD_ALREADY_VOIDED: { status: 409, message: 'บันทึกนี้ถูกยกเลิกแล้ว' },
  APPOINTMENT_NOT_FOUND: { status: 400, message: 'นัดหมายที่เชื่อมโยงไม่ถูกต้อง' },
  SOURCE_TEXT_REQUIRED: { status: 400, message: 'กรุณาบันทึกสิ่งที่ได้รับแจ้งจากการพบแพทย์' },
  ITEM_NOT_GROUNDED: { status: 400, message: 'รายการสรุปต้องตรวจสอบย้อนกลับไปยังข้อความต้นทางได้' },
  CORRECTION_REASON_REQUIRED: { status: 400, message: 'กรุณาระบุเหตุผลในการแก้ไข' },
  VOID_REASON_REQUIRED: { status: 400, message: 'กรุณาระบุเหตุผลในการยกเลิกบันทึก' },
  RECORD_PROVENANCE_AMBIGUOUS: { status: 409, message: 'ไม่สามารถยืนยันแหล่งอำนาจของบันทึกนี้ได้' },
  VERSION_CONFLICT: { status: 409, message: 'มีการสร้างฉบับแก้ไขพร้อมกัน กรุณาลองใหม่' },
});

class DoctorVisitDomainError extends Error {
  constructor(code, details = {}) {
    const definition = ERROR_DEFINITIONS[code] || ERROR_DEFINITIONS.INVALID_INPUT;
    super(definition.message);
    this.name = 'DoctorVisitDomainError';
    this.code = code;
    this.status = definition.status;
    Object.defineProperty(this, 'details', { value: details, enumerable: false });
  }
}

function fail(code, details) {
  throw new DoctorVisitDomainError(code, details);
}

function assertPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
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
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) fail('INVALID_INPUT');
  return parsed.toISOString();
}

function normalizePositiveInteger(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail('INVALID_INPUT');
  return parsed;
}

function normalizeGuidanceItem(input, index = 0) {
  assertAllowedFields(input, ITEM_INPUT_FIELDS);
  const kind = normalizeText(input.kind, { required: true, nullable: false, max: 48 });
  if (!DOCTOR_VISIT_ITEM_KINDS.includes(kind)) fail('INVALID_INPUT');
  return Object.freeze({
    sourceOrdinal: normalizePositiveInteger(input.sourceOrdinal, index + 1),
    kind,
    sourceSupport: normalizeText(input.sourceSupport, { required: true, nullable: false, max: 4000 }),
    summary: normalizeText(input.summary, { required: true, nullable: false, max: 2000 }),
    dueAt: normalizeTimestamp(input.dueAt),
    uncertainty: normalizeText(input.uncertainty, { max: 1000 }),
  });
}

function normalizeGuidanceItems(value) {
  if (!Array.isArray(value) || value.length > 50) fail('INVALID_INPUT');
  const items = value.map(normalizeGuidanceItem);
  const ordinals = new Set(items.map((item) => item.sourceOrdinal));
  if (ordinals.size !== items.length) fail('INVALID_INPUT');
  return items.sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
}

function validateItemsAgainstSource(items, sourceText) {
  const source = normalizeText(sourceText, { nullable: false, max: 12000 });
  for (const item of items) {
    if (!source || !source.includes(item.sourceSupport)) {
      fail('ITEM_NOT_GROUNDED', { sourceOrdinal: item.sourceOrdinal });
    }
  }
  return items;
}

function normalizeVisitInput(input, { partial = false } = {}) {
  assertAllowedFields(input, RECORD_INPUT_FIELDS);
  const result = {};
  const assign = (field, normalizer) => {
    if (!partial || Object.prototype.hasOwnProperty.call(input, field)) result[field] = normalizer(input[field]);
  };
  assign('appointmentId', (value) => normalizeIdentifier(value, { nullable: true }));
  assign('visitAt', normalizeTimestamp);
  assign('hospitalName', (value) => normalizeText(value, { max: 500 }));
  assign('department', (value) => normalizeText(value, { max: 500 }));
  assign('doctorName', (value) => normalizeText(value, { max: 500 }));
  assign('sourceText', (value) => normalizeText(value, { nullable: false, max: 12000 }));
  assign('structuredSummary', (value) => normalizeText(value, { max: 4000 }));
  if (Object.prototype.hasOwnProperty.call(input, 'items')) result.items = normalizeGuidanceItems(input.items);
  else if (!partial) result.items = [];
  return result;
}

function deriveDoctorVisitActor(access) {
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

function requireConfirmableRecord(record, items) {
  if (!record || record.status !== 'draft') fail('RECORD_NOT_DRAFT');
  if (!String(record.source_text || '').trim()) fail('SOURCE_TEXT_REQUIRED');
  validateItemsAgainstSource(normalizeGuidanceItems(items.map((item) => ({
    sourceOrdinal: item.sourceOrdinal ?? item.source_ordinal,
    kind: item.kind,
    sourceSupport: item.sourceSupport ?? item.source_support,
    summary: item.summary ?? item.normalized_summary,
    dueAt: item.dueAt ?? item.due_at,
    uncertainty: item.uncertainty,
  }))), record.source_text);
}

function sanitizeEventMetadata(metadata = {}) {
  assertPlainObject(metadata);
  const allowed = new Set([
    'reasonCode', 'changedFields', 'versionNo', 'previousVersionNo',
    'supersedesVisitRecordId', 'itemCount',
  ]);
  const safe = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!allowed.has(key)) continue;
    if (key === 'changedFields' && Array.isArray(value)) {
      safe[key] = value.filter((item) => typeof item === 'string').slice(0, 20);
    } else if (typeof value === 'string' || Number.isSafeInteger(value)) safe[key] = value;
  }
  return safe;
}

module.exports = {
  DOCTOR_VISIT_STATUSES, DOCTOR_VISIT_ITEM_KINDS, DOCTOR_VISIT_EVENT_TYPES,
  DOCTOR_VISIT_ACTOR_TYPES, DOCTOR_VISIT_CREATED_SOURCES, IDENTIFIER_PATTERN,
  DoctorVisitDomainError, fail, normalizeIdentifier, normalizeText, normalizeTimestamp,
  normalizeGuidanceItem, normalizeGuidanceItems, validateItemsAgainstSource,
  normalizeVisitInput, deriveDoctorVisitActor, canEditDraft, canConfirm,
  requireDraftEdit, requireConfirmation, requireConfirmableRecord, sanitizeEventMetadata,
};
