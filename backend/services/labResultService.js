const { id, now, withTransaction, Appointments, PendingCards, Residents } = require('../db');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { createLabRepository } = require('./labRepository');
const { createClinicalRecordMutationAuthority } = require('./clinicalRecordMutationAuthority');
const {
  IDENTIFIER_PATTERN, LabDomainError, fail, normalizeIdentifier, normalizeText,
  normalizeReportInput, normalizeObservations, normalizeSource, deriveLabActor,
  canEditDraft, requireDraftEdit, requireConfirmation, requireConfirmableReport,
  sanitizeEventMetadata,
} = require('../domain/lab');

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rowObservationToInput(row) {
  return {
    sourceOrdinal: Number(row.source_ordinal), analyteNameSource: row.analyte_name_source,
    sourceValueText: row.source_value_text, valueType: row.value_type,
    numericValue: row.numeric_value === null ? null : Number(row.numeric_value),
    textValue: row.text_value, sourceUnit: row.source_unit,
    referenceRangeText: row.reference_range_text,
    referenceLow: row.reference_low === null ? null : Number(row.reference_low),
    referenceHigh: row.reference_high === null ? null : Number(row.reference_high),
    abnormalFlagSource: row.abnormal_flag_source, specimenSource: row.specimen_source,
    methodSource: row.method_source, loincCode: row.loinc_code,
    loincVerificationSource: row.loinc_verification_source,
    loincVerifiedBy: row.loinc_verified_by, loincVerifiedAt: row.loinc_verified_at,
    ucumUnit: row.ucum_unit,
    normalizedNumericValue: row.normalized_numeric_value === null ? null : Number(row.normalized_numeric_value),
    unitNormalizationSource: row.unit_normalization_source,
    comparisonKey: row.comparison_key, sourcePage: row.source_page,
    sourceRegion: row.source_region,
    extractionConfidence: row.extraction_confidence === null ? null : Number(row.extraction_confidence),
  };
}

function rowSourceToInput(row) {
  return {
    sourceKind: row.source_kind, pendingCardId: row.pending_card_id,
    sourceReference: row.source_reference, contentSha256: row.content_sha256,
    mimeType: row.mime_type, byteSize: row.byte_size === null ? null : Number(row.byte_size),
    pageNumber: row.page_number, storageStatus: row.storage_status,
    retentionUntil: row.retention_until, purgedAt: row.purged_at,
  };
}

function projectObservation(row) {
  return {
    observationId: row.observation_id,
    sourceOrdinal: Number(row.source_ordinal),
    analyteNameSource: row.analyte_name_source,
    sourceValueText: row.source_value_text,
    valueType: row.value_type,
    numericValue: row.numeric_value === null ? null : Number(row.numeric_value),
    textValue: row.text_value,
    sourceUnit: row.source_unit,
    referenceRangeText: row.reference_range_text,
    referenceLow: row.reference_low === null ? null : Number(row.reference_low),
    referenceHigh: row.reference_high === null ? null : Number(row.reference_high),
    abnormalFlagSource: row.abnormal_flag_source,
    specimenSource: row.specimen_source,
    methodSource: row.method_source,
    loincCode: row.loinc_code,
    loincVerificationSource: row.loinc_verification_source,
    loincVerifiedAt: toIso(row.loinc_verified_at),
    ucumUnit: row.ucum_unit,
    normalizedNumericValue: row.normalized_numeric_value === null ? null : Number(row.normalized_numeric_value),
    unitNormalizationSource: row.unit_normalization_source,
    comparisonKey: row.comparison_key,
    sourcePage: row.source_page,
    sourceRegion: row.source_region || null,
    extractionConfidence: row.extraction_confidence === null ? null : Number(row.extraction_confidence),
    createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
  };
}

function projectSource(row) {
  return {
    sourceId: row.source_id,
    sourceKind: row.source_kind,
    pendingCardId: row.pending_card_id,
    sourceReference: row.source_reference,
    contentSha256: row.content_sha256,
    mimeType: row.mime_type,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    pageNumber: row.page_number,
    storageStatus: row.storage_status,
    retentionUntil: toIso(row.retention_until), purgedAt: toIso(row.purged_at),
    createdAt: toIso(row.created_at),
  };
}

function projectEvent(row) {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    actorType: row.actor_type,
    source: row.source,
    metadata: row.metadata || {},
    occurredAt: toIso(row.occurred_at),
  };
}

function projectReport(row, { observations = null, sources = null, events = null } = {}) {
  const projected = {
    reportId: row.report_id,
    reportGroupId: row.report_group_id,
    versionNo: Number(row.version_no),
    appointmentId: row.appointment_id,
    status: row.status,
    laboratoryName: row.laboratory_name,
    hospitalName: row.hospital_name,
    specimenCollectedAt: toIso(row.specimen_collected_at),
    reportedAt: toIso(row.reported_at),
    supersedesReportId: row.supersedes_report_id,
    correctionReason: row.correction_reason,
    createdByActorType: row.created_by_actor_type,
    createdSource: row.created_source,
    confirmedByActorType: row.confirmed_by_actor_type,
    confirmedAt: toIso(row.confirmed_at),
    voidedAt: toIso(row.voided_at),
    voidReason: row.void_reason,
    retentionUntil: toIso(row.retention_until),
    createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
  };
  if (typeof row.is_authoritative === 'boolean') projected.isCurrent = row.is_authoritative;
  if (observations) projected.observations = observations.map(projectObservation);
  if (sources) projected.sources = sources.map(projectSource);
  if (events) projected.events = events.map(projectEvent);
  return projected;
}

function encodeCursor(row) {
  const sortTime = row.sort_time || row.specimen_collected_at || row.reported_at || row.created_at;
  return Buffer.from(JSON.stringify({ t: toIso(sortTime), id: row.report_id })).toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const timestamp = toIso(decoded.t);
    if (!timestamp || !IDENTIFIER_PATTERN.test(decoded.id)) throw new Error('invalid');
    return { sortTime: timestamp, reportId: decoded.id };
  } catch (_) {
    fail('INVALID_INPUT', { reason: 'invalid_cursor' });
  }
}

function validateIdentity({ careProfileId, reportId = null, lineUserId }) {
  normalizeIdentifier(careProfileId);
  if (reportId !== null) normalizeIdentifier(reportId);
  if (!lineUserId || typeof lineUserId !== 'string' || lineUserId.length > 128) {
    throw new LabDomainError('ACCESS_DENIED');
  }
}

function assertSupportedPrincipal(access) {
  if (!['family_owner', 'family_caregiver', 'center_staff'].includes(access?.principalType)) {
    fail('ACCESS_DENIED');
  }
}

function reportMetadataFromRow(row) {
  return {
    appointmentId: row.appointment_id,
    laboratoryName: row.laboratory_name,
    hospitalName: row.hospital_name,
    specimenCollectedAt: row.specimen_collected_at,
    reportedAt: row.reported_at,
    retentionUntil: row.retention_until,
  };
}

function rejectFrontendTrustMetadata(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.observations)) return;
  if (input.observations.some((observation) => observation && typeof observation === 'object'
    && (Object.prototype.hasOwnProperty.call(observation, 'loincVerifiedBy')
      || Object.prototype.hasOwnProperty.call(observation, 'loincVerifiedAt')))) {
    fail('UNSUPPORTED_FIELD', { reason: 'trusted_verification_metadata' });
  }
}

function createLabResultService(overrides = {}) {
  const repository = overrides.repository || createLabRepository(overrides.repositoryOptions);
  const authorize = overrides.authorizeCareProfileAccess || authorizeCareProfileAccess;
  const transaction = overrides.withTransaction || withTransaction;
  const idFactory = overrides.idFactory || id;
  const nowFactory = overrides.nowFactory || now;
  const mutationAuthority = overrides.mutationAuthority
    || createClinicalRecordMutationAuthority(overrides.mutationAuthorityOptions);
  const findAppointment = overrides.findAppointment || (async ({ appointmentId, careProfileId }) => (
    Appointments.findOne((item) => item.appointment_id === appointmentId
      && item.care_profile_id === careProfileId && item.status !== 'cancelled')
  ));
  const findPendingCardCareProfile = overrides.findPendingCardCareProfile || (async (pendingCardId) => {
    const card = await PendingCards.findOne((item) => item.card_id === pendingCardId);
    if (!card?.resident_id) return null;
    const resident = await Residents.findOne((item) => item.resident_id === card.resident_id);
    return resident?.care_profile_id || null;
  });

  async function validateLinks(careProfileId, appointmentId, sources = []) {
    if (appointmentId && !await findAppointment({ appointmentId, careProfileId })) {
      fail('APPOINTMENT_NOT_FOUND');
    }
    for (const source of sources) {
      if (source.sourceKind === 'pending_card'
        && await findPendingCardCareProfile(source.pendingCardId) !== careProfileId) {
        fail('SOURCE_REFERENCE_INVALID');
      }
    }
  }

  function attachTrustedObservationProvenance(observations, actor) {
    const verifiedAt = nowFactory();
    return observations.map((observation) => observation.loincCode ? {
      ...observation, loincVerifiedBy: actor.actorId, loincVerifiedAt: verifiedAt,
    } : observation);
  }

  async function getAccess({ careProfileId, lineUserId, centerId }) {
    const access = await authorize({
      lineUserId, careProfileId, permission: 'view', centerId: centerId || null,
      requireActiveCenter: true,
    });
    assertSupportedPrincipal(access);
    return access;
  }

  async function loadDetail(report) {
    const [observations, sources, events] = await Promise.all([
      repository.listObservations(report.report_id),
      repository.listSources(report.report_id),
      repository.listEvents(report.report_id),
    ]);
    return projectReport(report, { observations, sources, events });
  }

  async function mutationCapabilities({ report, access, careProfileId, centerId }) {
    const denied = Object.freeze({ canCreateCorrection:false, canVoid:false });
    if (!report || report.status !== 'confirmed' || report.is_authoritative === false) return denied;
    const latest = typeof repository.findLatestVersion === 'function'
      ? await repository.findLatestVersion(report.report_group_id) : report;
    if (!latest || latest.report_id !== report.report_id || latest.status !== 'confirmed') return denied;
    try {
      requireConfirmation(access);
      await mutationAuthority.assertMutationAllowed({
        record:report, access, careProfileId, requestedCenterId:centerId, fail,
      });
      return Object.freeze({ canCreateCorrection:true, canVoid:true });
    } catch (_) { return denied; }
  }

  async function projectWithCapabilities(report, access, careProfileId, centerId, detail = false) {
    const projected = detail ? await loadDetail(report) : projectReport(report);
    return { ...projected, mutationCapabilities:await mutationCapabilities({ report, access, careProfileId, centerId }) };
  }

  async function createDraft({ careProfileId, lineUserId, centerId = null, input } = {}) {
    validateIdentity({ careProfileId, lineUserId });
    rejectFrontendTrustMetadata(input);
    const normalized = normalizeReportInput(input || {});
    const initialAccess = await getAccess({ careProfileId, lineUserId, centerId });
    requireDraftEdit(initialAccess);
    const reportId = idFactory('LABR');
    const reportGroupId = idFactory('LABG');
    return transaction(`lab-report:${reportId}`, async () => {
      const access = await getAccess({ careProfileId, lineUserId, centerId });
      requireDraftEdit(access);
      await validateLinks(careProfileId, normalized.appointmentId, normalized.sources);
      const actor = { ...deriveLabActor(access), actorId: lineUserId };
      const report = await repository.createReport({
        report_id: reportId, report_group_id: reportGroupId, version_no: 1,
        care_profile_id: careProfileId, appointment_id: normalized.appointmentId,
        laboratory_name: normalized.laboratoryName, hospital_name: normalized.hospitalName,
        specimen_collected_at: normalized.specimenCollectedAt,
        reported_at: normalized.reportedAt, supersedes_report_id: null,
        correction_reason: null, created_by_actor_type: actor.actorType,
        created_by_actor_id: actor.actorId, created_source: actor.source,
        retention_until: normalized.retentionUntil,
      });
      const observations = await repository.insertObservations(
        reportId, attachTrustedObservationProvenance(normalized.observations, actor), () => idFactory('LABO')
      );
      const sources = await repository.insertSources(
        reportId, normalized.sources, () => idFactory('LABS')
      );
      const event = await repository.insertEvent({
        event_id: idFactory('LABE'), report_id: reportId, event_type: 'draft_created',
        actor_type: actor.actorType, actor_id: actor.actorId, source: actor.source,
        idempotency_key: `lab:draft-created:${reportId}`,
        metadata: sanitizeEventMetadata({
          versionNo: 1, observationCount: observations.length, sourceCount: sources.length,
        }),
      });
      return projectReport(report, { observations, sources, events: event ? [event] : [] });
    });
  }

  async function updateDraft({ careProfileId, reportId, lineUserId, centerId = null, patch } = {}) {
    validateIdentity({ careProfileId, reportId, lineUserId });
    rejectFrontendTrustMetadata(patch);
    const normalized = normalizeReportInput(patch || {}, { partial: true });
    const initialAccess = await getAccess({ careProfileId, lineUserId, centerId });
    requireDraftEdit(initialAccess);
    return transaction(`lab-report:${reportId}`, async () => {
      const access = await getAccess({ careProfileId, lineUserId, centerId });
      requireDraftEdit(access);
      const actor = { ...deriveLabActor(access), actorId: lineUserId };
        const current = await repository.findReportForUpdate(reportId);
        if (!current || current.care_profile_id !== careProfileId) fail('REPORT_NOT_FOUND');
        if (current.status !== 'draft') fail('REPORT_NOT_DRAFT');
        if (Object.keys(normalized).length === 0) fail('INVALID_INPUT');
        const [currentObservations, currentSources, currentEvents] = await Promise.all([
          repository.listObservations(reportId), repository.listSources(reportId),
          repository.listEvents(reportId),
        ]);
        const merged = { ...reportMetadataFromRow(current), ...normalized };
        delete merged.observations;
        delete merged.sources;
        await validateLinks(
          careProfileId, merged.appointmentId,
          normalized.sources || currentSources.map(rowSourceToInput)
        );
        const changedFields = [];
        const timestampFields = new Set(['specimenCollectedAt', 'reportedAt', 'retentionUntil']);
        const currentMetadata = reportMetadataFromRow(current);
        for (const key of Object.keys(normalized)) {
          if (key === 'observations') {
            const before = normalizeObservations(currentObservations.map(rowObservationToInput));
            if (JSON.stringify(normalized.observations) !== JSON.stringify(before)) changedFields.push(key);
          } else if (key === 'sources') {
            const before = currentSources.map(rowSourceToInput).map(normalizeSource);
            if (JSON.stringify(normalized.sources) !== JSON.stringify(before)) changedFields.push(key);
          } else {
            const equal = timestampFields.has(key)
              ? toIso(normalized[key]) === toIso(currentMetadata[key])
              : normalized[key] === currentMetadata[key];
            if (!equal) changedFields.push(key);
          }
        }
        if (changedFields.length === 0) {
          return projectReport(current, {
            observations: currentObservations, sources: currentSources, events: currentEvents,
          });
        }
      const report = await repository.updateDraftReport({
        report_id: reportId, appointment_id: merged.appointmentId,
        laboratory_name: merged.laboratoryName, hospital_name: merged.hospitalName,
        specimen_collected_at: merged.specimenCollectedAt, reported_at: merged.reportedAt,
        retention_until: merged.retentionUntil,
      });
      if (!report) fail('REPORT_NOT_DRAFT');
        const observations = changedFields.includes('observations')
          ? await repository.replaceObservations(
            reportId, attachTrustedObservationProvenance(normalized.observations, actor), () => idFactory('LABO')
          )
          : currentObservations;
        const sources = changedFields.includes('sources')
          ? await repository.replaceSources(reportId, normalized.sources, () => idFactory('LABS'))
          : currentSources;
      const event = await repository.insertEvent({
        event_id: idFactory('LABE'), report_id: reportId, event_type: 'draft_updated',
        actor_type: actor.actorType, actor_id: actor.actorId, source: actor.source,
        metadata: sanitizeEventMetadata({ changedFields }),
      });
      const events = await repository.listEvents(reportId);
      if (event && !events.some((item) => item.event_id === event.event_id)) events.unshift(event);
      return projectReport(report, { observations, sources, events });
    });
  }

  async function getReport({ careProfileId, reportId, lineUserId, centerId = null } = {}) {
    validateIdentity({ careProfileId, reportId, lineUserId });
    const access = await getAccess({ careProfileId, lineUserId, centerId });
    const report = await repository.findReport(reportId);
    if (!report || report.care_profile_id !== careProfileId) fail('REPORT_NOT_FOUND');
    if (report.status === 'draft' && !canEditDraft(access)) fail('REPORT_NOT_FOUND');
    return projectWithCapabilities(report, access, careProfileId, centerId, true);
  }

  async function listReports({
    careProfileId, lineUserId, centerId = null, includeDrafts = false,
    includeHistory = false, limit = 20, cursor = null,
  } = {}) {
    validateIdentity({ careProfileId, lineUserId });
    const access = await getAccess({ careProfileId, lineUserId, centerId });
    const parsedLimit = Number(limit || 20);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) fail('INVALID_INPUT');
    const mayReviewDrafts = canEditDraft(access);
    const rows = await repository.listReports({
      careProfileId, includeDrafts: Boolean(includeDrafts) && mayReviewDrafts,
      includeHistory: Boolean(includeHistory), cursor: decodeCursor(cursor), limit: parsedLimit,
    });
    const hasMore = rows.length > parsedLimit;
    const visible = rows.slice(0, parsedLimit);
    return {
      items: await Promise.all(visible.map((row) => projectWithCapabilities(row, access, careProfileId, centerId))),
      nextCursor: hasMore ? encodeCursor(visible[visible.length - 1]) : null,
    };
  }

  async function confirmDraft({ careProfileId, reportId, lineUserId, centerId = null } = {}) {
    validateIdentity({ careProfileId, reportId, lineUserId });
    const initialAccess = await getAccess({ careProfileId, lineUserId, centerId });
    requireConfirmation(initialAccess);
    return transaction(`lab-report:${reportId}`, async () => {
      const access = await getAccess({ careProfileId, lineUserId, centerId });
      requireConfirmation(access);
      const actor = { ...deriveLabActor(access), actorId: lineUserId };
      const current = await repository.findReportForUpdate(reportId);
      if (!current || current.care_profile_id !== careProfileId) fail('REPORT_NOT_FOUND');
      if (current.supersedes_report_id) {
        await mutationAuthority.assertMutationAllowed({
          record:current, access, careProfileId, requestedCenterId:centerId, fail,
        });
      }
      const observations = await repository.listObservations(reportId);
      requireConfirmableReport(current, observations);
      const report = await repository.confirmReport(reportId, actor);
      if (!report) fail('REPORT_NOT_DRAFT');
      await repository.insertEvent({
        event_id: idFactory('LABE'), report_id: reportId, event_type: 'confirmed',
        actor_type: actor.actorType, actor_id: actor.actorId, source: actor.source,
        idempotency_key: `lab:confirmed:${reportId}`,
        metadata: sanitizeEventMetadata({
          versionNo: Number(report.version_no), observationCount: observations.length,
        }),
      });
      return loadDetail(report);
    });
  }

  async function createCorrectionDraft({
    careProfileId, reportId, lineUserId, centerId = null, reason,
  } = {}) {
    validateIdentity({ careProfileId, reportId, lineUserId });
    if (typeof reason !== 'string' || !reason.trim()) fail('CORRECTION_REASON_REQUIRED');
    const correctionReason = normalizeText(reason, { required: true, nullable: false, max: 2000 });
    const initialAccess = await getAccess({ careProfileId, lineUserId, centerId });
    requireConfirmation(initialAccess);
    const prior = await repository.findReport(reportId);
    if (!prior || prior.care_profile_id !== careProfileId) fail('REPORT_NOT_FOUND');
    if (prior.status !== 'confirmed') fail('REPORT_NOT_CONFIRMED');
    return transaction(`lab-report-group:${prior.report_group_id}`, async () => {
      const access = await getAccess({ careProfileId, lineUserId, centerId });
      requireConfirmation(access);
      const actor = { ...deriveLabActor(access), actorId: lineUserId };
      const latest = await repository.findLatestVersionForUpdate(prior.report_group_id);
      if (!latest || latest.report_id !== reportId || latest.status !== 'confirmed') fail('VERSION_CONFLICT');
      await mutationAuthority.assertMutationAllowed({
        record:latest, access, careProfileId, requestedCenterId:centerId, fail,
      });
      const [oldObservations, oldSources] = await Promise.all([
        repository.listObservations(reportId), repository.listSources(reportId),
      ]);
      const reportIdNew = idFactory('LABR');
      const report = await repository.createReport({
        report_id: reportIdNew, report_group_id: prior.report_group_id,
        version_no: Number(prior.version_no) + 1, care_profile_id: careProfileId,
        appointment_id: prior.appointment_id, laboratory_name: prior.laboratory_name,
        hospital_name: prior.hospital_name,
        specimen_collected_at: prior.specimen_collected_at, reported_at: prior.reported_at,
        supersedes_report_id: reportId, correction_reason: correctionReason,
        created_by_actor_type: actor.actorType, created_by_actor_id: actor.actorId,
        created_source: actor.source, retention_until: prior.retention_until,
      });
      const observations = await repository.insertObservations(
        reportIdNew, normalizeObservations(oldObservations.map(rowObservationToInput)), () => idFactory('LABO')
      );
      const sources = await repository.insertSources(
        reportIdNew, oldSources.map(rowSourceToInput).map(normalizeSource), () => idFactory('LABS')
      );
      const event = await repository.insertEvent({
        event_id: idFactory('LABE'), report_id: reportIdNew,
        event_type: 'correction_draft_created', actor_type: actor.actorType,
        actor_id: actor.actorId, source: actor.source,
        idempotency_key: `lab:correction:${reportId}:${reportIdNew}`,
        metadata: sanitizeEventMetadata({
          reasonCode: 'correction_requested', versionNo: Number(report.version_no),
          previousVersionNo: Number(prior.version_no), supersedesReportId: reportId,
          observationCount: observations.length, sourceCount: sources.length,
        }),
      });
      return projectReport(report, { observations, sources, events: event ? [event] : [] });
    });
  }

  async function voidReport({ careProfileId, reportId, lineUserId, centerId = null, reason } = {}) {
    validateIdentity({ careProfileId, reportId, lineUserId });
    if (typeof reason !== 'string' || !reason.trim()) fail('VOID_REASON_REQUIRED');
    const voidReason = normalizeText(reason, { required: true, nullable: false, max: 2000 });
    const initialAccess = await getAccess({ careProfileId, lineUserId, centerId });
    requireConfirmation(initialAccess);
    return transaction(`lab-report:${reportId}`, async () => {
      const access = await getAccess({ careProfileId, lineUserId, centerId });
      requireConfirmation(access);
      const actor = { ...deriveLabActor(access), actorId: lineUserId };
      const current = await repository.findReportForUpdate(reportId);
      if (!current || current.care_profile_id !== careProfileId) fail('REPORT_NOT_FOUND');
      await mutationAuthority.assertMutationAllowed({
        record:current, access, careProfileId, requestedCenterId:centerId, fail,
      });
      if (current.status === 'voided') return loadDetail(current);
      if (current.status !== 'confirmed') fail('REPORT_NOT_CONFIRMED');
      const report = await repository.voidReport(reportId, voidReason);
      if (!report) fail('REPORT_NOT_CONFIRMED');
      await repository.insertEvent({
        event_id: idFactory('LABE'), report_id: reportId, event_type: 'voided',
        actor_type: actor.actorType, actor_id: actor.actorId, source: actor.source,
        idempotency_key: `lab:voided:${reportId}`,
        metadata: sanitizeEventMetadata({ reasonCode: 'explicit_void', versionNo: Number(report.version_no) }),
      });
      return loadDetail(report);
    });
  }

  return {
    createDraft, updateDraft, getReport, listReports, confirmDraft,
    createCorrectionDraft, voidReport,
  };
}

module.exports = {
  createLabResultService, projectReport, projectObservation, projectSource,
  projectEvent, decodeCursor, encodeCursor,
};
