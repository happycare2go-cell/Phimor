const { randomUUID } = require('node:crypto');
const {
  CareProfiles, databaseQuery, withTransaction,
} = require('../db');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');

const HEALTH_FIELDS = Object.freeze([
  'gender', 'blood_type', 'height_cm', 'weight_kg', 'chronic_conditions',
  'drug_allergies', 'food_allergies', 'mobility_limitations',
  'emergency_contact_name', 'emergency_contact_phone', 'family_phone',
]);
const HEALTH_FIELD_SET = new Set(HEALTH_FIELDS);
const NUMERIC_FIELDS = new Set(['height_cm', 'weight_kg']);
const PHONE_FIELDS = new Set(['emergency_contact_phone', 'family_phone']);
const CENTER_REDACTED_FIELDS = Object.freeze([
  'emergency_contact_name', 'emergency_contact_phone', 'family_phone',
]);
const CENTER_REDACTED_SET = new Set(CENTER_REDACTED_FIELDS);
const SOURCE_ALLOWLIST = new Set(['family_liff', 'center_liff', 'api']);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const testHistoryRows = [];

class HealthHistoryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'HealthHistoryError';
    this.code = code;
    this.status = status;
  }
}

function invalid(code, message) {
  throw new HealthHistoryError(code, message, 400);
}

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return String(value).normalize('NFC').trim();
}

function normalizeNumber(value, field) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) invalid('INVALID_HEALTH_VALUE', `ค่า ${field} ไม่ถูกต้อง`);
  return number;
}

function normalizeConditions(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid('INVALID_HEALTH_VALUE', 'รูปแบบโรคประจำตัวไม่ถูกต้อง');
  return [...new Set(value.map(normalizeText).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th'));
}

function normalizeField(field, value) {
  if (NUMERIC_FIELDS.has(field)) return normalizeNumber(value, field);
  if (field === 'chronic_conditions') return normalizeConditions(value);
  // Phone values deliberately receive trim-only treatment. Other strings use
  // NFC plus outer trim; no inner whitespace or clinical wording is rewritten.
  if (PHONE_FIELDS.has(field)) return value === undefined || value === null ? '' : String(value).trim();
  return normalizeText(value);
}

function semanticallyEqual(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((value, index) => value === right[index]);
  }
  // Missing legacy string values and an empty LIFF input are the same state.
  if ((left === null || left === '') && (right === null || right === '')) return true;
  return Object.is(left, right);
}

function calculateHealthDiff(currentProfile, inputPatch) {
  const changedFields = [];
  const beforeValues = {};
  const afterValues = {};
  const updatePatch = {};
  for (const field of HEALTH_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(inputPatch, field)) continue;
    const before = normalizeField(field, currentProfile[field]);
    const after = normalizeField(field, inputPatch[field]);
    if (semanticallyEqual(before, after)) continue;
    changedFields.push(field);
    beforeValues[field] = before;
    afterValues[field] = after;
    updatePatch[field] = after;
  }
  return Object.freeze({ changedFields, beforeValues, afterValues, updatePatch });
}

function deriveActorType(access) {
  if (access?.principalType === 'family_owner') return 'family_owner';
  if (access?.principalType === 'family_caregiver') return 'family_caregiver';
  if (access?.principalType === 'center_staff' && access.role === 'owner') return 'center_owner';
  if (access?.principalType === 'center_staff' && access.role === 'manager') return 'center_manager';
  throw new HealthHistoryError('ACCESS_DENIED', 'ไม่มีสิทธิ์จัดการข้อมูลสุขภาพ', 403);
}

function assertSourceMatchesActor(source, actorType) {
  if (!SOURCE_ALLOWLIST.has(source)) invalid('INVALID_SOURCE', 'แหล่งที่มาของการแก้ไขไม่ถูกต้อง');
  if (source === 'family_liff' && !actorType.startsWith('family_')) invalid('INVALID_SOURCE', 'แหล่งที่มาไม่ตรงกับสิทธิ์ผู้ใช้งาน');
  if (source === 'center_liff' && !actorType.startsWith('center_')) invalid('INVALID_SOURCE', 'แหล่งที่มาไม่ตรงกับสิทธิ์ผู้ใช้งาน');
}

function validateIdentity(careProfileId, lineUserId) {
  if (!lineUserId || typeof lineUserId !== 'string') throw new HealthHistoryError('UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบใหม่อีกครั้ง', 401);
  if (!careProfileId || typeof careProfileId !== 'string' || !IDENTIFIER_PATTERN.test(careProfileId)) {
    invalid('INVALID_CARE_PROFILE_ID', 'รหัส Care Profile ไม่ถูกต้อง');
  }
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ t: new Date(row.changed_at).toISOString(), id: row.history_id })).toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const date = new Date(parsed.t);
    if (!IDENTIFIER_PATTERN.test(parsed.id) || Number.isNaN(date.getTime())) throw new Error('invalid');
    return { changedAt: date.toISOString(), historyId: parsed.id };
  } catch (_) {
    invalid('INVALID_CURSOR', 'cursor ไม่ถูกต้อง');
  }
}

async function defaultSelectProfileForUpdate(careProfileId, queryFn = databaseQuery) {
  if (process.env.NODE_ENV === 'test') {
    const profile = await CareProfiles.findOne((item) => item.care_profile_id === careProfileId);
    return profile ? { id: careProfileId, data: profile } : null;
  }
  const result = await queryFn(
    `SELECT id, data FROM "careProfiles"
     WHERE data->>'care_profile_id' = $1
     FOR UPDATE`,
    [careProfileId]
  );
  return result.rows[0] || null;
}

async function defaultMergeProfile(rowId, patch, queryFn = databaseQuery) {
  if (process.env.NODE_ENV === 'test') {
    return CareProfiles.update((item) => item.care_profile_id === rowId, patch);
  }
  const result = await queryFn(
    `UPDATE "careProfiles"
     SET data = data || $1::jsonb
     WHERE id = $2
     RETURNING data`,
    [JSON.stringify(patch), rowId]
  );
  return result.rows[0]?.data || null;
}

async function defaultInsertHistory(record, queryFn = databaseQuery) {
  if (process.env.NODE_ENV === 'test') {
    testHistoryRows.push(structuredClone(record));
    return record;
  }
  await queryFn(
    `INSERT INTO care_profile_health_history (
      history_id, care_profile_id, changed_at, changed_by_line_user_id,
      actor_type, source, changed_fields, before_values, after_values,
      schema_version, retention_until
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, 1, NULL)`,
    [
      record.history_id, record.care_profile_id, record.changed_at,
      record.changed_by_line_user_id, record.actor_type, record.source,
      record.changed_fields, JSON.stringify(record.before_values), JSON.stringify(record.after_values),
    ]
  );
  return record;
}

async function defaultListHistory({ careProfileId, cursor, field, visibleFields, limit }, queryFn = databaseQuery) {
  if (process.env.NODE_ENV === 'test') {
    return testHistoryRows
      .filter((row) => row.care_profile_id === careProfileId)
      .filter((row) => !field || row.changed_fields.includes(field))
      .filter((row) => row.changed_fields.some((item) => visibleFields.includes(item)))
      .filter((row) => !cursor || row.changed_at < cursor.changedAt
        || (row.changed_at === cursor.changedAt && row.history_id < cursor.historyId))
      .sort((a, b) => b.changed_at.localeCompare(a.changed_at) || b.history_id.localeCompare(a.history_id))
      .slice(0, limit + 1)
    .map((row) => structuredClone(row));
  }
  const params = [careProfileId];
  const where = ['care_profile_id = $1'];
  if (cursor) {
    params.push(cursor.changedAt, cursor.historyId);
    where.push(`(changed_at, history_id) < ($${params.length - 1}::timestamptz, $${params.length})`);
  }
  if (field) {
    params.push(field);
    where.push(`changed_fields @> ARRAY[$${params.length}]::text[]`);
  }
  params.push(visibleFields);
  where.push(`changed_fields && $${params.length}::text[]`);
  params.push(limit + 1);
  const result = await queryFn(
    `SELECT history_id, care_profile_id, changed_at, actor_type, source,
            changed_fields, before_values, after_values
     FROM care_profile_health_history
     WHERE ${where.join(' AND ')}
     ORDER BY changed_at DESC, history_id DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

function createCareProfileHealthHistoryService(overrides = {}) {
  const authorize = overrides.authorizeCareProfileAccess || authorizeCareProfileAccess;
  const transaction = overrides.withTransaction || withTransaction;
  const queryFn = overrides.queryFn || databaseQuery;
  const selectProfileForUpdate = overrides.selectProfileForUpdate
    || ((careProfileId) => defaultSelectProfileForUpdate(careProfileId, queryFn));
  const mergeProfile = overrides.mergeProfile || ((rowId, patch) => defaultMergeProfile(rowId, patch, queryFn));
  const insertHistory = overrides.insertHistory || ((record) => defaultInsertHistory(record, queryFn));
  const listHistory = overrides.listHistory || ((options) => defaultListHistory(options, queryFn));
  const nowFn = overrides.now || (() => new Date().toISOString());
  const historyId = overrides.historyId || (() => `CPHH-${randomUUID()}`);

  async function updateCareProfileHealth({
    careProfileId, lineUserId, patch, source, centerId = null,
  } = {}) {
    validateIdentity(careProfileId, lineUserId);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) invalid('INVALID_PATCH', 'ข้อมูลสุขภาพไม่ถูกต้อง');
    return transaction(`care-profile-health:${careProfileId}`, async () => {
      const access = await authorize({
        lineUserId, careProfileId, permission: 'edit_profile', centerId, requireActiveCenter: true,
      });
      const actorType = deriveActorType(access);
      assertSourceMatchesActor(source, actorType);
      const locked = await selectProfileForUpdate(careProfileId);
      if (!locked?.data) throw new HealthHistoryError('CARE_PROFILE_NOT_FOUND', 'ไม่พบข้อมูลหรือคุณไม่มีสิทธิ์เข้าถึง', 404);
      const diff = calculateHealthDiff(locked.data, patch);
      if (diff.changedFields.length === 0) return { changed: false, profile: locked.data };

      const changedAt = nowFn();
      const updated = await mergeProfile(locked.id, { ...diff.updatePatch, _updatedAt: changedAt });
      if (!updated) throw new HealthHistoryError('CARE_PROFILE_UPDATE_FAILED', 'บันทึกข้อมูลสุขภาพไม่สำเร็จ', 500);
      await insertHistory({
        history_id: historyId(), care_profile_id: careProfileId, changed_at: changedAt,
        changed_by_line_user_id: lineUserId, actor_type: actorType, source,
        changed_fields: diff.changedFields, before_values: diff.beforeValues,
        after_values: diff.afterValues, schema_version: 1, retention_until: null,
      });
      return { changed: true, profile: updated };
    });
  }

  async function getCareProfileHealthHistory({
    careProfileId, lineUserId, centerId = null, audience = 'family', limit = 20, cursor = null, field = null,
  } = {}) {
    validateIdentity(careProfileId, lineUserId);
    const parsedLimit = limit === undefined || limit === null || limit === '' ? 20 : Number(limit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) invalid('INVALID_LIMIT', 'limit ต้องอยู่ระหว่าง 1 ถึง 50');
    if (!['family', 'center'].includes(audience)) invalid('INVALID_AUDIENCE', 'ประเภทผู้เรียกไม่ถูกต้อง');
    if (field !== null && field !== undefined && field !== '' && !HEALTH_FIELD_SET.has(field)) invalid('INVALID_FIELD', 'field ไม่ถูกต้อง');
    if (audience === 'center' && CENTER_REDACTED_SET.has(field)) invalid('FIELD_NOT_AVAILABLE', 'field นี้ไม่เปิดให้ศูนย์ดูประวัติ', 400);

    const access = await authorize({
      lineUserId, careProfileId, permission: 'edit_profile', centerId, requireActiveCenter: true,
    });
    if (audience === 'family' && !['family_owner', 'family_caregiver'].includes(access.principalType)) {
      throw new HealthHistoryError('ACCESS_DENIED', 'ไม่มีสิทธิ์ดูประวัติสุขภาพ', 403);
    }
    if (audience === 'center' && (access.principalType !== 'center_staff' || !['owner', 'manager'].includes(access.role))) {
      throw new HealthHistoryError('ACCESS_DENIED', 'ไม่มีสิทธิ์ดูประวัติสุขภาพ', 403);
    }

    const visibleFields = audience === 'center'
      ? HEALTH_FIELDS.filter((item) => !CENTER_REDACTED_SET.has(item)) : [...HEALTH_FIELDS];
    const rows = await listHistory({
      careProfileId, cursor: decodeCursor(cursor), field: field || null,
      visibleFields, limit: parsedLimit,
    });
    const hasMore = rows.length > parsedLimit;
    const selected = rows.slice(0, parsedLimit);
    const items = selected.map((row) => {
      const fields = row.changed_fields.filter((item) => visibleFields.includes(item));
      return {
        historyId: row.history_id,
        changedAt: new Date(row.changed_at).toISOString(),
        actorType: row.actor_type,
        source: row.source,
        changes: fields.map((item) => ({
          field: item, before: row.before_values[item], after: row.after_values[item],
        })),
      };
    }).filter((item) => item.changes.length > 0);
    return {
      items,
      nextCursor: hasMore && selected.length ? encodeCursor(selected[selected.length - 1]) : null,
    };
  }

  return { updateCareProfileHealth, getCareProfileHealthHistory };
}

const defaultService = createCareProfileHealthHistoryService();

function resetHealthHistoryForTests() {
  if (process.env.NODE_ENV === 'test') testHistoryRows.splice(0, testHistoryRows.length);
}

module.exports = {
  HEALTH_FIELDS, CENTER_REDACTED_FIELDS, HealthHistoryError,
  normalizeField, calculateHealthDiff, deriveActorType, encodeCursor, decodeCursor,
  createCareProfileHealthHistoryService,
  updateCareProfileHealth: defaultService.updateCareProfileHealth,
  getCareProfileHealthHistory: defaultService.getCareProfileHealthHistory,
  resetHealthHistoryForTests,
};
