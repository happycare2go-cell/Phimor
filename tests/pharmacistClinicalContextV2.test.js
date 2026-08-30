const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VITAL_WINDOW_DAYS, MAX_VITAL_SETS, MAX_VITAL_OBSERVATIONS,
  boundedVitals, latestVitalFacts, createPharmacistClinicalContextService,
} = require('../backend/services/pharmacistClinicalContextService');

const observation = (measurementType, numericValue, canonicalUnit = '') => ({ measurementType, numericValue, canonicalUnit });
const set = (occurredAt, observations, overrides = {}) => ({ occurredAt, observations, sourceType:'native', ...overrides });

test('pharmacist context carries exact current medication fields and one version marker', async () => {
  const current = { status:'CURRENT_SNAPSHOT', currentSnapshot:{snapshotId:'S-2',versionNo:2,recordedAt:'2026-08-30T01:00:00Z'},
    medications:[{name:'Aspirin',strength:'325 mg',dose:'1 เม็ด',instruction:'หลังอาหาร',amount:'1',unit:'เม็ด',frequency:'วันละครั้ง',timing:'เช้า',route:'รับประทาน',condition:'ตามฉลาก'}] };
  const service = createPharmacistClinicalContextService({
    loadMedication:async () => current,
    getMedicationHistory:async () => ({items:[{kind:'semantic_changes',snapshot:{recordedAt:'2026-08-30T01:00:00Z'}}]}),
    listVitals:async () => ({items:[]}),
  });
  const result = await service.getContext({careProfileId:'CP-1',customerLineUserId:'U-FAMILY',now:new Date('2026-08-31T01:00:00Z')});
  assert.deepEqual(result.currentMedications, current.medications);
  assert.equal(result.medicationSnapshot.snapshotId, 'S-2');
  assert.equal(result.contextVersion.medicationSnapshotId, 'S-2');
  assert.equal(result.recentMedicationChanges.length, 1);
});

test('Vital query uses exactly a seven-day window and bounded request', async () => {
  let input;
  const service = createPharmacistClinicalContextService({
    loadMedication:async () => ({medications:[],currentSnapshot:null}),
    getMedicationHistory:async () => ({items:[]}),
    listVitals:async (value) => { input=value; return {items:[]}; },
  });
  await service.getContext({careProfileId:'CP-1',customerLineUserId:'U-FAMILY',now:new Date('2026-08-31T00:00:00Z')});
  assert.equal(new Date(input.to)-new Date(input.from), VITAL_WINDOW_DAYS*86400000);
  assert.equal(input.limit, MAX_VITAL_SETS);
  assert.equal(input.careProfileId, 'CP-1');
});

test('Vital context is capped at five sets and twenty observations', () => {
  const rows = Array.from({length:8}, (_, setIndex) => set(`2026-08-${30-setIndex}T00:00:00Z`,
    Array.from({length:4}, (_, observationIndex) => observation(`type-${setIndex}-${observationIndex}`, observationIndex))));
  const result = boundedVitals(rows);
  assert.equal(result.length, MAX_VITAL_SETS);
  assert.equal(result.flatMap((item) => item.observations).length, MAX_VITAL_OBSERVATIONS);
});

test('latest temperature pulse SpO2 are independent but blood pressure pair comes from one set', () => {
  const rows = boundedVitals([
    set('2026-08-31T02:00:00Z', [observation('temperature',37,'°C'),observation('blood_pressure_systolic',130,'mmHg')]),
    set('2026-08-31T01:00:00Z', [observation('blood_pressure_systolic',120,'mmHg'),observation('blood_pressure_diastolic',80,'mmHg'),observation('pulse',72,'bpm')]),
    set('2026-08-31T00:00:00Z', [observation('blood_pressure_diastolic',70,'mmHg'),observation('spo2',98,'%')]),
  ]);
  const latest = latestVitalFacts(rows);
  assert.equal(latest.temperature.numericValue, 37);
  assert.equal(latest.bloodPressure.systolic.numericValue, 120);
  assert.equal(latest.bloodPressure.diastolic.numericValue, 80);
  assert.equal(latest.bloodPressure.occurredAt, '2026-08-31T01:00:00Z');
  assert.equal(latest.pulse.numericValue, 72);
  assert.equal(latest.spo2.numericValue, 98);
});

test('linked finalized Health Report and authoritative standalone Vital retain factual source marker', async () => {
  const rows = [
    set('2026-08-31T02:00:00Z',[observation('temperature',36.8,'°C')],{linkedDailyReportId:'D-1',sourceType:'external'}),
    set('2026-08-31T01:00:00Z',[observation('pulse',70,'bpm')],{sourceType:'native'}),
  ];
  const result = boundedVitals(rows);
  assert.equal(result[0].linkedHealthReport, true);
  assert.equal(result[0].sourceType, 'external');
  assert.equal(result[1].linkedHealthReport, false);
});

test('explicit refresh obtains newer medication version and does not retain old object', async () => {
  let version = 1;
  const service = createPharmacistClinicalContextService({
    loadMedication:async () => ({currentSnapshot:{snapshotId:`S-${version}`,versionNo:version,recordedAt:'2026-08-31T00:00:00Z'},
      medications:[{name:'Drug',strength:`${version} mg`,dose:'',instruction:''}]}),
    getMedicationHistory:async () => ({items:[]}), listVitals:async () => ({items:[]}),
  });
  const first = await service.getContext({careProfileId:'CP-1',customerLineUserId:'U'});
  version = 2;
  const second = await service.getContext({careProfileId:'CP-1',customerLineUserId:'U'});
  assert.equal(first.contextVersion.medicationVersionNo, 1);
  assert.equal(second.contextVersion.medicationVersionNo, 2);
  assert.equal(second.currentMedications[0].strength, '2 mg');
});
