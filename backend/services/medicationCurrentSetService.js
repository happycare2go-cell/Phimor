const {
  MedicationSnapshots, Medications, audit, id, now, withTransactionLocks,
} = require('../db');
const { createHash } = require('node:crypto');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const {
  loadSnapshotMedications, projectMedication,
  snapshotMetadata, snapshotVersion, findAuthoritativeSnapshot,
} = require('./medicationRetrievalService');
const { normalizeMedication, matchNormalized } = require('./medicationDiffService');

const MAX_MEDICATIONS = 30;
const FIELD_LIMITS = Object.freeze({
  name:200, strength:120, dose:200, instruction:500, amount:120, unit:120,
  frequency:120, timing:120, route:120, condition:500, stableMedicationId:160,
});
const ITEM_FIELDS = new Set([
  'medicationId', 'medication_id', 'stableMedicationId', 'stable_medication_id',
  'name', 'strength', 'dose', 'instruction', 'note', 'amount', 'unit',
  'frequency', 'timing', 'route', 'condition',
]);

class MedicationCurrentSetError extends Error {
  constructor(code, status, message, details = null) {
    super(message);
    this.name = 'MedicationCurrentSetError';
    this.code = code;
    this.status = status;
    if (details) Object.defineProperty(this, 'details', { value:details, enumerable:false });
  }
}

function invalid(code, message, details = null, status = 400) {
  throw new MedicationCurrentSetError(code, status, message, details);
}

function cleanText(value, field) {
  if (value === null || value === undefined) return '';
  const text = String(value).normalize('NFC').trim();
  if (text.length > FIELD_LIMITS[field]) invalid('MEDICATION_FIELD_TOO_LONG', `ข้อมูลช่อง ${field} ยาวเกินกำหนด`, { field });
  return text;
}

function canonicalMedication(item = {}, rowIndex = 0) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('INVALID_MEDICATION_ITEM', 'รูปแบบรายการยาไม่ถูกต้อง', { rowIndex });
  const unsupported = Object.keys(item).find((key) => !ITEM_FIELDS.has(key));
  if (unsupported) invalid('UNSUPPORTED_MEDICATION_FIELD', 'พบช่องข้อมูลยาที่ระบบไม่รองรับ', { rowIndex, field:unsupported });
  const name = cleanText(item.name, 'name');
  if (!name) invalid('MEDICATION_NAME_REQUIRED', 'กรุณาระบุชื่อยา', { rowIndex, field:'name' });
  const amount = item.amount === null || item.amount === undefined || item.amount === ''
    ? null : cleanText(item.amount, 'amount');
  return Object.freeze({
    medicationId:item.medicationId || item.medication_id || null,
    stableMedicationId:cleanText(item.stableMedicationId || item.stable_medication_id, 'stableMedicationId') || null,
    name, strength:cleanText(item.strength, 'strength'), dose:cleanText(item.dose, 'dose'),
    instruction:cleanText(item.instruction ?? item.note, 'instruction'), amount,
    unit:cleanText(item.unit, 'unit') || null, frequency:cleanText(item.frequency, 'frequency') || null,
    timing:cleanText(item.timing, 'timing') || null, route:cleanText(item.route, 'route') || null,
    condition:cleanText(item.condition, 'condition'),
  });
}

function validateCompleteSet(items, { confirmRemoveAll = false } = {}) {
  if (!Array.isArray(items)) invalid('INVALID_MEDICATION_SET', 'รูปแบบรายการยาไม่ถูกต้อง');
  if (items.length > MAX_MEDICATIONS) invalid('MEDICATION_ROW_LIMIT_EXCEEDED', `บันทึกยาได้ไม่เกิน ${MAX_MEDICATIONS} รายการ`);
  if (items.length === 0 && !confirmRemoveAll) invalid('EMPTY_MEDICATION_SET_REQUIRES_CONFIRMATION', 'กรุณายืนยันก่อนลบยาทั้งหมด');
  const canonical = items.map(canonicalMedication);
  const normalized = canonical.map(normalizeMedication);
  const stable = new Map();
  const names = new Map();
  const conflicts = [];
  normalized.forEach((entry, rowIndex) => {
    const stableKey = entry.normalized.stableMedicationId;
    const nameKey = entry.normalized.name;
    if (stableKey && stable.has(stableKey)) conflicts.push({ rows:[stable.get(stableKey), rowIndex], field:'stableMedicationId' });
    else if (stableKey) stable.set(stableKey, rowIndex);
    if (nameKey && names.has(nameKey)) conflicts.push({ rows:[names.get(nameKey), rowIndex], field:'name' });
    else if (nameKey) names.set(nameKey, rowIndex);
  });
  if (conflicts.length) invalid('DUPLICATE_MEDICATION_IDENTITY', 'พบรายการยาซ้ำ กรุณาแก้ไขให้เหลือยาแต่ละชนิดหนึ่งรายการ', { conflicts }, 422);
  return canonical;
}

function canonicalImageItems(items) {
  if (!Array.isArray(items)) invalid('INVALID_MEDICATION_SET', 'รูปแบบรายการยาไม่ถูกต้อง');
  if (items.length > MAX_MEDICATIONS) invalid('MEDICATION_ROW_LIMIT_EXCEEDED', `บันทึกยาได้ไม่เกิน ${MAX_MEDICATIONS} รายการ`);
  return items.map(canonicalMedication);
}

function actorType(access) {
  if (access.principalType === 'family_owner') return 'family_owner';
  if (access.principalType === 'family_caregiver') return 'family_caregiver';
  if (access.principalType === 'center_staff' && access.role === 'owner') return 'center_owner';
  if (access.principalType === 'center_staff' && access.role === 'manager') return 'center_manager';
  invalid('MEDICATION_MUTATION_FORBIDDEN', 'ไม่มีสิทธิ์แก้ไขรายการยา', null, 403);
}

async function rawCurrent(careProfileId) {
  return findAuthoritativeSnapshot(careProfileId);
}

function comparable(item) {
  return {
    stableMedicationId:item.stableMedicationId || null, name:item.name, strength:item.strength || '',
    dose:item.dose || '', instruction:item.instruction || '', amount:item.amount ?? null,
    unit:item.unit ?? null, frequency:item.frequency ?? null, timing:item.timing ?? null,
    route:item.route ?? null, condition:item.condition || '',
  };
}

function medicationSetDiff(previousItems, currentItems) {
  const previous = previousItems.map((item) => normalizeMedication(comparable(item)));
  const current = currentItems.map((item) => normalizeMedication(comparable(item)));
  const matched = matchNormalized(previous, current);
  const changes = [];
  for (const index of matched.unmatchedCurrent) changes.push({ category:'added', currentIndex:index, changedFields:[] });
  for (const index of matched.unmatchedPrevious) changes.push({ category:'removed', previousIndex:index, changedFields:[] });
  for (const pair of matched.pairs) {
    const before = comparable(previousItems[pair.previousIndex]);
    const after = comparable(currentItems[pair.currentIndex]);
    const fields = ['strength','dose','amount','unit','instruction','frequency','timing','route','condition']
      .filter((field) => String(before[field] ?? '') !== String(after[field] ?? ''));
    if (!fields.length) continue;
    let category = 'multiple_fields_changed';
    if (fields.length === 1 && fields[0] === 'strength') category = 'strength_changed';
    else if (fields.length === 1 && fields[0] === 'dose') category = 'dose_changed';
    else if (fields.length === 1 && fields[0] === 'instruction') category = 'instruction_changed';
    changes.push({ category, previousIndex:pair.previousIndex, currentIndex:pair.currentIndex, changedFields:fields });
  }
  return { changes, warnings:matched.warnings };
}

function safeSourceLabel(source) {
  return ({ manual:'ครอบครัวบันทึก', family_manual:'ครอบครัวบันทึก', image_ai:'ครอบครัวตรวจจากรูป',
    center_manual:'ศูนย์บันทึก', center_image_ai:'ศูนย์ตรวจจากรูป', center_photo:'ศูนย์ตรวจจากเอกสาร' })[source]
    || 'ข้อมูลเดิมในระบบ';
}

function safeCurrentProjection(result) {
  return {
    status:result.status,
    currentSnapshot:result.currentSnapshot ? {
      snapshotId:result.currentSnapshot.snapshotId, versionNo:result.currentSnapshot.versionNo,
      recordedAt:result.currentSnapshot.recordedAt, source:result.currentSnapshot.source,
      sourceLabel:safeSourceLabel(result.currentSnapshot.source),
    } : null,
    medications:(result.medications || []).map(projectMedication),
  };
}

function medicationRecord(item, { careProfileId, snapshotId, source, medicationId, sourceCenterId = null }) {
  return {
    medication_id:medicationId, care_profile_id:careProfileId, snapshot_id:snapshotId,
    stable_medication_id:item.stableMedicationId, name:item.name, strength:item.strength,
    dose:item.dose, instruction:item.instruction, amount:item.amount, unit:item.unit,
    frequency:item.frequency, timing:item.timing, route:item.route, condition:item.condition,
    source, source_center_id:sourceCenterId,
  };
}

function createMedicationCurrentSetService(overrides = {}) {
  const authorize = overrides.authorize || authorizeCareProfileAccess;
  const transact = overrides.withTransactionLocks || withTransactionLocks;
  const clock = overrides.now || now;
  const idFactory = overrides.id || id;
  const auditEvent = overrides.audit || audit;

  async function getCurrent({ careProfileId, requester, authorizeRead = true } = {}) {
    if (authorizeRead) await authorize({
      lineUserId:requester?.lineUserId, careProfileId, permission:'view',
      centerId:requester?.centerId || null, requireActiveCenter:true,
    });
    const snapshot = await rawCurrent(careProfileId);
    if (!snapshot) return safeCurrentProjection({ status:'NO_CURRENT_SNAPSHOT', currentSnapshot:null, medications:[] });
    const loaded = await loadSnapshotMedications(snapshot);
    return safeCurrentProjection({ status:'CURRENT_SNAPSHOT', currentSnapshot:snapshotMetadata(snapshot), medications:loaded.medications });
  }

  async function saveCompleteSet({
    careProfileId, items, baseSnapshotId = null, requester, source = 'manual',
    sourceImageBase64 = null, confirmRemoveAll = false, mutationId = null,
  } = {}) {
    const access = await authorize({
      lineUserId:requester?.lineUserId, careProfileId, permission:'manage_medications',
      centerId:requester?.centerId || null, requireActiveCenter:true,
    });
    const sourceActorType = actorType(access);
    if (mutationId && (!/^[A-Za-z0-9:_-]{1,180}$/.test(String(mutationId)))) {
      invalid('INVALID_MEDICATION_MUTATION_ID', 'รหัสการบันทึกไม่ถูกต้อง');
    }
    return transact([`medication-current:${careProfileId}`], async () => {
      const proposed = validateCompleteSet(items, { confirmRemoveAll });
      const mutationPayloadHash = createHash('sha256').update(JSON.stringify({
        careProfileId, items:proposed.map(comparable), confirmRemoveAll:Boolean(confirmRemoveAll), source,
      })).digest('hex');
      if (mutationId) {
        const duplicate = await MedicationSnapshots.findOne((snapshot) =>
          snapshot.care_profile_id === careProfileId && snapshot.mutation_id === mutationId);
        if (duplicate) {
          if (duplicate.mutation_payload_hash && duplicate.mutation_payload_hash !== mutationPayloadHash) {
            invalid('MEDICATION_MUTATION_CONFLICT', 'คำขอบันทึกนี้ถูกใช้กับรายการยาอื่นแล้ว กรุณาโหลดข้อมูลล่าสุด', null, 409);
          }
          const authoritative = await rawCurrent(careProfileId);
          const loaded = authoritative ? await loadSnapshotMedications(authoritative) : { medications:[] };
          return { ...safeCurrentProjection({ status:authoritative ? 'CURRENT_SNAPSHOT' : 'NO_CURRENT_SNAPSHOT',
            currentSnapshot:authoritative ? snapshotMetadata(authoritative) : null, medications:loaded.medications }),
            duplicate:true, noChange:false };
        }
      }
      const current = await rawCurrent(careProfileId);
      const authoritativeBase = current?.snapshot_id || null;
      if ((baseSnapshotId || null) !== authoritativeBase) {
        invalid('MEDICATION_SNAPSHOT_STALE', 'รายการยามีการเปลี่ยนแปลงแล้ว กรุณาโหลดข้อมูลล่าสุดและตรวจสอบอีกครั้ง',
          { expectedSnapshotId:authoritativeBase }, 409);
      }
      const previousLoaded = current ? await loadSnapshotMedications(current) : { medications:[] };
      const diff = medicationSetDiff(previousLoaded.medications, proposed);
      if (diff.changes.length === 0) {
        return { ...safeCurrentProjection({ status:current ? 'CURRENT_SNAPSHOT' : 'NO_CURRENT_SNAPSHOT',
          currentSnapshot:current ? snapshotMetadata(current) : null, medications:previousLoaded.medications }),
          resultCode:'NO_MEDICATION_CHANGE', noChange:true, duplicate:false };
      }
      const recordedAt = clock();
      const snapshotId = idFactory('MEDS');
      const versionNo = Math.max(0, snapshotVersion(current)) + 1;
      const linked = proposed.map((item) => medicationRecord(item, {
        careProfileId, snapshotId, source, medicationId:idFactory('MED'),
        sourceCenterId:requester?.centerId || null,
      }));
      const changeSummary = diff.changes.map((change) => ({
        category:change.category, changed_fields:change.changedFields,
      }));
      let snapshot;
      try {
        snapshot = await MedicationSnapshots.insert({
          snapshot_id:snapshotId, care_profile_id:careProfileId, schema_version:2,
          version_no:versionNo, base_snapshot_id:authoritativeBase,
          supersedes_snapshot_id:authoritativeBase, status:'active', source,
          source_actor_type:sourceActorType, source_center_id:requester?.centerId || null,
          source_image_base64:sourceImageBase64 || null, recorded_at:recordedAt,
          mutation_id:mutationId || null, mutation_payload_hash:mutationId ? mutationPayloadHash : null,
          change_summary:changeSummary,
          items:linked.map((item) => ({ ...item })),
        });
        for (const record of linked) await Medications.insert({ ...record, created_at:recordedAt });
        await auditEvent('medication.current_set_updated', sourceActorType, {
          careProfileId, centerId:requester?.centerId || null,
          baseSnapshotId:authoritativeBase, resultingSnapshotId:snapshotId,
          versionNo, source, changeCategories:[...new Set(diff.changes.map((change) => change.category))],
          changedFields:[...new Set(diff.changes.flatMap((change) => change.changedFields))],
          changedAt:recordedAt,
        });
      } catch (error) {
        // PostgreSQL rolls this transaction back. These removals make the same
        // atomicity observable in the deterministic in-memory test adapter.
        let row = await Medications.findOne((item) => item.snapshot_id === snapshotId);
        while (row) {
          await Medications.remove((item) => item.snapshot_id === snapshotId);
          row = await Medications.findOne((item) => item.snapshot_id === snapshotId);
        }
        await MedicationSnapshots.remove((item) => item.snapshot_id === snapshotId);
        throw error;
      }
      return { ...safeCurrentProjection({ status:'CURRENT_SNAPSHOT', currentSnapshot:snapshotMetadata(snapshot), medications:linked }),
        noChange:false, duplicate:false };
    });
  }

  async function proposeImageMerge({ careProfileId, extractedItems, requester } = {}) {
    const current = await getCurrent({ careProfileId, requester });
    if (!Array.isArray(extractedItems) || extractedItems.length === 0) {
      return { baseSnapshotId:current.currentSnapshot?.snapshotId || null, current, extracted:[], proposals:[] };
    }
    const extracted = canonicalImageItems(extractedItems);
    const existing = current.medications || [];
    const normalizedExisting = existing.map(normalizeMedication);
    const normalizedExtracted = extracted.map(normalizeMedication);
    const matched = matchNormalized(normalizedExisting, normalizedExtracted);
    const duplicateStableIds = new Map();
    const duplicateNames = new Map();
    normalizedExtracted.forEach((item, index) => {
      const stable = item.normalized.stableMedicationId;
      const name = item.normalized.name;
      if (stable) duplicateStableIds.set(stable, [...(duplicateStableIds.get(stable) || []), index]);
      if (name) duplicateNames.set(name, [...(duplicateNames.get(name) || []), index]);
    });
    for (const indexes of [...duplicateStableIds.values(), ...duplicateNames.values()]) {
      if (indexes.length > 1) matched.warnings.push({ code:'DUPLICATE_EXTRACTED_MEDICATION', indexes });
    }
    const proposals = [];
    for (const pair of matched.pairs) {
      const before = existing[pair.previousIndex];
      const after = extracted[pair.currentIndex];
      const diff = medicationSetDiff([before], [after]);
      proposals.push({
        classification:diff.changes[0]?.category === 'strength_changed' ? 'CHANGED_STRENGTH'
          : diff.changes[0]?.category === 'instruction_changed' ? 'CHANGED_INSTRUCTION'
            : diff.changes.length ? 'CHANGED_MULTIPLE_FIELDS' : 'UNCHANGED',
        currentIndex:pair.previousIndex, extractedIndex:pair.currentIndex,
        current:before, extracted:after, ambiguous:false,
      });
    }
    for (const index of matched.unmatchedCurrent) proposals.push({
      classification:'NEW', currentIndex:null, extractedIndex:index,
      current:null, extracted:extracted[index], ambiguous:false,
    });
    const ambiguousIndexes = new Set(matched.warnings.flatMap((warning) => warning.indexes || []));
    for (const warning of matched.warnings) proposals.push({
      classification:'AMBIGUOUS', currentIndex:null, extractedIndex:null,
      current:null, extracted:null, ambiguous:true, reasonCode:warning.code,
    });
    return { baseSnapshotId:current.currentSnapshot?.snapshotId || null, current, extracted,
      proposals:proposals.map((proposal) => proposal.extractedIndex !== null && ambiguousIndexes.has(proposal.extractedIndex)
        ? { ...proposal, classification:'AMBIGUOUS', ambiguous:true, reasonCode:'DUPLICATE_EXTRACTED_MEDICATION' }
        : proposal) };
  }

  return { getCurrent, saveCompleteSet, proposeImageMerge };
}

const defaultService = createMedicationCurrentSetService();

module.exports = {
  MAX_MEDICATIONS, FIELD_LIMITS, MedicationCurrentSetError,
  canonicalMedication, validateCompleteSet, canonicalImageItems, medicationSetDiff, safeSourceLabel,
  safeCurrentProjection, createMedicationCurrentSetService,
  getCurrent:defaultService.getCurrent,
  saveCompleteSet:defaultService.saveCompleteSet,
  proposeImageMerge:defaultService.proposeImageMerge,
};
