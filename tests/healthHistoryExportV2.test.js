const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_EXPORT_DAYS, MAX_SECTION_ENTRIES, HealthHistoryExportError,
  exportRange, createHealthHistoryExportService,
} = require('../backend/services/healthHistoryExportService');

function service(overrides = {}) {
  return createHealthHistoryExportService({
    appointments:{findWhere:async () => overrides.appointments || []},
    loadCurrentMedication:async () => overrides.currentMedication || ({currentSnapshot:null,medications:[]}),
    medicationHistory:{getHistory:async () => ({items:overrides.medicationHistory || []})},
    dailyRepository:{listHistory:async () => overrides.healthReports || []},
    vitalRepository:{
      listStandaloneHistory:async () => overrides.standaloneVitals || [],
      listHistory:async () => { throw new Error('linked-inclusive query must not be used for PDF standalone section'); },
    },
    now:() => new Date('2026-08-31T12:00:00Z'),
  });
}

test('current medication remains included even when established before requested history range', async () => {
  const result = await service({currentMedication:{currentSnapshot:{snapshotId:'S-1',recordedAt:'2020-01-01T00:00:00Z'},
    medications:[{name:'Current drug',strength:'5 mg',instruction:'หลังอาหาร'}]}})
    .build({careProfileId:'CP-1',fromDate:'2026-08-01',toDate:'2026-08-31'});
  assert.equal(result.currentMedications[0].name, 'Current drug');
  assert.equal(result.currentMedicationSnapshot.snapshotId, 'S-1');
});

test('history sections are date-filtered and standalone Vital excludes linked report Vital by query contract', async () => {
  const result = await service({
    appointments:[
      {appointment_id:'A-IN',care_profile_id:'CP-1',datetime:'2026-08-10T00:00:00Z'},
      {appointment_id:'A-OUT',care_profile_id:'CP-1',datetime:'2025-08-10T00:00:00Z'},
    ],
    medicationHistory:[
      {snapshot:{recordedAt:'2026-08-12T00:00:00Z'},kind:'semantic_changes'},
      {snapshot:{recordedAt:'2025-08-12T00:00:00Z'},kind:'semantic_changes'},
    ],
    healthReports:[{daily_report_id:'D-1',occurred_at:'2026-08-13T00:00:00Z',vital_signs:[{vital_set_id:'V-LINK'}]}],
    standaloneVitals:[{vital_set_id:'V-STANDALONE',occurred_at:'2026-08-14T00:00:00Z',observations:[]}],
  }).build({careProfileId:'CP-1',fromDate:'2026-08-01',toDate:'2026-08-31'});
  assert.deepEqual(result.appointments.map((item) => item.appointment_id), ['A-IN']);
  assert.equal(result.medicationHistory.length, 1);
  assert.equal(result.healthReports.length, 1);
  assert.deepEqual(result.standaloneVitals.map((item) => item.vital_set_id), ['V-STANDALONE']);
});

test('default export range is bounded to 366 days', () => {
  const result = exportRange({now:new Date('2026-08-31T12:00:00Z')});
  assert.equal((result.end-result.start)/86400000, MAX_EXPORT_DAYS-1);
});

test('requested history range over 366 days is rejected safely', () => {
  assert.throws(() => exportRange({fromDate:'2024-01-01',toDate:'2026-01-01'}),
    (error) => error instanceof HealthHistoryExportError && error.code === 'EXPORT_DATE_RANGE_TOO_LARGE');
});

for (const [section, overrides] of [
  ['appointments',{appointments:Array.from({length:MAX_SECTION_ENTRIES+1},(_,i)=>({appointment_id:`A-${i}`,care_profile_id:'CP-1',datetime:'2026-08-10T00:00:00Z'}))}],
  ['medication history',{medicationHistory:Array.from({length:MAX_SECTION_ENTRIES+1},()=>({snapshot:{recordedAt:'2026-08-10T00:00:00Z'}}))}],
  ['health reports',{healthReports:Array.from({length:MAX_SECTION_ENTRIES+1},(_,i)=>({daily_report_id:`D-${i}`}))}],
  ['standalone Vital',{standaloneVitals:Array.from({length:MAX_SECTION_ENTRIES+1},(_,i)=>({vital_set_id:`V-${i}`}))}],
]) {
  test(`${section} over 500 entries fails instead of truncating`, async () => {
    await assert.rejects(service(overrides).build({careProfileId:'CP-1',fromDate:'2026-08-01',toDate:'2026-08-31'}),
      (error) => error.code === 'EXPORT_SECTION_TOO_LARGE');
  });
}
