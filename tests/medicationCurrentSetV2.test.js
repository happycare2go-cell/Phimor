const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';

const db = require('../backend/db');
const medicationService = require('../backend/services/medicationCurrentSetService');
const historyService = require('../backend/services/medicationChangeHistoryService');
const { loadCurrentSnapshot } = require('../backend/services/medicationRetrievalService');

const owner = { lineUserId:'U-OWNER' };
const baseItem = (overrides = {}) => ({
  name:'Metformin', strength:'500 mg', dose:'1 เม็ด', instruction:'หลังอาหาร',
  amount:'1', unit:'เม็ด', frequency:'วันละ 2 ครั้ง', timing:'เช้า-เย็น', route:'รับประทาน',
  condition:'ข้อมูลตามฉลาก', ...overrides,
});

async function familyProfile(overrides = {}) {
  return db.CareProfiles.insert({ care_profile_id:'CP-1', owner_line_id:'U-OWNER', patient_name:'บุคคลตัวอย่าง',
    status:'independent', ...overrides });
}

async function centerFixture(role = 'manager', overrides = {}) {
  await db.Centers.insert({ center_id:'C-1', name:'ศูนย์ตัวอย่าง', status:'active', subscription_required:false });
  await db.CenterStaff.insert({ staff_id:'ST-1', center_id:'C-1', line_user_id:'U-CENTER', role, status:'active' });
  await db.CareProfiles.insert({ care_profile_id:'CP-1', patient_name:'บุคคลตัวอย่าง', status:'linked', center_id:'C-1' });
  await db.Residents.insert({ resident_id:'R-1', center_id:'C-1', care_profile_id:'CP-1', status:'active', ...overrides });
}

async function save(items, options = {}) {
  return medicationService.saveCompleteSet({ careProfileId:'CP-1', items,
    baseSnapshotId:options.baseSnapshotId || null, requester:options.requester || owner,
    source:options.source || 'manual', confirmRemoveAll:options.confirmRemoveAll,
    mutationId:options.mutationId || null });
}

test.beforeEach(() => db.resetAll());

test('one and four medications save as a complete authoritative set', async () => {
  await familyProfile();
  const first = await save([baseItem()]);
  assert.equal(first.medications.length, 1);
  const four = await save([baseItem(), baseItem({name:'Aspirin'}), baseItem({name:'Losartan'}), baseItem({name:'Vitamin D'})],
    { baseSnapshotId:first.currentSnapshot.snapshotId });
  assert.deepEqual(four.medications.map((item) => item.name), ['Metformin','Aspirin','Losartan','Vitamin D']);
  assert.equal(four.currentSnapshot.versionNo, 2);
});

test('strength and instruction edits preserve the rest of the complete set', async () => {
  await familyProfile();
  const first = await save([baseItem(), baseItem({name:'Aspirin',strength:'81 mg'})]);
  const second = await save([baseItem(), baseItem({name:'Aspirin',strength:'325 mg',instruction:'หลังอาหารเย็น'})],
    { baseSnapshotId:first.currentSnapshot.snapshotId });
  assert.equal(second.medications.length, 2);
  assert.equal(second.medications[1].strength, '325 mg');
  assert.equal(second.medications[1].instruction, 'หลังอาหารเย็น');
});

test('explicit removal changes current set but preserves historical snapshot rows', async () => {
  await familyProfile();
  const first = await save([baseItem(), baseItem({name:'Aspirin'})]);
  const second = await save([baseItem()], { baseSnapshotId:first.currentSnapshot.snapshotId });
  assert.deepEqual(second.medications.map((item) => item.name), ['Metformin']);
  assert.equal((await db.Medications.findWhere((item) => item.snapshot_id === first.currentSnapshot.snapshotId)).length, 2);
});

test('empty set requires explicit remove-all confirmation', async () => {
  await familyProfile();
  const first = await save([baseItem()]);
  await assert.rejects(save([], { baseSnapshotId:first.currentSnapshot.snapshotId }),
    (error) => error.code === 'EMPTY_MEDICATION_SET_REQUIRES_CONFIRMATION');
  const empty = await save([], { baseSnapshotId:first.currentSnapshot.snapshotId, confirmRemoveAll:true });
  assert.equal(empty.medications.length, 0);
});

for (const [label, items] of [
  ['normalized exact name', [baseItem({name:' Aspirin '}), baseItem({name:'aspirin',strength:'325 mg'})]],
  ['trusted stable id', [baseItem({name:'Drug A',stableMedicationId:'RX-1'}), baseItem({name:'Drug B',stableMedicationId:'rx-1'})]],
]) {
  test(`duplicate ${label} is rejected without clinical values in the error`, async () => {
    await familyProfile();
    await assert.rejects(save(items), (error) => {
      assert.equal(error.code, 'DUPLICATE_MEDICATION_IDENTITY');
      assert.doesNotMatch(JSON.stringify(error), /Aspirin|325|Drug A|Drug B/);
      return true;
    });
  });
}

test('V2 version authority outranks later versionless legacy snapshot deterministically', async () => {
  await familyProfile();
  const v2 = await save([baseItem({name:'Authoritative'})]);
  await db.MedicationSnapshots.insert({ snapshot_id:'LEGACY-LATE', care_profile_id:'CP-1',
    recorded_at:'2099-01-01T00:00:00Z', items:[{name:'Legacy late'}] });
  const current = await loadCurrentSnapshot('CP-1');
  assert.equal(current.currentSnapshot.snapshotId, v2.currentSnapshot.snapshotId);
});

test('legacy embedded snapshot remains readable before first V2 write', async () => {
  await familyProfile();
  await db.MedicationSnapshots.insert({ snapshot_id:'LEGACY', care_profile_id:'CP-1', recorded_at:'2026-01-01T00:00:00Z',
    items:[{name:'Legacy drug',strength:'5 mg'}] });
  const current = await loadCurrentSnapshot('CP-1');
  assert.equal(current.medications[0].name, 'Legacy drug');
});

test('stale base is rejected and does not apply submitted state', async () => {
  await familyProfile();
  const first = await save([baseItem()]);
  const second = await save([baseItem({strength:'850 mg'})], { baseSnapshotId:first.currentSnapshot.snapshotId });
  await assert.rejects(save([baseItem({strength:'1000 mg'})], { baseSnapshotId:first.currentSnapshot.snapshotId }),
    (error) => error.code === 'MEDICATION_SNAPSHOT_STALE' && error.status === 409);
  assert.equal((await loadCurrentSnapshot('CP-1')).currentSnapshot.snapshotId, second.currentSnapshot.snapshotId);
});

test('two concurrent clients converge to one write and one stale response', async () => {
  await familyProfile();
  const first = await save([baseItem()]);
  const results = await Promise.allSettled([
    save([baseItem({strength:'850 mg'})], { baseSnapshotId:first.currentSnapshot.snapshotId }),
    save([baseItem({strength:'1000 mg'})], { baseSnapshotId:first.currentSnapshot.snapshotId }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.reason?.code === 'MEDICATION_SNAPSHOT_STALE').length, 1);
  assert.equal((await db.MedicationSnapshots.findWhere((item) => item.care_profile_id === 'CP-1')).length, 2);
});

test('same mutation retry is idempotent and does not create another snapshot', async () => {
  await familyProfile();
  const first = await save([baseItem()], { mutationId:'same-mutation' });
  const retry = await save([baseItem()], { mutationId:'same-mutation' });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.currentSnapshot.snapshotId, first.currentSnapshot.snapshotId);
  assert.equal((await db.MedicationSnapshots.findAll()).length, 1);
});

test('same mutation key cannot be reused for different clinical state', async () => {
  await familyProfile();
  await save([baseItem()], { mutationId:'same-mutation' });
  await assert.rejects(save([baseItem({strength:'1000 mg'})], { mutationId:'same-mutation' }),
    (error) => error.code === 'MEDICATION_MUTATION_CONFLICT' && error.status === 409);
  assert.equal((await db.MedicationSnapshots.findAll()).length, 1);
});

test('linked-row failure rolls back observable snapshot and partial rows', async () => {
  await familyProfile();
  const original = db.Medications.insert;
  let calls = 0;
  db.Medications.insert = async (...args) => { calls += 1; if (calls === 2) throw new Error('synthetic linked row failure'); return original(...args); };
  try {
    await assert.rejects(save([baseItem(), baseItem({name:'Aspirin'})]), /synthetic linked row failure/);
    assert.equal((await db.MedicationSnapshots.findAll()).length, 0);
    assert.equal((await db.Medications.findAll()).length, 0);
  } finally { db.Medications.insert = original; }
});

test('image proposal changes strength and preserves current drug absent from image', async () => {
  await familyProfile();
  await save([baseItem(), baseItem({name:'Aspirin',strength:'81 mg'})]);
  const proposal = await medicationService.proposeImageMerge({ careProfileId:'CP-1', requester:owner,
    extractedItems:[baseItem({name:'Aspirin',strength:'325 mg'})] });
  assert.equal(proposal.proposals[0].classification, 'CHANGED_STRENGTH');
  assert.deepEqual(proposal.current.medications.map((item) => item.name), ['Metformin','Aspirin']);
  assert.equal((await db.MedicationSnapshots.findAll()).length, 1, 'proposal must not mutate clinical state');
});

test('image classifies unchanged, instruction and multiple-field changes', async () => {
  await familyProfile();
  await save([baseItem()]);
  let proposal = await medicationService.proposeImageMerge({ careProfileId:'CP-1', requester:owner, extractedItems:[baseItem()] });
  assert.equal(proposal.proposals[0].classification, 'UNCHANGED');
  proposal = await medicationService.proposeImageMerge({ careProfileId:'CP-1', requester:owner,
    extractedItems:[baseItem({instruction:'ก่อนอาหาร'})] });
  assert.equal(proposal.proposals[0].classification, 'CHANGED_INSTRUCTION');
  proposal = await medicationService.proposeImageMerge({ careProfileId:'CP-1', requester:owner,
    extractedItems:[baseItem({instruction:'ก่อนอาหาร',strength:'850 mg'})] });
  assert.equal(proposal.proposals[0].classification, 'CHANGED_MULTIPLE_FIELDS');
});

test('duplicate extraction is ambiguous and cannot silently produce duplicate current drug', async () => {
  await familyProfile();
  await save([baseItem({name:'Aspirin',strength:'81 mg'})]);
  const proposal = await medicationService.proposeImageMerge({ careProfileId:'CP-1', requester:owner,
    extractedItems:[baseItem({name:'Aspirin',strength:'81 mg'}),baseItem({name:'Aspirin',strength:'325 mg'})] });
  assert.ok(proposal.proposals.some((item) => item.classification === 'AMBIGUOUS'));
});

test('no-op complete set does not create duplicate snapshot', async () => {
  await familyProfile();
  const first = await save([baseItem()]);
  const noChange = await save([baseItem()], { baseSnapshotId:first.currentSnapshot.snapshotId });
  assert.equal(noChange.noChange, true);
  assert.equal((await db.MedicationSnapshots.findAll()).length, 1);
});

test('family owner and explicitly delegated caregiver can manage', async () => {
  await familyProfile();
  await db.CareProfileMembers.insert({ member_id:'CM-1', care_profile_id:'CP-1', line_user_id:'U-CARE', status:'active',
    role:'caregiver', permissions:['view','manage_medications'] });
  const first = await save([baseItem()]);
  const second = await save([baseItem({strength:'850 mg'})], { baseSnapshotId:first.currentSnapshot.snapshotId,
    requester:{lineUserId:'U-CARE'} });
  assert.equal(second.currentSnapshot.versionNo, 2);
});

test('caregiver without explicit medication permission is denied', async () => {
  await familyProfile();
  await db.CareProfileMembers.insert({ member_id:'CM-1', care_profile_id:'CP-1', line_user_id:'U-CARE', status:'active',
    role:'caregiver', permissions:['view'] });
  await assert.rejects(save([baseItem()], { requester:{lineUserId:'U-CARE'} }), (error) => error.code === 'ACCESS_DENIED');
});

for (const role of ['owner','manager']) {
  test(`Center ${role} may mutate through active exact Resident relationship`, async () => {
    await centerFixture(role);
    const result = await save([baseItem()], { requester:{lineUserId:'U-CENTER',centerId:'C-1'}, source:'center_manual' });
    assert.equal(result.medications.length, 1);
  });
}

test('Center staff, discharged relationship, cross-Center and non-clinical principals fail closed', async () => {
  await centerFixture('staff');
  await assert.rejects(save([baseItem()], { requester:{lineUserId:'U-CENTER',centerId:'C-1'} }), (error) => error.code === 'ACCESS_DENIED');
  await db.CenterStaff.update((item) => item.staff_id === 'ST-1', {role:'manager'});
  await db.Residents.update((item) => item.resident_id === 'R-1', {status:'discharged'});
  await assert.rejects(save([baseItem()], { requester:{lineUserId:'U-CENTER',centerId:'C-1'} }), (error) => error.code === 'CENTER_ACCESS_REVOKED');
  await assert.rejects(save([baseItem()], { requester:{lineUserId:'U-CENTER',centerId:'C-2'} }), (error) => ['ACCESS_DENIED','CENTER_ACCESS_REVOKED'].includes(error.code));
  await assert.rejects(save([baseItem()], { requester:{lineUserId:'U-ADMIN'} }), (error) => ['ACCESS_DENIED','CENTER_ACCESS_REVOKED'].includes(error.code));
  await assert.rejects(save([baseItem()], { requester:{lineUserId:'U-PHARMACIST'} }), (error) => ['ACCESS_DENIED','CENTER_ACCESS_REVOKED'].includes(error.code));
});

test('safe semantic history includes changes and hides raw identity/image fields', async () => {
  await familyProfile();
  const first = await save([baseItem({name:'Aspirin',strength:'81 mg'})]);
  const second = await save([baseItem({name:'Aspirin',strength:'325 mg'})], {baseSnapshotId:first.currentSnapshot.snapshotId});
  await save([], {baseSnapshotId:second.currentSnapshot.snapshotId,confirmRemoveAll:true});
  const history = await historyService.getHistory({careProfileId:'CP-1',requester:owner});
  const serialized = JSON.stringify(history);
  assert.match(serialized, /strength_changed/);
  assert.match(serialized, /removed/);
  assert.doesNotMatch(serialized, /recorded_by|source_image_base64|U-OWNER/);
});

test('ambiguous legacy history remains a factual legacy snapshot', async () => {
  await familyProfile();
  await db.MedicationSnapshots.insert({snapshot_id:'L-1',care_profile_id:'CP-1',recorded_at:'2026-01-01T00:00:00Z',
    items:[{name:'Aspirin',strength:'81 mg'}]});
  await db.MedicationSnapshots.insert({snapshot_id:'L-2',care_profile_id:'CP-1',recorded_at:'2026-02-01T00:00:00Z',
    items:[{name:'Aspirin',strength:'81 mg'},{name:'aspirin',strength:'325 mg'}]});
  const history = await historyService.getHistory({careProfileId:'CP-1',requester:owner});
  assert.ok(history.items.some((item) => item.kind === 'legacy_snapshot'));
});

test('medication audit is minimized and excludes names, values and LINE identity', async () => {
  await familyProfile();
  await save([baseItem()]);
  const entry = await db.AuditLog.findOne((item) => item.action === 'medication.current_set_updated');
  const serialized = JSON.stringify(entry);
  assert.match(serialized, /family_owner/);
  assert.doesNotMatch(serialized, /Metformin|500 mg|หลังอาหาร|U-OWNER|source_image/);
});
