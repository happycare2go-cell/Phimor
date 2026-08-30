const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const {
  loadSnapshotMedications, snapshotMetadata, listEligibleSnapshots,
} = require('./medicationRetrievalService');
const { medicationSetDiff, safeSourceLabel } = require('./medicationCurrentSetService');

function safeMedication(item = {}) {
  return {
    name:item.name || '', strength:item.strength || '', dose:item.dose || '',
    instruction:item.instruction || '', amount:item.amount ?? null, unit:item.unit ?? null,
    frequency:item.frequency ?? null, timing:item.timing ?? null, route:item.route ?? null,
    condition:item.condition || '',
  };
}

function safeChange(change, previous, current) {
  return {
    category:change.category,
    previous:change.previousIndex === undefined ? null : safeMedication(previous[change.previousIndex]),
    current:change.currentIndex === undefined ? null : safeMedication(current[change.currentIndex]),
    changedFields:change.changedFields || [],
  };
}

function createMedicationChangeHistoryService(overrides = {}) {
  const authorize = overrides.authorize || authorizeCareProfileAccess;
  async function getHistory({ careProfileId, requester, limit = 50 } = {}) {
    await authorize({ lineUserId:requester?.lineUserId, careProfileId, permission:'view',
      centerId:requester?.centerId || null, requireActiveCenter:true });
    const bounded = Math.min(Math.max(Number(limit) || 50, 1), 501);
    const snapshots = (await listEligibleSnapshots(careProfileId, bounded + 1)).reverse();
    const items = [];
    for (let index = 0; index < snapshots.length; index += 1) {
      const currentSnapshot = snapshots[index];
      const currentLoaded = await loadSnapshotMedications(currentSnapshot);
      if (index === 0) {
        if (Number(currentSnapshot.schema_version || 0) >= 2) {
          items.push({ kind:'semantic_changes', snapshot:snapshotMetadata(currentSnapshot),
            sourceLabel:safeSourceLabel(currentSnapshot.source),
            changes:currentLoaded.medications.map((item) => ({ category:'added', previous:null,
              current:safeMedication(item), changedFields:[] })) });
        } else {
          items.push({ kind:'legacy_snapshot', snapshot:snapshotMetadata(currentSnapshot),
            sourceLabel:safeSourceLabel(currentSnapshot.source), medications:currentLoaded.medications.map(safeMedication) });
        }
        continue;
      }
      const previousLoaded = await loadSnapshotMedications(snapshots[index - 1]);
      const diff = medicationSetDiff(previousLoaded.medications, currentLoaded.medications);
      if (diff.warnings.length || Number(currentSnapshot.schema_version || 0) < 2) {
        items.push({ kind:'legacy_snapshot', snapshot:snapshotMetadata(currentSnapshot),
          sourceLabel:safeSourceLabel(currentSnapshot.source), medications:currentLoaded.medications.map(safeMedication) });
        continue;
      }
      const changes = diff.changes.map((change) => safeChange(change, previousLoaded.medications, currentLoaded.medications));
      if (changes.length) items.push({ kind:'semantic_changes', snapshot:snapshotMetadata(currentSnapshot),
        sourceLabel:safeSourceLabel(currentSnapshot.source), changes });
    }
    return { items:items.reverse().slice(0, bounded), nextCursor:null };
  }
  return { getHistory };
}

const defaultService = createMedicationChangeHistoryService();
module.exports = { safeMedication, createMedicationChangeHistoryService, getHistory:defaultService.getHistory };
