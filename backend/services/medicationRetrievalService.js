const { MedicationSnapshots, Medications } = require('../db');
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
  return {
    medicationId: record.medication_id || record.medicationId || null,
    stableMedicationId: record.stable_medication_id || record.catalog_medication_id || record.rx_norm_id || null,
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
  };
}

function snapshotMetadata(snapshot) {
  return {
    snapshotId: snapshot.snapshot_id,
    recordedAt: snapshot.recorded_at || snapshot._createdAt || null,
    source: snapshot.source || null,
  };
}

async function loadSnapshotMedications(snapshot) {
  const linked = await Medications.findWhere((record) =>
    record.snapshot_id === snapshot.snapshot_id && record.care_profile_id === snapshot.care_profile_id
  );
  if (linked.length > 0) {
    return { medicationSource: 'linked_records', medications: linked.map(projectMedication).filter((item) => item.name) };
  }
  // Explicit compatibility path for legacy snapshots which embedded items
  // before linked medication rows were consistently created.
  const embedded = Array.isArray(snapshot.items) ? snapshot.items : [];
  return {
    medicationSource: embedded.length > 0 ? 'snapshot_embedded_items' : 'snapshot_without_medications',
    medications: embedded.map(projectMedication).filter((item) => item.name),
  };
}

async function loadCurrentSnapshot(careProfileId) {
  const snapshots = await MedicationSnapshots.findWhere(
    (snapshot) => snapshot.care_profile_id === careProfileId && isEligibleCurrentSnapshot(snapshot)
  );
  const snapshotTime = (snapshot) => timestamp(snapshot.recorded_at) || timestamp(snapshot._createdAt);
  const latest = [...snapshots].sort((a, b) => snapshotTime(b) - snapshotTime(a))[0] || null;
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
    })),
  };
}

module.exports = {
  EXCLUDED_CURRENT_STATUSES, MedicationRetrievalError,
  isEligibleCurrentSnapshot, projectMedication, snapshotMetadata,
  loadSnapshotMedications, loadCurrentSnapshot,
  getCurrentMedicationSnapshot, getMedicationInstructions,
};
