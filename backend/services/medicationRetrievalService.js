const { MedicationSnapshots, Medications, databaseQuery } = require('../db');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');

const EXCLUDED_CURRENT_STATUSES = new Set([
  'cancelled', 'revoked', 'deleted', 'invalid', 'superseded', 'old', 'archived', 'inactive',
]);

class MedicationRetrievalError extends Error {
  constructor(code) {
    super('ไม่สามารถอ่านข้อมูลยาที่ร้องขอได้');
    this.name = 'MedicationRetrievalError';
    this.code = code;
    this.status = code === 'MEDICATION_NOT_FOUND' ? 404 : 400;
  }
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isEligibleCurrentSnapshot(snapshot) {
  return snapshot && !EXCLUDED_CURRENT_STATUSES.has(String(snapshot.status || '').toLowerCase());
}

function projectMedication(record = {}) {
  const structured = record.instruction && typeof record.instruction === 'object' ? record.instruction : {};
  const rawDayPeriods = record.dayPeriods ?? record.day_periods ?? structured.dayPeriods ?? structured.day_periods;
  return {
    medicationId: record.medication_id || record.medicationId || null,
    stableMedicationId: record.stable_medication_id || record.stableMedicationId
      || record.catalog_medication_id || record.rx_norm_id || null,
    name: typeof record.name === 'string' ? record.name : '',
    strength: typeof record.strength === 'string' ? record.strength : '',
    dose: typeof record.dose === 'string' ? record.dose : '',
    instruction: typeof record.instruction === 'string' ? record.instruction : (typeof record.note === 'string' ? record.note : ''),
    amount: record.amount ?? structured.amount ?? null,
    unit: record.unit ?? structured.unit ?? null,
    frequency: record.frequency ?? structured.frequency ?? null,
    timing: record.timing ?? structured.timing ?? null,
    route: record.route ?? structured.route ?? null,
    condition: typeof record.condition === 'string' ? record.condition : '',
    indication: typeof record.indication === 'string' ? record.indication : '',
    useCondition: record.useCondition ?? record.use_condition ?? structured.useCondition ?? structured.use_condition ?? null,
    dayPeriods: Array.isArray(rawDayPeriods) ? [...rawDayPeriods] : [],
    notes: typeof record.notes === 'string' ? record.notes : '',
  };
}

function snapshotMetadata(snapshot) {
  return {
    snapshotId: snapshot.snapshot_id,
    schemaVersion: Number.isSafeInteger(Number(snapshot.schema_version)) ? Number(snapshot.schema_version) : null,
    versionNo: Number.isSafeInteger(Number(snapshot.version_no)) ? Number(snapshot.version_no) : null,
    recordedAt: snapshot.recorded_at || snapshot._createdAt || null,
    source: snapshot.source || null,
    sourceActorType: snapshot.source_actor_type || null,
  };
}

function snapshotVersion(snapshot) {
  const value = Number(snapshot?.version_no);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function compareSnapshotAuthority(left, right) {
  const version = snapshotVersion(right) - snapshotVersion(left);
  if (version) return version;
  const time = (timestamp(right?.recorded_at) || timestamp(right?._createdAt))
    - (timestamp(left?.recorded_at) || timestamp(left?._createdAt));
  if (time) return time;
  return String(right?.snapshot_id || '').localeCompare(String(left?.snapshot_id || ''), 'en');
}

async function loadSnapshotMedications(snapshot) {
  const linked = await Medications.findWhere((record) =>
    record.snapshot_id === snapshot.snapshot_id && record.care_profile_id === snapshot.care_profile_id
  );
  const embedded = Array.isArray(snapshot.items) ? snapshot.items : [];
  if (linked.length > 0) {
    // V2 snapshots persist the same complete set both in the immutable
    // snapshot and in linked rows. If legacy/manual corruption left only a
    // subset of linked rows, never let that subset hide the complete snapshot.
    // The read-only production preflight still reports the mismatch for
    // controlled operator review.
    if (Number(snapshot.schema_version || 0) >= 2 && embedded.length > linked.length) {
      return { medicationSource:'snapshot_embedded_items_partial_link_recovery',
        medications:embedded.map(projectMedication).filter((item) => item.name) };
    }
    return { medicationSource: 'linked_records', medications: linked.map(projectMedication).filter((item) => item.name) };
  }
  // Explicit compatibility path for legacy snapshots which embedded items
  // before linked medication rows were consistently created.
  return {
    medicationSource: embedded.length > 0 ? 'snapshot_embedded_items' : 'snapshot_without_medications',
    medications: embedded.map(projectMedication).filter((item) => item.name),
  };
}

async function findAuthoritativeSnapshot(careProfileId) {
  if (process.env.NODE_ENV !== 'test') {
    // Numbered V2 snapshots always outrank versionless legacy rows. This query
    // keeps ordinary current-list reads bounded after a profile enters V2.
    const result = await databaseQuery(`SELECT data FROM "medicationSnapshots"
      WHERE data->>'care_profile_id'=$1
        AND lower(COALESCE(data->>'status','active')) <> ALL($2::text[])
        AND COALESCE(data->>'version_no','') ~ '^[1-9][0-9]*$'
      ORDER BY (data->>'version_no')::bigint DESC,
        NULLIF(data->>'recorded_at','')::timestamptz DESC NULLS LAST,
        data->>'snapshot_id' DESC
      LIMIT 1`, [careProfileId, [...EXCLUDED_CURRENT_STATUSES]]);
    if (result.rows[0]?.data) return result.rows[0].data;
  }
  const candidates = MedicationSnapshots.findWhereByField
    ? await MedicationSnapshots.findWhereByField('care_profile_id', careProfileId)
    : await MedicationSnapshots.findWhere((snapshot) => snapshot.care_profile_id === careProfileId);
  return candidates.filter(isEligibleCurrentSnapshot).sort(compareSnapshotAuthority)[0] || null;
}

async function listEligibleSnapshots(careProfileId, limit = 50) {
  const bounded = Math.min(Math.max(Number(limit) || 50, 1), 502);
  if (process.env.NODE_ENV !== 'test') {
    const result = await databaseQuery(`SELECT data FROM "medicationSnapshots"
      WHERE data->>'care_profile_id'=$1
        AND lower(COALESCE(data->>'status','active')) <> ALL($2::text[])
      ORDER BY CASE WHEN COALESCE(data->>'version_no','') ~ '^[1-9][0-9]*$'
        THEN (data->>'version_no')::bigint ELSE 0 END DESC,
        created_at DESC, data->>'snapshot_id' DESC
      LIMIT $3`, [careProfileId, [...EXCLUDED_CURRENT_STATUSES], bounded]);
    return result.rows.map((row) => row.data).sort(compareSnapshotAuthority);
  }
  const candidates = MedicationSnapshots.findWhereByField
    ? await MedicationSnapshots.findWhereByField('care_profile_id', careProfileId)
    : await MedicationSnapshots.findWhere((snapshot) => snapshot.care_profile_id === careProfileId);
  return candidates.filter(isEligibleCurrentSnapshot).sort(compareSnapshotAuthority).slice(0, bounded);
}

async function loadCurrentSnapshot(careProfileId) {
  const latest = await findAuthoritativeSnapshot(careProfileId);
  if (!latest) {
    return { status: 'NO_CURRENT_SNAPSHOT', currentSnapshot: null, medicationSource: 'none', medications: [] };
  }
  const loaded = await loadSnapshotMedications(latest);
  return { status: 'CURRENT_SNAPSHOT', currentSnapshot: snapshotMetadata(latest), ...loaded };
}

async function getCurrentMedicationSnapshot({ careProfileId, requester } = {}) {
  await authorizeCareProfileAccess({
    lineUserId: requester?.lineUserId, careProfileId, permission: 'view',
    centerId: requester?.centerId || null,
    requireActiveCenter: requester?.requireActiveCenter !== false,
  });
  return loadCurrentSnapshot(careProfileId);
}

async function getMedicationInstructions({ careProfileId, requester, medicationId = null } = {}) {
  const current = await getCurrentMedicationSnapshot({ careProfileId, requester });
  if (current.status !== 'CURRENT_SNAPSHOT') return { ...current, instructions: [] };
  const selected = medicationId
    ? current.medications.filter((item) => item.medicationId === medicationId || item.stableMedicationId === medicationId)
    : current.medications;
  if (medicationId && selected.length === 0) throw new MedicationRetrievalError('MEDICATION_NOT_FOUND');
  return {
    status: current.status,
    currentSnapshot: current.currentSnapshot,
    medicationSource: current.medicationSource,
    instructions: selected.map((item) => ({
      medicationId: item.medicationId,
      stableMedicationId: item.stableMedicationId,
      name: item.name,
      strength: item.strength,
      dose: item.dose,
      instruction: item.instruction,
      amount: item.amount,
      unit: item.unit,
      frequency: item.frequency,
      timing: item.timing,
      route: item.route,
      indication: item.indication,
      useCondition: item.useCondition,
      dayPeriods: item.dayPeriods,
      notes: item.notes,
      condition: item.condition,
    })),
  };
}

module.exports = {
  EXCLUDED_CURRENT_STATUSES, MedicationRetrievalError,
  isEligibleCurrentSnapshot, projectMedication, snapshotMetadata,
  snapshotVersion, compareSnapshotAuthority,
  loadSnapshotMedications, findAuthoritativeSnapshot, listEligibleSnapshots, loadCurrentSnapshot,
  getCurrentMedicationSnapshot, getMedicationInstructions,
};
