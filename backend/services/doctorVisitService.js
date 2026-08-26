const { Appointments, id, withTransaction } = require('../db');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { createDoctorVisitRepository } = require('./doctorVisitRepository');
const {
  IDENTIFIER_PATTERN, DoctorVisitDomainError, fail, normalizeText,
  normalizeVisitInput, normalizeGuidanceItems, validateItemsAgainstSource,
  deriveDoctorVisitActor, canEditDraft, requireDraftEdit, requireConfirmation,
  requireConfirmableRecord, sanitizeEventMetadata,
} = require('../domain/doctorVisit');

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rowItemToInput(row) {
  return {
    sourceOrdinal: row.source_ordinal,
    kind: row.kind,
    sourceSupport: row.source_support,
    summary: row.normalized_summary,
    dueAt: row.due_at,
    uncertainty: row.uncertainty,
  };
}

function projectItem(row) {
  return Object.freeze({
    sourceOrdinal: Number(row.source_ordinal),
    kind: row.kind,
    sourceSupport: row.source_support,
    summary: row.normalized_summary,
    dueAt: toIso(row.due_at),
    uncertainty: row.uncertainty,
  });
}

function projectEvent(row) {
  return Object.freeze({
    eventId: row.event_id,
    eventType: row.event_type,
    actorType: row.actor_type,
    source: row.source,
    metadata: row.metadata || {},
    occurredAt: toIso(row.occurred_at),
  });
}

function deriveFollowUpSuggestions(items) {
  const kinds = new Set((items || []).map((item) => item.kind));
  const suggestions = [];
  if (kinds.has('medication_statement')) {
    suggestions.push(Object.freeze({
      code: 'REVIEW_MEDICATIONS', label: 'ทบทวนรายการยา', target: 'medications',
    }));
  }
  if (kinds.has('next_appointment')) {
    suggestions.push(Object.freeze({
      code: 'REVIEW_NEXT_APPOINTMENT', label: 'ตรวจสอบนัดหมายครั้งถัดไป', target: 'appointments',
    }));
  }
  if (kinds.has('lab_follow_up') || kinds.has('test_or_monitoring')) {
    suggestions.push(Object.freeze({
      code: 'REVIEW_LAB_FOLLOW_UP', label: 'ติดตามผลตรวจ/การตรวจครั้งถัดไป', target: 'labs',
    }));
  }
  return Object.freeze(suggestions);
}

function projectRecord(row, { items = null, events = null, includeSourceText = true } = {}) {
  const projected = {
    visitRecordId: row.visit_record_id,
    recordGroupId: row.record_group_id,
    versionNo: Number(row.version_no),
    appointmentId: row.appointment_id,
    status: row.status,
    visitAt: toIso(row.visit_at),
    hospitalName: row.hospital_name,
    department: row.department,
    doctorName: row.doctor_name,
    structuredSummary: row.structured_summary,
    supersedesVisitRecordId: row.supersedes_visit_record_id,
    correctionReason: row.correction_reason,
    createdByActorType: row.created_by_actor_type,
    createdSource: row.created_source,
    confirmedByActorType: row.confirmed_by_actor_type,
    confirmedAt: toIso(row.confirmed_at),
    voidedAt: toIso(row.voided_at),
    voidReason: row.void_reason,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
  if (includeSourceText) projected.sourceText = row.source_text;
  if (items) {
    projected.items = items.map(projectItem);
    projected.followUpSuggestions = row.status === 'confirmed'
      ? deriveFollowUpSuggestions(projected.items) : Object.freeze([]);
  }
  if (events) projected.events = events.map(projectEvent);
  return Object.freeze(projected);
}

function encodeCursor(row) {
  const sortTime = row.sort_time || row.visit_at || row.created_at;
  return Buffer.from(JSON.stringify({ t: toIso(sortTime), id: row.visit_record_id })).toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const timestamp = toIso(decoded.t);
    if (!timestamp || !IDENTIFIER_PATTERN.test(decoded.id)) throw new Error('invalid');
    return { sortTime: timestamp, visitRecordId: decoded.id };
  } catch (_) {
    fail('INVALID_INPUT');
  }
}

function validateIdentity({ careProfileId, visitRecordId = null, lineUserId }) {
  if (!IDENTIFIER_PATTERN.test(String(careProfileId || ''))
    || (visitRecordId !== null && !IDENTIFIER_PATTERN.test(String(visitRecordId || '')))) {
    throw new DoctorVisitDomainError('INVALID_IDENTIFIER');
  }
  if (typeof lineUserId !== 'string' || !lineUserId || lineUserId.length > 128) {
    throw new DoctorVisitDomainError('ACCESS_DENIED');
  }
}

function assertSupportedPrincipal(access) {
  if (!['family_owner', 'family_caregiver', 'center_staff'].includes(access?.principalType)) {
    fail('ACCESS_DENIED');
  }
}

function rowMetadata(row) {
  return {
    appointmentId: row.appointment_id,
    visitAt: row.visit_at,
    hospitalName: row.hospital_name,
    department: row.department,
    doctorName: row.doctor_name,
    sourceText: row.source_text,
    structuredSummary: row.structured_summary,
  };
}

function changedValue(left, right, timestamp = false) {
  return timestamp ? toIso(left) !== toIso(right) : left !== right;
}

function createDoctorVisitService(overrides = {}) {
  const repository = overrides.repository || createDoctorVisitRepository(overrides.repositoryOptions);
  const authorize = overrides.authorizeCareProfileAccess || authorizeCareProfileAccess;
  const transaction = overrides.withTransaction || withTransaction;
  const idFactory = overrides.idFactory || id;
  const findAppointment = overrides.findAppointment || (async ({ appointmentId, careProfileId }) => (
    Appointments.findOne((item) => item.appointment_id === appointmentId
      && item.care_profile_id === careProfileId && item.status !== 'cancelled')
  ));

  async function getAccess({ careProfileId, lineUserId, centerId }) {
    const access = await authorize({
      lineUserId, careProfileId, permission: 'view', centerId: centerId || null,
      requireActiveCenter: true,
    });
    assertSupportedPrincipal(access);
    return access;
  }

  async function validateAppointment(careProfileId, appointmentId) {
    if (appointmentId && !await findAppointment({ appointmentId, careProfileId })) {
      fail('APPOINTMENT_NOT_FOUND');
    }
  }

  async function loadDetail(row) {
    const [items, events] = await Promise.all([
      repository.listItems(row.visit_record_id),
      repository.listEvents(row.visit_record_id),
    ]);
    return projectRecord(row, { items, events });
  }

  async function createDraft({ careProfileId, lineUserId, centerId = null, input = {} } = {}) {
    validateIdentity({ careProfileId, lineUserId });
    const normalized = normalizeVisitInput(input || {});
    validateItemsAgainstSource(normalized.items, normalized.sourceText);
    const initialAccess = await getAccess({ careProfileId, lineUserId, centerId });
    requireDraftEdit(initialAccess);
    const visitRecordId = idFactory('DVR');
    const recordGroupId = idFactory('DVG');
    return transaction(`doctor-visit:${visitRecordId}`, async () => {
      const access = await getAccess({ careProfileId, lineUserId, centerId });
      requireDraftEdit(access);
      await validateAppointment(careProfileId, normalized.appointmentId);
      const actor = { ...deriveDoctorVisitActor(access), actorId: lineUserId };
      const record = await repository.createRecord({
        visit_record_id: visitRecordId, record_group_id: recordGroupId, version_no: 1,
        care_profile_id: careProfileId, appointment_id: normalized.appointmentId,
        visit_at: normalized.visitAt, hospital_name: normalized.hospitalName,
        department: normalized.department, doctor_name: normalized.doctorName,
        source_text: normalized.sourceText, structured_summary: normalized.structuredSummary,
        supersedes_visit_record_id: null, correction_reason: null,
        created_by_actor_type: actor.actorType, created_by_actor_id: actor.actorId,
        created_source: actor.source,
      });
      const items = await repository.insertItems(
        visitRecordId, normalized.items, () => idFactory('DVI')
      );
      const event = await repository.insertEvent({
        event_id: idFactory('DVE'), visit_record_id: visitRecordId,
        event_type: 'draft_created', actor_type: actor.actorType, actor_id: actor.actorId,
        source: actor.source, idempotency_key: `doctor-visit:draft-created:${visitRecordId}`,
        metadata: sanitizeEventMetadata({ versionNo: 1, itemCount: items.length }),
      });
      return projectRecord(record, { items, events: event ? [event] : [] });
    });
  }

  async function updateDraftInternal({
    careProfileId, visitRecordId, lineUserId, centerId = null, patch = {}, aiOrganized = false,
  } = {}) {
    validateIdentity({ careProfileId, visitRecordId, lineUserId });
    const normalized = normalizeVisitInput(patch || {}, { partial: true });
    if (Object.keys(normalized).length === 0) fail('INVALID_INPUT');
    const initialAccess = await getAccess({ careProfileId, lineUserId, centerId });
    requireDraftEdit(initialAccess);
    return transaction(`doctor-visit:${visitRecordId}`, async () => {
      const access = await getAccess({ careProfileId, lineUserId, centerId });
      requireDraftEdit(access);
      const actor = { ...deriveDoctorVisitActor(access), actorId: lineUserId };
      const current = await repository.findRecordForUpdate(visitRecordId);
      if (!current || current.care_profile_id !== careProfileId) fail('RECORD_NOT_FOUND');
      if (current.status !== 'draft') fail('RECORD_NOT_DRAFT');
      const currentItems = await repository.listItems(visitRecordId);
      const currentMetadata = rowMetadata(current);
      const merged = { ...currentMetadata, ...normalized };
      const mergedItems = normalized.items || normalizeGuidanceItems(currentItems.map(rowItemToInput));
      validateItemsAgainstSource(mergedItems, merged.sourceText);
      await validateAppointment(careProfileId, merged.appointmentId);

      const changedFields = [];
      for (const key of Object.keys(normalized)) {
        if (key === 'items') {
          if (JSON.stringify(normalized.items) !== JSON.stringify(normalizeGuidanceItems(currentItems.map(rowItemToInput)))) {
            changedFields.push(key);
          }
        } else if (changedValue(normalized[key], currentMetadata[key], ['visitAt'].includes(key))) {
          changedFields.push(key);
        }
      }
      if (changedFields.length === 0) return loadDetail(current);

      const record = await repository.updateDraftRecord({
        visit_record_id: visitRecordId, appointment_id: merged.appointmentId,
        visit_at: merged.visitAt, hospital_name: merged.hospitalName,
        department: merged.department, doctor_name: merged.doctorName,
        source_text: merged.sourceText, structured_summary: merged.structuredSummary,
      });
      if (!record) fail('RECORD_NOT_DRAFT');
      const items = changedFields.includes('items')
        ? await repository.replaceItems(visitRecordId, mergedItems, () => idFactory('DVI'))
        : currentItems;
      await repository.insertEvent({
        event_id: idFactory('DVE'), visit_record_id: visitRecordId,
        event_type: aiOrganized ? 'ai_organized' : 'draft_updated',
        actor_type: actor.actorType, actor_id: actor.actorId, source: actor.source,
        metadata: sanitizeEventMetadata({ changedFields, itemCount: items.length }),
      });
      return loadDetail(record);
    });
  }

  async function updateDraft(input) {
    return updateDraftInternal({ ...input, aiOrganized: false });
  }

  async function applyAIOrganization(input) {
    return updateDraftInternal({ ...input, aiOrganized: true });
  }

  async function getRecord({ careProfileId, visitRecordId, lineUserId, centerId = null } = {}) {
    validateIdentity({ careProfileId, visitRecordId, lineUserId });
    const access = await getAccess({ careProfileId, lineUserId, centerId });
    const record = await repository.findRecord(visitRecordId);
    if (!record || record.care_profile_id !== careProfileId) fail('RECORD_NOT_FOUND');
    if (record.status === 'draft' && !canEditDraft(access)) fail('RECORD_NOT_FOUND');
    return loadDetail(record);
  }

  async function listRecords({
    careProfileId, lineUserId, centerId = null, includeDrafts = false,
    includeHistory = false, limit = 20, cursor = null,
  } = {}) {
    validateIdentity({ careProfileId, lineUserId });
    const access = await getAccess({ careProfileId, lineUserId, centerId });
    const parsedLimit = Number(limit || 20);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) fail('INVALID_INPUT');
    const rows = await repository.listRecords({
      careProfileId, includeDrafts: Boolean(includeDrafts) && canEditDraft(access),
      includeHistory: Boolean(includeHistory), cursor: decodeCursor(cursor), limit: parsedLimit,
    });
    const hasMore = rows.length > parsedLimit;
    const visible = rows.slice(0, parsedLimit);
    return Object.freeze({
      items: Object.freeze(visible.map((row) => projectRecord(row, { includeSourceText: false }))),
      nextCursor: hasMore ? encodeCursor(visible[visible.length - 1]) : null,
    });
  }

  async function confirmDraft({ careProfileId, visitRecordId, lineUserId, centerId = null } = {}) {
    validateIdentity({ careProfileId, visitRecordId, lineUserId });
    const initialAccess = await getAccess({ careProfileId, lineUserId, centerId });
    requireConfirmation(initialAccess);
    return transaction(`doctor-visit:${visitRecordId}`, async () => {
      const access = await getAccess({ careProfileId, lineUserId, centerId });
      requireConfirmation(access);
      const actor = { ...deriveDoctorVisitActor(access), actorId: lineUserId };
      const current = await repository.findRecordForUpdate(visitRecordId);
      if (!current || current.care_profile_id !== careProfileId) fail('RECORD_NOT_FOUND');
      if (current.status === 'confirmed') return loadDetail(current);
      if (current.status === 'voided') fail('RECORD_ALREADY_VOIDED');
      const items = await repository.listItems(visitRecordId);
      requireConfirmableRecord(current, items);
      const record = await repository.confirmRecord(visitRecordId, actor);
      if (!record) fail('RECORD_NOT_DRAFT');
      await repository.insertEvent({
        event_id: idFactory('DVE'), visit_record_id: visitRecordId,
        event_type: 'confirmed', actor_type: actor.actorType, actor_id: actor.actorId,
        source: actor.source, idempotency_key: `doctor-visit:confirmed:${visitRecordId}`,
        metadata: sanitizeEventMetadata({ versionNo: Number(record.version_no), itemCount: items.length }),
      });
      return loadDetail(record);
    });
  }

  async function createCorrectionDraft({
    careProfileId, visitRecordId, lineUserId, centerId = null, reason,
  } = {}) {
    validateIdentity({ careProfileId, visitRecordId, lineUserId });
    if (typeof reason !== 'string' || !reason.trim()) fail('CORRECTION_REASON_REQUIRED');
    const correctionReason = normalizeText(reason, { required: true, nullable: false, max: 2000 });
    const initialAccess = await getAccess({ careProfileId, lineUserId, centerId });
    requireConfirmation(initialAccess);
    const prior = await repository.findRecord(visitRecordId);
    if (!prior || prior.care_profile_id !== careProfileId) fail('RECORD_NOT_FOUND');
    if (prior.status !== 'confirmed') fail('RECORD_NOT_CONFIRMED');
    return transaction(`doctor-visit-group:${prior.record_group_id}`, async () => {
      const access = await getAccess({ careProfileId, lineUserId, centerId });
      requireConfirmation(access);
      const actor = { ...deriveDoctorVisitActor(access), actorId: lineUserId };
      const latest = await repository.findLatestVersionForUpdate(prior.record_group_id);
      if (!latest || latest.visit_record_id !== visitRecordId || latest.status !== 'confirmed') fail('VERSION_CONFLICT');
      const oldItems = await repository.listItems(visitRecordId);
      const nextRecordId = idFactory('DVR');
      const record = await repository.createRecord({
        visit_record_id: nextRecordId, record_group_id: prior.record_group_id,
        version_no: Number(prior.version_no) + 1, care_profile_id: careProfileId,
        appointment_id: prior.appointment_id, visit_at: prior.visit_at,
        hospital_name: prior.hospital_name, department: prior.department,
        doctor_name: prior.doctor_name, source_text: prior.source_text,
        structured_summary: prior.structured_summary,
        supersedes_visit_record_id: visitRecordId, correction_reason: correctionReason,
        created_by_actor_type: actor.actorType, created_by_actor_id: actor.actorId,
        created_source: actor.source,
      });
      const items = await repository.insertItems(
        nextRecordId, normalizeGuidanceItems(oldItems.map(rowItemToInput)), () => idFactory('DVI')
      );
      const event = await repository.insertEvent({
        event_id: idFactory('DVE'), visit_record_id: nextRecordId,
        event_type: 'correction_draft_created', actor_type: actor.actorType,
        actor_id: actor.actorId, source: actor.source,
        idempotency_key: `doctor-visit:correction:${visitRecordId}:${nextRecordId}`,
        metadata: sanitizeEventMetadata({
          reasonCode: 'correction_requested', versionNo: Number(record.version_no),
          previousVersionNo: Number(prior.version_no), supersedesVisitRecordId: visitRecordId,
          itemCount: items.length,
        }),
      });
      return projectRecord(record, { items, events: event ? [event] : [] });
    });
  }

  async function voidRecord({ careProfileId, visitRecordId, lineUserId, centerId = null, reason } = {}) {
    validateIdentity({ careProfileId, visitRecordId, lineUserId });
    if (typeof reason !== 'string' || !reason.trim()) fail('VOID_REASON_REQUIRED');
    const voidReason = normalizeText(reason, { required: true, nullable: false, max: 2000 });
    const initialAccess = await getAccess({ careProfileId, lineUserId, centerId });
    requireConfirmation(initialAccess);
    return transaction(`doctor-visit:${visitRecordId}`, async () => {
      const access = await getAccess({ careProfileId, lineUserId, centerId });
      requireConfirmation(access);
      const actor = { ...deriveDoctorVisitActor(access), actorId: lineUserId };
      const current = await repository.findRecordForUpdate(visitRecordId);
      if (!current || current.care_profile_id !== careProfileId) fail('RECORD_NOT_FOUND');
      if (current.status === 'voided') fail('RECORD_ALREADY_VOIDED');
      if (current.status !== 'confirmed') fail('RECORD_NOT_CONFIRMED');
      const record = await repository.voidRecord(visitRecordId, voidReason);
      if (!record) fail('RECORD_NOT_CONFIRMED');
      await repository.insertEvent({
        event_id: idFactory('DVE'), visit_record_id: visitRecordId,
        event_type: 'voided', actor_type: actor.actorType, actor_id: actor.actorId,
        source: actor.source, idempotency_key: `doctor-visit:voided:${visitRecordId}`,
        metadata: sanitizeEventMetadata({ reasonCode: 'explicit_void', versionNo: Number(record.version_no) }),
      });
      return loadDetail(record);
    });
  }

  return {
    createDraft, updateDraft, applyAIOrganization, getRecord, listRecords,
    confirmDraft, createCorrectionDraft, voidRecord,
  };
}

module.exports = {
  createDoctorVisitService, projectRecord, projectItem, projectEvent,
  deriveFollowUpSuggestions, encodeCursor, decodeCursor,
};
