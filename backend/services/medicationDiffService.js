const { MedicationSnapshots } = require('../db');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const {
  isEligibleCurrentSnapshot, loadSnapshotMedications, snapshotMetadata, listEligibleSnapshots,
} = require('./medicationRetrievalService');

class MedicationDiffError extends Error {
  constructor(code) {
    super('ไม่สามารถเปรียบเทียบรายการยาที่ร้องขอได้');
    this.name = 'MedicationDiffError';
    this.code = code;
    this.status = code === 'SNAPSHOT_NOT_FOUND' ? 404 : 400;
  }
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function normalizeUnits(value) {
  return normalizeText(value)
    .replace(/\bmilligrams?\b|มิลลิกรัม|มก\.?/gi, 'mg')
    .replace(/\bmillilit(?:er|re)s?\b|มิลลิลิตร|มล\.?/gi, 'ml')
    .replace(/\bgrams?\b|กรัม/gi, 'g')
    .replace(/\s+/g, ' ').trim();
}

function extractNameAndStrength(item) {
  const fullName = normalizeUnits(item.name);
  let strength = normalizeUnits(item.strength);
  let name = fullName;
  if (!strength) {
    const match = fullName.match(/(\d+(?:[.,]\d+)?)\s*(mg|ml|g)(?=\s|$)/i);
    if (match) {
      strength = `${match[1].replace(',', '.')} ${match[2].toLowerCase()}`;
      name = `${fullName.slice(0, match.index)} ${fullName.slice(match.index + match[0].length)}`.replace(/[()\[\],-]+/g, ' ');
    }
  }
  return { name: normalizeText(name), strength: normalizeUnits(strength) };
}

function parseDoseAndInstruction(item) {
  const structuredDose = item.amount !== null && item.amount !== undefined
    ? `${normalizeText(item.amount)} ${normalizeUnits(item.unit)}`.trim() : '';
  const structuredInstruction = [item.frequency, item.timing, item.route].some((value) => value !== null && value !== undefined && String(value).trim());
  if (structuredDose || structuredInstruction) {
    return {
      dose: structuredDose || normalizeUnits(item.dose),
      instruction: [item.frequency, item.timing, item.route].map(normalizeUnits).filter(Boolean).join(' | '),
      source: 'structured',
    };
  }
  const rawDose = normalizeUnits(item.dose);
  const explicitInstruction = normalizeUnits(item.instruction);
  if (explicitInstruction) return { dose: rawDose, instruction: explicitInstruction, source: 'text' };
  const match = rawDose.match(/^(.*?\d+(?:[.,]\d+)?\s*(?:เม็ด|tablet(?:s)?|แคปซูล|capsule(?:s)?|mg|ml|g))(?:\s+)(.+)$/i);
  if (!match) return { dose: rawDose, instruction: '', source: 'text' };
  return { dose: normalizeUnits(match[1]), instruction: normalizeUnits(match[2]), source: 'text' };
}

function normalizeMedication(item) {
  const nameAndStrength = extractNameAndStrength(item);
  const doseAndInstruction = parseDoseAndInstruction(item);
  return {
    original: {
      medicationId: item.medicationId, stableMedicationId: item.stableMedicationId,
      name: item.name, strength: item.strength, dose: item.dose, instruction: item.instruction,
      amount: item.amount, unit: item.unit, frequency: item.frequency, timing: item.timing, route: item.route,
    },
    normalized: {
      stableMedicationId: normalizeText(item.stableMedicationId),
      name: nameAndStrength.name,
      strength: nameAndStrength.strength,
      dose: doseAndInstruction.dose,
      instruction: doseAndInstruction.instruction,
      instructionSource: doseAndInstruction.source,
    },
  };
}

function groupIndexes(items, indexes, keyFn) {
  const groups = new Map();
  for (const index of indexes) {
    const key = keyFn(items[index]);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  }
  return groups;
}

function matchNormalized(previous, current) {
  const unmatchedPrevious = new Set(previous.map((_, index) => index));
  const unmatchedCurrent = new Set(current.map((_, index) => index));
  const pairs = [];
  const warnings = [];

  function matchUnique(strategy, keyFn, { pairDuplicates = false, compatible = null } = {}) {
    const previousGroups = groupIndexes(previous, unmatchedPrevious, keyFn);
    const currentGroups = groupIndexes(current, unmatchedCurrent, keyFn);
    for (const [key, previousIndexes] of previousGroups) {
      const currentIndexes = currentGroups.get(key) || [];
      if (currentIndexes.length === 0) continue;
      if (!pairDuplicates && (previousIndexes.length !== 1 || currentIndexes.length !== 1)) {
        warnings.push({ code: 'AMBIGUOUS_MEDICATION_MATCH', strategy, key, previousCount: previousIndexes.length, currentCount: currentIndexes.length });
        continue;
      }
      if (!pairDuplicates && compatible
        && !compatible(previous[previousIndexes[0]], current[currentIndexes[0]])) {
        warnings.push({ code: 'AMBIGUOUS_TRUSTED_IDENTIFIER', strategy, key,
          previousCount: previousIndexes.length, currentCount: currentIndexes.length });
        continue;
      }
      if (pairDuplicates && (previousIndexes.length > 1 || currentIndexes.length > 1)) {
        warnings.push({ code: 'DUPLICATE_EXACT_MEDICATION', strategy, key, previousCount: previousIndexes.length, currentCount: currentIndexes.length });
      }
      const count = pairDuplicates ? Math.min(previousIndexes.length, currentIndexes.length) : 1;
      for (let offset = 0; offset < count; offset += 1) {
        const previousIndex = previousIndexes[offset];
        const currentIndex = currentIndexes[offset];
        pairs.push({ previousIndex, currentIndex, strategy, key });
        unmatchedPrevious.delete(previousIndex);
        unmatchedCurrent.delete(currentIndex);
      }
    }
  }

  matchUnique('stable_identifier', (item) => item.normalized.stableMedicationId, { pairDuplicates: false });
  matchUnique('exact_name', (item) => item.normalized.name, {
    pairDuplicates: false,
    compatible: (before, after) => !before.normalized.stableMedicationId
      || !after.normalized.stableMedicationId
      || before.normalized.stableMedicationId === after.normalized.stableMedicationId,
  });

  return { pairs, unmatchedPrevious, unmatchedCurrent, warnings };
}

function changeEntry(pair, previous, current) {
  return { match: { strategy: pair.strategy, key: pair.key }, previous, current };
}

async function compareMedicationSnapshots({ previousSnapshotId, currentSnapshotId, requester, careProfileId } = {}) {
  await authorizeCareProfileAccess({
    lineUserId: requester?.lineUserId, careProfileId, permission: 'view',
    centerId: requester?.centerId || null,
    requireActiveCenter: requester?.requireActiveCenter !== false,
  });
  const snapshots = await MedicationSnapshots.findWhere((snapshot) =>
    snapshot.care_profile_id === careProfileId && [previousSnapshotId, currentSnapshotId].includes(snapshot.snapshot_id)
  );
  const previousSnapshot = snapshots.find((item) => item.snapshot_id === previousSnapshotId);
  const currentSnapshot = snapshots.find((item) => item.snapshot_id === currentSnapshotId);
  if (!previousSnapshot || !currentSnapshot) throw new MedicationDiffError('SNAPSHOT_NOT_FOUND');
  if (!isEligibleCurrentSnapshot(previousSnapshot) || !isEligibleCurrentSnapshot(currentSnapshot)) {
    throw new MedicationDiffError('SNAPSHOT_NOT_COMPARABLE');
  }
  const previousLoaded = await loadSnapshotMedications(previousSnapshot);
  const currentLoaded = await loadSnapshotMedications(currentSnapshot);
  const previous = previousLoaded.medications.map(normalizeMedication);
  const current = currentLoaded.medications.map(normalizeMedication);
  const matched = matchNormalized(previous, current);
  const output = {
    added: [...matched.unmatchedCurrent].map((index) => current[index]),
    removed: [...matched.unmatchedPrevious].map((index) => previous[index]),
    strengthChanged: [], doseChanged: [], instructionChanged: [], multipleFieldsChanged: [],
    unchanged: [], warnings: matched.warnings,
    previousSnapshot: { ...snapshotMetadata(previousSnapshot), medicationSource: previousLoaded.medicationSource },
    currentSnapshot: { ...snapshotMetadata(currentSnapshot), medicationSource: currentLoaded.medicationSource },
  };
  for (const pair of matched.pairs) {
    const before = previous[pair.previousIndex];
    const after = current[pair.currentIndex];
    const strengthChanged = before.normalized.strength !== after.normalized.strength;
    const doseChanged = before.normalized.dose !== after.normalized.dose;
    const instructionChanged = before.normalized.instruction !== after.normalized.instruction;
    const entry = changeEntry(pair, before, after);
    const count = [strengthChanged, doseChanged, instructionChanged].filter(Boolean).length;
    if (strengthChanged) output.strengthChanged.push(entry);
    if (doseChanged || strengthChanged) output.doseChanged.push(entry); // compatibility projection
    if (instructionChanged) output.instructionChanged.push(entry);
    if (count > 1) output.multipleFieldsChanged.push(entry);
    if (count === 0) output.unchanged.push(entry);
  }
  return output;
}

function snapshotTime(snapshot) {
  const value = new Date(snapshot?.recorded_at || snapshot?._createdAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

async function compareLatestMedicationSnapshots({ requester, careProfileId } = {}) {
  await authorizeCareProfileAccess({
    lineUserId: requester?.lineUserId, careProfileId, permission: 'view',
    centerId: requester?.centerId || null,
    requireActiveCenter: requester?.requireActiveCenter !== false,
  });
  const ordered = await listEligibleSnapshots(careProfileId, 2);
  if (ordered.length < 2) {
    return { status: 'NOT_AVAILABLE', reasonCode: 'PREVIOUS_SNAPSHOT_NOT_FOUND' };
  }
  return {
    status: 'AVAILABLE',
    diff: await compareMedicationSnapshots({
      previousSnapshotId: ordered[1].snapshot_id,
      currentSnapshotId: ordered[0].snapshot_id,
      requester,
      careProfileId,
    }),
  };
}

module.exports = {
  MedicationDiffError, normalizeText, normalizeUnits, extractNameAndStrength,
  parseDoseAndInstruction, normalizeMedication, matchNormalized,
  compareMedicationSnapshots, compareLatestMedicationSnapshots,
};
