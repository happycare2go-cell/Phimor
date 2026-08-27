const { Centers, CenterStaff, Residents, id, withTransaction } = require('../db');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { platformService } = require('./platformService');
const { createVitalSignRepository } = require('./vitalSignRepository');
const {
  VitalSignsError, requiredId, requiredTimestamp, optionalText, normalizeObservations,
} = require('../domain/vitalSigns');

function actorReference(value) {
  const clean = String(value || '').trim();
  if (!clean || clean.length > 128) throw new VitalSignsError('ACTOR_REQUIRED', 'ไม่พบผู้บันทึก', 401);
  return clean;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ occurredAt:row.occurred_at, vitalSetId:row.vital_set_id })).toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    return { occurredAt:requiredTimestamp(parsed.occurredAt, 'INVALID_CURSOR'), vitalSetId:requiredId(parsed.vitalSetId, 'Vital Set ID') };
  } catch (error) {
    if (error instanceof VitalSignsError && error.code === 'INVALID_CURSOR') throw error;
    throw new VitalSignsError('INVALID_CURSOR', 'cursor ไม่ถูกต้อง', 400);
  }
}

function projectObservation(row) {
  return {
    measurementType: row.measurement_type,
    sourceValueText: row.source_value_text,
    numericValue: Number(row.numeric_value),
    sourceUnit: row.source_unit,
    canonicalUnit: row.canonical_unit,
    context: row.measurement_context || null,
  };
}

function projectSet(row, observations = row.observations || []) {
  return {
    vitalSetId: row.vital_set_id,
    status: row.status,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    sourceType: row.source_type,
    centerName: row.center_name || null,
    observations: observations.map(projectObservation),
  };
}

function createVitalSignService(overrides = {}) {
  const repository = overrides.repository || createVitalSignRepository();
  const centers = overrides.Centers || Centers;
  const staffTable = overrides.CenterStaff || CenterStaff;
  const residents = overrides.Residents || Residents;
  const authorize = overrides.authorizeCareProfileAccess || authorizeCareProfileAccess;
  const platform = overrides.platformService || platformService;
  const idFactory = overrides.idFactory || id;
  const transact = overrides.withTransaction || withTransaction;

  async function assertSubject({ organizationId, centerId, residentId, careProfileId }) {
    const center = await centers.findOne((row) => row.center_id === centerId && row.status === 'active');
    if (!center) throw new VitalSignsError('CENTER_UNAVAILABLE', 'ศูนย์ไม่พร้อมใช้งาน', 403);
    const organization = await platform.getOrganizationForCenter(centerId);
    if (!organization || organization.organizationId !== organizationId || organization.status !== 'active') {
      throw new VitalSignsError('TENANT_MISMATCH', 'ข้อมูล tenant ไม่ถูกต้อง', 403);
    }
    const resident = await residents.findOne((row) => row.resident_id === residentId
      && row.center_id === centerId && row.status === 'active');
    if (!resident) throw new VitalSignsError('RESIDENT_NOT_IN_CENTER', 'ไม่พบผู้พักในศูนย์นี้', 403);
    if (!resident.care_profile_id || resident.care_profile_id !== careProfileId) {
      throw new VitalSignsError('CARE_PROFILE_RELATIONSHIP_MISMATCH', 'Care Profile ไม่สัมพันธ์กับผู้พัก', 403);
    }
    return { center, resident, organization };
  }

  async function recordCanonical({ tenant, subject, observations, occurredAt, provenance }) {
    const organizationId = requiredId(tenant?.organizationId, 'Organization ID');
    const centerId = requiredId(subject?.centerId, 'Center ID');
    const residentId = requiredId(subject?.residentId, 'Resident ID');
    const careProfileId = requiredId(subject?.careProfileId, 'Care Profile ID');
    await assertSubject({ organizationId, centerId, residentId, careProfileId });
    if (!await platform.isCenterCapabilityEnabled(centerId, 'vital_signs_v1')) {
      throw new VitalSignsError('CAPABILITY_DISABLED', 'ศูนย์ยังไม่ได้เปิดใช้การบันทึกสัญญาณชีพ', 403);
    }
    const normalized = normalizeObservations(observations);
    const at = requiredTimestamp(occurredAt);
    const sourceType = provenance?.sourceType;
    if (!['native_phimor', 'external_integration'].includes(sourceType)) {
      throw new VitalSignsError('INVALID_SOURCE_TYPE', 'แหล่งข้อมูลไม่ถูกต้อง', 400);
    }
    const sourceSystem = optionalText(provenance?.sourceSystem, 100);
    if (!sourceSystem) throw new VitalSignsError('SOURCE_SYSTEM_REQUIRED', 'ไม่พบระบบต้นทาง', 400);
    const integrationClientId = sourceType === 'external_integration'
      ? requiredId(provenance?.integrationClientId, 'Integration Client ID') : null;
    const externalRecordId = sourceType === 'external_integration'
      ? requiredId(provenance?.externalRecordId, 'External record ID') : null;
    const actorType = sourceType === 'external_integration' ? 'integration_client' : 'center_staff';
    const actor = actorReference(provenance?.actorReference);

    if (integrationClientId) {
      const client = await platform.inspectIntegrationClient(integrationClientId);
      if (client.status !== 'active' || client.organizationId !== organizationId) {
        throw new VitalSignsError('INTEGRATION_TENANT_MISMATCH', 'Integration Client ไม่สัมพันธ์กับ tenant', 403);
      }
      if (!client.centers.some((scope) => scope.center_id === centerId)) {
        throw new VitalSignsError('INTEGRATION_CENTER_SCOPE_DENIED', 'Integration Client ไม่มีสิทธิ์ในศูนย์นี้', 403);
      }
    }

    return transact(`vital-record:${integrationClientId || centerId}:${externalRecordId || `${residentId}:${at}`}`, async () => {
      if (integrationClientId) {
        const duplicate = await repository.findByExternalRecord(integrationClientId, externalRecordId);
        if (duplicate) return { duplicate:true, item:projectSet(duplicate, await repository.listObservations(duplicate.vital_set_id)) };
      }
      const vitalSetId = idFactory('VSET');
      const row = await repository.insertSet({
        vitalSetId, organizationId, centerId, residentId, careProfileId, occurredAt:at,
        actorType, actorReference:actor, sourceType, sourceSystem,
        integrationClientId, integrationEventId:provenance?.integrationEventId || null,
        externalRecordId, externalStaffId:optionalText(provenance?.externalStaffId, 160),
        externalStaffDisplayName:optionalText(provenance?.externalStaffDisplayName, 160),
      });
      const stored = [];
      for (const observation of normalized) {
        stored.push(await repository.insertObservation({
          vitalObservationId:idFactory('VOBS'), vitalSetId, ...observation,
        }));
      }
      await repository.insertEvent({
        vitalEventId:idFactory('VEVT'), vitalSetId, eventType:'recorded',
        actorType, actorReference:actor,
        metadata:{ measurementTypes:normalized.map((item)=>item.measurementType), sourceType },
      });
      return { duplicate:false, item:projectSet(row, stored) };
    });
  }

  async function recordNative({ lineUserId, centerId, residentId, occurredAt, observations }) {
    const centerKey = requiredId(centerId, 'Center ID');
    const residentKey = requiredId(residentId, 'Resident ID');
    const staff = await staffTable.findOne((row) => row.center_id === centerKey
      && row.line_user_id === lineUserId && row.status === 'active'
      && ['owner','manager','staff'].includes(row.role));
    if (!staff) throw new VitalSignsError('CENTER_ACCESS_DENIED', 'ไม่มีสิทธิ์บันทึกข้อมูลศูนย์นี้', 403);
    const resident = await residents.findOne((row) => row.resident_id === residentKey
      && row.center_id === centerKey && row.status === 'active');
    if (!resident?.care_profile_id) throw new VitalSignsError('RESIDENT_NOT_READY', 'ผู้พักยังไม่มี Care Profile ที่พร้อมใช้งาน', 409);
    const organization = await platform.getOrganizationForCenter(centerKey);
    if (!organization) throw new VitalSignsError('CENTER_TENANT_UNAVAILABLE', 'ไม่พบ tenant ของศูนย์', 409);
    return recordCanonical({
      tenant:{ organizationId:organization.organizationId },
      subject:{ centerId:centerKey, residentId:residentKey, careProfileId:resident.care_profile_id },
      observations, occurredAt,
      provenance:{ sourceType:'native_phimor', sourceSystem:'phimor_center', actorReference:`center_staff:${staff.staff_id}`,
        recorderDisplayName:staff.display_name || staff.full_name || staff.name || null },
    });
  }

  async function listHistory({ lineUserId, careProfileId, centerId = null, from = null, to = null, cursor = null, limit = 20 }) {
    const profileId = requiredId(careProfileId, 'Care Profile ID');
    await authorize({ lineUserId, careProfileId:profileId, permission:'view', centerId:centerId || null, requireActiveCenter:false });
    const boundedLimit = Math.min(50, Math.max(1, Number(limit) || 20));
    const fromAt = from ? requiredTimestamp(from, 'INVALID_DATE_RANGE') : null;
    const toAt = to ? requiredTimestamp(to, 'INVALID_DATE_RANGE') : null;
    if (fromAt && toAt && new Date(fromAt) > new Date(toAt)) throw new VitalSignsError('INVALID_DATE_RANGE', 'ช่วงวันที่ไม่ถูกต้อง', 400);
    if (fromAt && toAt && new Date(toAt) - new Date(fromAt) > 366 * 86400000) {
      throw new VitalSignsError('DATE_RANGE_TOO_LARGE', 'ช่วงวันที่ต้องไม่เกิน 366 วัน', 400);
    }
    const rows = await repository.listHistory({
      careProfileId:profileId, centerId:centerId || null, from:fromAt, to:toAt,
      cursor:decodeCursor(cursor), limit:boundedLimit,
    });
    const hasMore = rows.length > boundedLimit;
    const page = rows.slice(0, boundedLimit);
    const centerNames = new Map();
    for (const centerId of [...new Set(page.map((row) => row.center_id).filter(Boolean))]) {
      const center = await centers.findOne((row) => row.center_id === centerId);
      centerNames.set(centerId, center?.name || null);
    }
    return { items:page.map((row)=>projectSet({ ...row, center_name:centerNames.get(row.center_id) || null })), nextCursor:hasMore ? encodeCursor(page.at(-1)) : null };
  }

  async function voidVitalSet({ lineUserId, centerId, vitalSetId, reason }) {
    const centerKey = requiredId(centerId, 'Center ID');
    const setId = requiredId(vitalSetId, 'Vital Set ID');
    const cleanReason = optionalText(reason, 500);
    if (!cleanReason) throw new VitalSignsError('VOID_REASON_REQUIRED', 'กรุณาระบุเหตุผล', 400);
    const staff = await staffTable.findOne((row) => row.center_id === centerKey
      && row.line_user_id === lineUserId && row.status === 'active' && ['owner','manager'].includes(row.role));
    if (!staff) throw new VitalSignsError('CENTER_ACCESS_DENIED', 'ไม่มีสิทธิ์ยกเลิกรายการนี้', 403);
    return transact(`vital-void:${setId}`, async () => {
      const current = await repository.findSet(setId);
      if (!current || current.center_id !== centerKey) throw new VitalSignsError('VITAL_SET_NOT_FOUND', 'ไม่พบรายการ', 404);
      if (current.status === 'voided') return projectSet(current, await repository.listObservations(setId));
      const actor = `center_staff:${staff.staff_id}`;
      const updated = await repository.voidSet({ vitalSetId:setId, actorReference:actor, reason:cleanReason });
      await repository.insertEvent({ vitalEventId:idFactory('VEVT'), vitalSetId:setId, eventType:'voided', actorType:'center_staff', actorReference:actor, metadata:{ reasonCode:'human_void' } });
      return projectSet(updated, await repository.listObservations(setId));
    });
  }

  return { recordCanonical, recordNative, listHistory, voidVitalSet, repository };
}

const vitalSignService = createVitalSignService();

module.exports = { createVitalSignService, vitalSignService, projectSet, projectObservation, decodeCursor };
