process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../backend/db');
const {
  persistedAuthority, createClinicalRecordMutationAuthority,
} = require('../backend/services/clinicalRecordMutationAuthority');

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const familyRecord = {
  created_source:'family_liff', created_by_actor_type:'family_owner', created_by_actor_id:'U-FAMILY',
};
const centerRecord = {
  created_source:'center_liff', created_by_actor_type:'center_staff', created_by_actor_id:'U-CREATOR',
};

async function seed() {
  db.resetAll();
  await db.Residents.insert({
    resident_id:'RES-A', care_profile_id:'CP-A', center_id:'CTR-A', status:'active',
  });
  await db.CenterStaff.insert({
    staff_id:'STF-CREATOR', line_user_id:'U-CREATOR', center_id:'CTR-A', role:'staff', status:'active',
  });
}

test('persisted provenance, never the current caller, determines clinical mutation authority', () => {
  assert.equal(persistedAuthority(familyRecord), 'family');
  assert.equal(persistedAuthority(centerRecord), 'center');
  assert.equal(persistedAuthority({ created_source:'api', created_by_actor_type:'family_owner' }), 'ambiguous');
});

test('authorized Family roles may mutate Family-authored records only', async () => {
  const authority = createClinicalRecordMutationAuthority();
  await authority.assertMutationAllowed({
    record:familyRecord, careProfileId:'CP-A', access:{ principalType:'family_owner' }, fail,
  });
  await authority.assertMutationAllowed({
    record:familyRecord, careProfileId:'CP-A', access:{ principalType:'family_caregiver' }, fail,
  });
  await assert.rejects(authority.assertMutationAllowed({
    record:centerRecord, careProfileId:'CP-A', access:{ principalType:'family_owner' }, fail,
  }), { code:'ACCESS_DENIED' });
});

test('only manager or owner of the authoritative Center may mutate Center-authored records', async () => {
  await seed();
  const authority = createClinicalRecordMutationAuthority();
  for (const role of ['manager', 'owner']) {
    const result = await authority.assertMutationAllowed({
      record:centerRecord, careProfileId:'CP-A', requestedCenterId:'CTR-A',
      access:{ principalType:'center_staff', role }, fail,
    });
    assert.equal(result.centerId, 'CTR-A');
  }
  for (const access of [
    { principalType:'center_staff', role:'staff' },
    { principalType:'system_admin', role:'system_admin' },
  ]) {
    await assert.rejects(authority.assertMutationAllowed({
      record:centerRecord, careProfileId:'CP-A', requestedCenterId:'CTR-A', access, fail,
    }), { code:'ACCESS_DENIED' });
  }
  await assert.rejects(authority.assertMutationAllowed({
    record:centerRecord, careProfileId:'CP-A', requestedCenterId:'CTR-B',
    access:{ principalType:'center_staff', role:'manager' }, fail,
  }), { code:'ACCESS_DENIED' });
});

test('a later active Center relationship cannot re-attribute an older Center-authored record', async () => {
  await seed();
  await db.Residents.update((row) => row.resident_id === 'RES-A', { status:'discharged' });
  await db.Residents.insert({
    resident_id:'RES-B', care_profile_id:'CP-A', center_id:'CTR-B', status:'active',
  });
  const authority = createClinicalRecordMutationAuthority();
  assert.equal(await authority.resolveAuthoritativeCenter({
    careProfileId:'CP-A', creatorLineUserId:'U-CREATOR',
  }), 'CTR-A');
  await assert.rejects(authority.assertMutationAllowed({
    record:centerRecord, careProfileId:'CP-A', requestedCenterId:'CTR-B',
    access:{ principalType:'center_staff', role:'manager' }, fail,
  }), { code:'ACCESS_DENIED' });
});

test('legacy ambiguous provenance fails safely instead of granting broad mutation authority', async () => {
  const authority = createClinicalRecordMutationAuthority();
  await assert.rejects(authority.assertMutationAllowed({
    record:{ created_source:'api', created_by_actor_type:'center_staff' }, careProfileId:'CP-A',
    access:{ principalType:'center_staff', role:'owner' }, fail,
  }), { code:'RECORD_PROVENANCE_AMBIGUOUS' });
});
