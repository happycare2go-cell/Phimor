const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';

const db = require('../backend/db');
const {
  getCurrentMedicationSnapshot, getMedicationInstructions,
} = require('../backend/services/medicationRetrievalService');
const {
  normalizeMedication, parseDoseAndInstruction, compareMedicationSnapshots,
} = require('../backend/services/medicationDiffService');

test.beforeEach(() => db.resetAll());

async function profile(overrides = {}) {
  return db.CareProfiles.insert({
    care_profile_id: 'CP-1', owner_line_id: 'U-OWNER', patient_name: 'ผู้รับการดูแล', status: 'independent', ...overrides,
  });
}

async function snapshot(id, recordedAt, overrides = {}) {
  return db.MedicationSnapshots.insert({
    snapshot_id: id, care_profile_id: 'CP-1', recorded_at: recordedAt, source: 'family_manual',
    source_image_base64: `private-image-${id}`, recorded_by: 'U-RECORDER', items: [], ...overrides,
  });
}

async function medication(snapshotId, id, values = {}) {
  return db.Medications.insert({
    medication_id: id, snapshot_id: snapshotId, care_profile_id: values.care_profile_id || 'CP-1',
    name: values.name || 'Metformin', strength: values.strength || '', dose: values.dose || '',
    instruction: values.instruction || '', amount: values.amount ?? null, unit: values.unit ?? null,
    frequency: values.frequency ?? null, timing: values.timing ?? null, route: values.route ?? null,
    stable_medication_id: values.stable_medication_id || null,
    source_image_base64: 'private-medication-image', recorded_by: 'U-RECORDER',
  });
}

const requester = { lineUserId: 'U-OWNER' };

test('latest eligible snapshot is current and only its linked medications are returned', async () => {
  await profile();
  await snapshot('S-OLD', '2026-08-01T00:00:00.000Z');
  await snapshot('S-NEW', '2026-08-20T00:00:00.000Z');
  await medication('S-OLD', 'M-OLD', { name: 'Old drug' });
  await medication('S-NEW', 'M-NEW', { name: 'Current drug', dose: '1 เม็ด หลังอาหาร' });
  const result = await getCurrentMedicationSnapshot({ careProfileId: 'CP-1', requester });
  assert.equal(result.status, 'CURRENT_SNAPSHOT');
  assert.equal(result.currentSnapshot.snapshotId, 'S-NEW');
  assert.equal(result.medicationSource, 'linked_records');
  assert.deepEqual(result.medications.map((item) => item.medicationId), ['M-NEW']);
});

test('newer cancelled snapshot is not considered current', async () => {
  await profile();
  await snapshot('S-ACTIVE', '2026-08-20T00:00:00.000Z');
  await snapshot('S-CANCELLED', '2026-08-22T00:00:00.000Z', { status: 'cancelled' });
  await medication('S-ACTIVE', 'M-ACTIVE', { name: 'Active drug' });
  await medication('S-CANCELLED', 'M-CANCELLED', { name: 'Cancelled drug' });
  const result = await getCurrentMedicationSnapshot({ careProfileId: 'CP-1', requester });
  assert.equal(result.currentSnapshot.snapshotId, 'S-ACTIVE');
  assert.equal(result.medications[0].name, 'Active drug');
});

test('newer snapshot explicitly marked old is not considered current', async () => {
  await profile();
  await snapshot('S-ACTIVE', '2026-08-20T00:00:00.000Z');
  await snapshot('S-OLD-STATUS', '2026-08-23T00:00:00.000Z', { status: 'old' });
  await medication('S-ACTIVE', 'M-ACTIVE', { name: 'Active drug' });
  await medication('S-OLD-STATUS', 'M-OLD-STATUS', { name: 'Old-status drug' });
  const result = await getCurrentMedicationSnapshot({ careProfileId: 'CP-1', requester });
  assert.equal(result.currentSnapshot.snapshotId, 'S-ACTIVE');
});

test('no snapshot returns NO_CURRENT_SNAPSHOT and ignores unconfirmed legacy medication rows', async () => {
  await profile();
  await db.Medications.insert({ medication_id: 'LEGACY', care_profile_id: 'CP-1', name: 'Legacy drug', dose: 'old' });
  const result = await getCurrentMedicationSnapshot({ careProfileId: 'CP-1', requester });
  assert.deepEqual(result, { status: 'NO_CURRENT_SNAPSHOT', currentSnapshot: null, medicationSource: 'none', medications: [] });
});

test('legacy embedded snapshot items are an explicit compatibility source', async () => {
  await profile();
  await snapshot('S-EMBED', '2026-08-20T00:00:00.000Z', { items: [{ name: 'Embedded drug', dose: 'เดิมทุกคำ' }] });
  const result = await getCurrentMedicationSnapshot({ careProfileId: 'CP-1', requester });
  assert.equal(result.medicationSource, 'snapshot_embedded_items');
  assert.equal(result.medications[0].dose, 'เดิมทุกคำ');
});

test('partial linked rows cannot hide the complete embedded V2 current set', async () => {
  await profile();
  await snapshot('V2-PARTIAL', '2026-08-30T00:00:00.000Z', { schema_version:2, version_no:1,
    items:[{ medication_id:'M-1', name:'Metformin' }, { medication_id:'M-2', name:'Aspirin' }] });
  await medication('V2-PARTIAL', 'M-1', { name:'Metformin' });
  const result=await getCurrentMedicationSnapshot({ careProfileId:'CP-1', requester });
  assert.equal(result.medicationSource,'snapshot_embedded_items_partial_link_recovery');
  assert.deepEqual(result.medications.map((item)=>item.name),['Metformin','Aspirin']);
});

test('revoked caregiver cannot retrieve current medication', async () => {
  await profile();
  await db.CareProfileMembers.insert({ member_id: 'MEM-1', care_profile_id: 'CP-1', line_user_id: 'U-CARE', status: 'revoked', permissions: ['view'] });
  await assert.rejects(getCurrentMedicationSnapshot({ careProfileId: 'CP-1', requester: { lineUserId: 'U-CARE' } }), (error) => error.code === 'MEMBERSHIP_REVOKED');
});

test('medication instructions preserve stored text and structured fields', async () => {
  await profile();
  await snapshot('S-1', '2026-08-20T00:00:00.000Z');
  await medication('S-1', 'M-1', {
    name: 'ยาเดิม', strength: '500 มก.', dose: 'ครั้งละ 1 เม็ด', instruction: 'หลังอาหารทันที',
    amount: '1', unit: 'เม็ด', frequency: 'วันละ 2 ครั้ง', timing: 'หลังอาหาร', route: 'รับประทาน',
  });
  const result = await getMedicationInstructions({ careProfileId: 'CP-1', requester, medicationId: 'M-1' });
  assert.equal(result.instructions[0].dose, 'ครั้งละ 1 เม็ด');
  assert.equal(result.instructions[0].instruction, 'หลังอาหารทันที');
  assert.equal(result.instructions[0].frequency, 'วันละ 2 ครั้ง');
  assert.equal(result.instructions[0].route, 'รับประทาน');
});

test('retrieval outputs never leak source images or LINE identifiers', async () => {
  await profile();
  await snapshot('S-1', '2026-08-20T00:00:00.000Z');
  await medication('S-1', 'M-1');
  const current = await getCurrentMedicationSnapshot({ careProfileId: 'CP-1', requester });
  const instructions = await getMedicationInstructions({ careProfileId: 'CP-1', requester });
  const serialized = JSON.stringify({ current, instructions });
  assert.doesNotMatch(serialized, /private-image|private-medication-image|U-RECORDER/);
  assert.doesNotMatch(serialized, /source_image|recorded_by|owner_line_id/);
});

async function compare(previousItems, currentItems, overrides = {}) {
  await profile();
  await snapshot('S-PREV', '2026-08-01T00:00:00.000Z', overrides.previousSnapshot || {});
  await snapshot('S-CURR', '2026-08-20T00:00:00.000Z', overrides.currentSnapshot || {});
  for (let index = 0; index < previousItems.length; index += 1) await medication('S-PREV', `P-${index}`, previousItems[index]);
  for (let index = 0; index < currentItems.length; index += 1) await medication('S-CURR', `C-${index}`, currentItems[index]);
  return compareMedicationSnapshots({ previousSnapshotId: 'S-PREV', currentSnapshotId: 'S-CURR', requester, careProfileId: 'CP-1' });
}

test('diff reports added and removed medications', async () => {
  const result = await compare([{ name: 'Aspirin', strength: '81 mg' }], [{ name: 'Metformin', strength: '500 mg' }]);
  assert.equal(result.added[0].original.name, 'Metformin');
  assert.equal(result.removed[0].original.name, 'Aspirin');
});

test('diff reports dose or strength changes deterministically', async () => {
  const result = await compare(
    [{ name: 'Metformin', strength: '500 mg', dose: '1 เม็ด' }],
    [{ name: 'Metformin', strength: '1000 มก.', dose: '1 เม็ด' }]
  );
  assert.equal(result.doseChanged.length, 1);
  assert.equal(result.doseChanged[0].previous.normalized.strength, '500 mg');
  assert.equal(result.doseChanged[0].current.normalized.strength, '1000 mg');
});

test('diff reports instruction changes separately from dose', async () => {
  const result = await compare(
    [{ name: 'Drug A', dose: '1 เม็ด หลังอาหาร' }],
    [{ name: 'Drug A', dose: '1 เม็ด ก่อนอาหาร' }]
  );
  assert.equal(result.doseChanged.length, 0);
  assert.equal(result.instructionChanged.length, 1);
});

test('dispensed amount is not reinterpreted as per-administration dose', () => {
  const result = parseDoseAndInstruction({
    dose: '1', unit: 'เม็ด', amount: '30', frequency: 'วันละ 1 ครั้ง', timing: 'ก่อนนอน',
  });
  assert.equal(result.dose, '1');
  assert.doesNotMatch(result.dose, /30/);
  assert.equal(result.instruction, 'วันละ 1 ครั้ง | ก่อนนอน');
});

test('unit spelling, Unicode, case and whitespace normalization produce unchanged result', async () => {
  const result = await compare(
    [{ name: 'METFORMIN 500 มก.', dose: ' 1   เม็ด หลังอาหาร ' }],
    [{ name: 'metformin 500 mg', dose: '1 เม็ด  หลังอาหาร' }]
  );
  assert.equal(result.unchanged.length, 1);
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
});

test('legacy duplicate exact names remain ambiguous instead of using strength as identity', async () => {
  const result = await compare(
    [{ name: 'Drug A', strength: '5 mg' }, { name: 'Drug A', strength: '10 mg' }],
    [{ name: 'Drug A', strength: '10 มก.' }, { name: 'Drug A', strength: '5 มก.' }]
  );
  assert.equal(result.unchanged.length, 0);
  assert.equal(result.warnings.some((item) => item.code === 'AMBIGUOUS_MEDICATION_MATCH'), true);
  assert.equal(result.added.length, 2);
  assert.equal(result.removed.length, 2);
});

test('similar medication names are not fuzzy merged', async () => {
  const result = await compare([{ name: 'Amoxicillin' }], [{ name: 'Amoxiclav' }]);
  assert.equal(result.unchanged.length, 0);
  assert.equal(result.added[0].original.name, 'Amoxiclav');
  assert.equal(result.removed[0].original.name, 'Amoxicillin');
});

test('ambiguous duplicate exact-name matching creates warning instead of guessing', async () => {
  const result = await compare(
    [{ name: 'Drug A', dose: '1 เม็ด' }, { name: 'Drug A', dose: '2 เม็ด' }],
    [{ name: 'Drug A', dose: '1 เม็ด' }]
  );
  assert.ok(result.warnings.some((warning) => warning.code === 'AMBIGUOUS_MEDICATION_MATCH'));
  assert.equal(result.unchanged.length, 0);
  assert.equal(result.removed.length, 2);
  assert.equal(result.added.length, 1);
});

test('snapshot from another Care Profile cannot be compared', async () => {
  await profile();
  await snapshot('S-PREV', '2026-08-01T00:00:00.000Z');
  await snapshot('S-OTHER', '2026-08-20T00:00:00.000Z', { care_profile_id: 'CP-OTHER' });
  await assert.rejects(compareMedicationSnapshots({
    previousSnapshotId: 'S-PREV', currentSnapshotId: 'S-OTHER', requester, careProfileId: 'CP-1',
  }), (error) => error.code === 'SNAPSHOT_NOT_FOUND');
});

test('cancelled snapshot cannot be used for comparison', async () => {
  await profile();
  await snapshot('S-PREV', '2026-08-01T00:00:00.000Z');
  await snapshot('S-CANCEL', '2026-08-20T00:00:00.000Z', { status: 'cancelled' });
  await assert.rejects(compareMedicationSnapshots({
    previousSnapshotId: 'S-PREV', currentSnapshotId: 'S-CANCEL', requester, careProfileId: 'CP-1',
  }), (error) => error.code === 'SNAPSHOT_NOT_COMPARABLE');
});

test('normalization retains original and normalized values without clinical interpretation', () => {
  const result = normalizeMedication({ name: ' Drug A 500 มก. ', strength: '', dose: '1 เม็ด หลังอาหาร', instruction: '', amount: null, unit: null, frequency: null, timing: null, route: null });
  assert.equal(result.original.name, ' Drug A 500 มก. ');
  assert.equal(result.normalized.name, 'drug a');
  assert.equal(result.normalized.strength, '500 mg');
  assert.equal(Object.hasOwn(result, 'safe'), false);
  assert.equal(Object.hasOwn(result, 'recommendation'), false);
});
