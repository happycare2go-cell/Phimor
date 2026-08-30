const { loadCurrentSnapshot } = require('./medicationRetrievalService');
const medicationChangeHistoryService = require('./medicationChangeHistoryService');
const { vitalSignService } = require('./vitalSignService');

const VITAL_WINDOW_DAYS = 7;
const MAX_VITAL_SETS = 5;
const MAX_VITAL_OBSERVATIONS = 20;

function boundedVitals(items = []) {
  let remaining = MAX_VITAL_OBSERVATIONS;
  return items.slice(0, MAX_VITAL_SETS).map((set) => {
    const observations = (set.observations || []).slice(0, remaining).map((item) => ({
      measurementType:item.measurementType, numericValue:item.numericValue,
      canonicalUnit:item.canonicalUnit, context:item.context || null,
    }));
    remaining -= observations.length;
    return Object.freeze({ occurredAt:set.occurredAt, linkedHealthReport:Boolean(set.linkedDailyReportId),
      sourceType:set.sourceType, observations:Object.freeze(observations) });
  }).filter((set) => set.observations.length);
}

function latestVitalFacts(sets = []) {
  const first = (type) => {
    for (const set of sets) {
      const observation = set.observations.find((item) => item.measurementType === type);
      if (observation) return Object.freeze({ ...observation, occurredAt:set.occurredAt });
    }
    return null;
  };
  let bloodPressure = null;
  for (const set of sets) {
    const systolic = set.observations.find((item) => item.measurementType === 'blood_pressure_systolic');
    const diastolic = set.observations.find((item) => item.measurementType === 'blood_pressure_diastolic');
    if (systolic && diastolic) {
      bloodPressure = Object.freeze({ systolic, diastolic, occurredAt:set.occurredAt });
      break;
    }
  }
  return Object.freeze({
    temperature:first('temperature'), bloodPressure,
    pulse:first('pulse'), spo2:first('spo2'),
  });
}

function createPharmacistClinicalContextService({
  loadMedication = loadCurrentSnapshot,
  getMedicationHistory = medicationChangeHistoryService.getHistory,
  listVitals = (input) => vitalSignService.listHistory(input),
} = {}) {
  async function getContext({ careProfileId, customerLineUserId, now = new Date() } = {}) {
    const reference = new Date(now);
    const from = new Date(reference.getTime() - VITAL_WINDOW_DAYS * 86400000).toISOString();
    const to = reference.toISOString();
    const [medication, history, vitalResult] = await Promise.all([
      loadMedication(careProfileId),
      getMedicationHistory({ careProfileId, requester:{ lineUserId:customerLineUserId }, limit:6 }),
      listVitals({ lineUserId:customerLineUserId, careProfileId, from, to, limit:MAX_VITAL_SETS }),
    ]);
    const recentVitals = boundedVitals(vitalResult.items || []);
    return Object.freeze({
      currentMedications:Object.freeze((medication.medications || []).map((item) => Object.freeze({ ...item }))),
      medicationSnapshot:Object.freeze({
        snapshotId:medication.currentSnapshot?.snapshotId || null,
        versionNo:medication.currentSnapshot?.versionNo || null,
        recordedAt:medication.currentSnapshot?.recordedAt || null,
      }),
      recentMedicationChanges:Object.freeze((history.items || []).slice(0, 5)),
      recentVitals:Object.freeze(recentVitals), latestVitals:latestVitalFacts(recentVitals),
      contextVersion:Object.freeze({
        medicationSnapshotId:medication.currentSnapshot?.snapshotId || null,
        medicationVersionNo:medication.currentSnapshot?.versionNo || null,
        latestVitalOccurredAt:recentVitals[0]?.occurredAt || null,
      }),
    });
  }
  return { getContext };
}

module.exports = {
  VITAL_WINDOW_DAYS, MAX_VITAL_SETS, MAX_VITAL_OBSERVATIONS,
  boundedVitals, latestVitalFacts, createPharmacistClinicalContextService,
};
