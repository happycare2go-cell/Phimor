const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../backend/db');
const {
  authorizeCareProfileAccess,
} = require('../backend/services/careProfileAuthorizationService');

beforeEach(() => db.resetAll());

async function profile(overrides = {}) {
  return db.CareProfiles.insert({
    care_profile_id: overrides.care_profile_id || 'CP-1', owner_line_id: 'U_OWNER',
    patient_name: 'ผู้รับการดูแล', status: 'independent', ...overrides,
  });
}

async function caregiver(careProfileId, lineUserId, overrides = {}) {
  return db.CareProfileMembers.insert({
    member_id: `CPM-${lineUserId}-${careProfileId}`, care_profile_id: careProfileId,
    line_user_id: lineUserId, role: 'caregiver', status: 'active',
    permissions: ['view'], ...overrides,
  });
}

async function centerRelationship({ careProfileId = 'CP-1', centerId = 'CTR-1', lineUserId = 'U_STAFF', role = 'staff', staffStatus = 'active', residentStatus = 'active', residentCareProfileId = careProfileId, center = {} } = {}) {
  await db.Centers.insert({ center_id: centerId, name: centerId, status: 'active', ...center });
  const resident = await db.Residents.insert({
    resident_id: `RES-${centerId}`, center_id: centerId,
    care_profile_id: residentCareProfileId, status: residentStatus,
  });
  await db.CenterStaff.insert({
    staff_id: `STF-${centerId}-${lineUserId}`, center_id: centerId,
    line_user_id: lineUserId, role, status: staffStatus,
  });
  return resident;
}

async function expectDenied(input, code) {
  await assert.rejects(
    authorizeCareProfileAccess(input),
    (error) => error.code === code && !Object.keys(error).includes('details')
  );
}

test('family owner is allowed and receives minimal owner context', async () => {
  await profile();
  const result = await authorizeCareProfileAccess({ lineUserId: 'U_OWNER', careProfileId: 'CP-1', permission: 'view' });
  assert.strictEqual(result.principalType, 'family_owner');
  assert.strictEqual(result.role, 'owner');
  assert.deepStrictEqual(result.permissions, ['*']);
  assert.strictEqual(result.careProfile.care_profile_id, 'CP-1');
  assert.strictEqual(result.resident, null);
  assert.strictEqual(result.center, null);
});

test('owner of an unrelated Care Profile is denied without exposing profile details', async () => {
  await profile();
  await expectDenied({ lineUserId: 'U_OTHER_OWNER', careProfileId: 'CP-1', permission: 'view' }, 'ACCESS_DENIED');
});

test('active caregiver with view permission is allowed', async () => {
  await profile();
  await caregiver('CP-1', 'U_CAREGIVER');
  const result = await authorizeCareProfileAccess({ lineUserId: 'U_CAREGIVER', careProfileId: 'CP-1', permission: 'view' });
  assert.strictEqual(result.principalType, 'family_caregiver');
  assert.deepStrictEqual(result.permissions, ['view']);
});

test('caregiver without required permission is denied', async () => {
  await profile();
  await caregiver('CP-1', 'U_CAREGIVER', { permissions: ['view'] });
  await expectDenied({ lineUserId: 'U_CAREGIVER', careProfileId: 'CP-1', permission: 'manage_medications' }, 'ACCESS_DENIED');
});

test('revoked caregiver is denied with membership-revoked classification', async () => {
  await profile();
  await caregiver('CP-1', 'U_CAREGIVER', { status: 'revoked' });
  await expectDenied({ lineUserId: 'U_CAREGIVER', careProfileId: 'CP-1', permission: 'view' }, 'MEMBERSHIP_REVOKED');
});

test('caregiver membership for another Care Profile grants no access', async () => {
  await profile();
  await profile({ care_profile_id: 'CP-2', owner_line_id: 'U_OTHER' });
  await caregiver('CP-2', 'U_CAREGIVER');
  await expectDenied({ lineUserId: 'U_CAREGIVER', careProfileId: 'CP-1', permission: 'view' }, 'ACCESS_DENIED');
});

test('active center owner and manager linked through an active Resident are allowed', async () => {
  await profile({ status: 'linked' });
  await centerRelationship({ lineUserId: 'U_CENTER_OWNER', role: 'owner' });
  await centerRelationship({ centerId: 'CTR-2', lineUserId: 'U_MANAGER', role: 'manager' });
  const owner = await authorizeCareProfileAccess({ lineUserId: 'U_CENTER_OWNER', careProfileId: 'CP-1', permission: 'manage_medications', centerId: 'CTR-1' });
  const manager = await authorizeCareProfileAccess({ lineUserId: 'U_MANAGER', careProfileId: 'CP-1', permission: 'manage_appointments', centerId: 'CTR-2' });
  assert.strictEqual(owner.role, 'owner');
  assert.strictEqual(manager.role, 'manager');
  assert.strictEqual(owner.resident.care_profile_id, 'CP-1');
});

test('center staff follows existing policy: view allowed but management denied', async () => {
  await profile({ status: 'linked' });
  await centerRelationship();
  const result = await authorizeCareProfileAccess({ lineUserId: 'U_STAFF', careProfileId: 'CP-1', permission: 'view', centerId: 'CTR-1' });
  assert.strictEqual(result.role, 'staff');
  await expectDenied({ lineUserId: 'U_STAFF', careProfileId: 'CP-1', permission: 'manage_medications', centerId: 'CTR-1' }, 'ACCESS_DENIED');
});

test('revoked CenterStaff is denied even when the Resident relationship is active', async () => {
  await profile({ status: 'linked' });
  await centerRelationship({ staffStatus: 'revoked' });
  await expectDenied({ lineUserId: 'U_STAFF', careProfileId: 'CP-1', permission: 'view', centerId: 'CTR-1' }, 'CENTER_ACCESS_REVOKED');
});

async function authorizeWithLegacyStaffRows(rows, permission = 'manage_medications') {
  await profile({ status:'linked' });
  await db.Centers.insert({ center_id:'CTR-LEGACY', name:'legacy', status:'active' });
  await db.Residents.insert({
    resident_id:'RES-LEGACY', center_id:'CTR-LEGACY', care_profile_id:'CP-1', status:'active',
  });
  for (const [index, row] of rows.entries()) {
    await db.CenterStaff.insert({
      staff_id:`STF-LEGACY-${index}`, center_id:'CTR-LEGACY', line_user_id:'U_LEGACY', ...row,
    });
  }
  return authorizeCareProfileAccess({
    lineUserId:'U_LEGACY', careProfileId:'CP-1', permission, centerId:'CTR-LEGACY',
  });
}

test('revoked historical row first cannot shadow a later active Owner membership', async () => {
  const access = await authorizeWithLegacyStaffRows([
    { role:'staff', status:'revoked' }, { role:'owner', status:'active' },
  ]);
  assert.strictEqual(access.role, 'owner');
});

test('active Owner remains authoritative when a revoked row follows it', async () => {
  const access = await authorizeWithLegacyStaffRows([
    { role:'owner', status:'active' }, { role:'staff', status:'revoked' },
  ]);
  assert.strictEqual(access.role, 'owner');
});

test('effective membership ignores revoked Manager or Owner history', async () => {
  let access = await authorizeWithLegacyStaffRows([
    { role:'manager', status:'revoked' }, { role:'owner', status:'active' },
  ]);
  assert.strictEqual(access.role, 'owner');
  db.resetAll();
  access = await authorizeWithLegacyStaffRows([
    { role:'owner', status:'revoked' }, { role:'manager', status:'active' },
  ]);
  assert.strictEqual(access.role, 'manager');
});

test('all historical Center memberships revoked returns CENTER_ACCESS_REVOKED', async () => {
  await assert.rejects(
    authorizeWithLegacyStaffRows([
      { role:'owner', status:'revoked' }, { role:'manager', status:'inactive' },
    ], 'view'),
    (error) => error.code === 'CENTER_ACCESS_REVOKED',
  );
});

test('multiple active legacy memberships use owner-manager-staff precedence deterministically', async () => {
  const access = await authorizeWithLegacyStaffRows([
    { role:'staff', status:'active' }, { role:'manager', status:'active' }, { role:'owner', status:'active' },
  ]);
  assert.strictEqual(access.role, 'owner');
});

test('duplicate-safe selection preserves Staff view-only permissions', async () => {
  const access = await authorizeWithLegacyStaffRows([
    { role:'manager', status:'revoked' }, { role:'staff', status:'active' },
  ], 'view');
  assert.strictEqual(access.role, 'staff');
  await assert.rejects(
    authorizeCareProfileAccess({
      lineUserId:'U_LEGACY', careProfileId:'CP-1', permission:'manage_medications', centerId:'CTR-LEGACY',
    }),
    (error) => error.code === 'ACCESS_DENIED',
  );
});

test('staff from a different center cannot access the Care Profile', async () => {
  await profile({ status: 'linked' });
  await centerRelationship({ lineUserId: 'U_CENTER_A' });
  await db.Centers.insert({ center_id: 'CTR-2', name: 'other', status: 'active' });
  await db.CenterStaff.insert({ staff_id: 'STF-B', center_id: 'CTR-2', line_user_id: 'U_CENTER_B', role: 'manager', status: 'active' });
  await expectDenied({ lineUserId: 'U_CENTER_B', careProfileId: 'CP-1', permission: 'view', centerId: 'CTR-1' }, 'ACCESS_DENIED');
});

test('discharged Resident revokes center access', async () => {
  await profile({ status: 'linked' });
  await centerRelationship({ residentStatus: 'discharged' });
  await expectDenied({ lineUserId: 'U_STAFF', careProfileId: 'CP-1', permission: 'view', centerId: 'CTR-1' }, 'CENTER_ACCESS_REVOKED');
});

test('Resident not linked to the requested Care Profile grants no access', async () => {
  await profile({ status: 'linked' });
  await centerRelationship({ residentCareProfileId: 'CP-OTHER' });
  await expectDenied({ lineUserId: 'U_STAFF', careProfileId: 'CP-1', permission: 'view', centerId: 'CTR-1' }, 'ACCESS_DENIED');
});

test('inactive center subscription is denied when active entitlement is required', async () => {
  await profile({ status: 'linked' });
  await centerRelationship({ center: { subscription_required: true } });
  await expectDenied({ lineUserId: 'U_STAFF', careProfileId: 'CP-1', permission: 'view', centerId: 'CTR-1' }, 'CENTER_SUBSCRIPTION_INACTIVE');
});

test('inactive subscription may be bypassed only when caller explicitly disables that requirement', async () => {
  await profile({ status: 'linked' });
  await centerRelationship({ center: { subscription_required: true } });
  const result = await authorizeCareProfileAccess({
    lineUserId: 'U_STAFF', careProfileId: 'CP-1', permission: 'view', centerId: 'CTR-1', requireActiveCenter: false,
  });
  assert.strictEqual(result.principalType, 'center_staff');
});

test('missing requester identity is denied backend-side', async () => {
  await profile();
  await expectDenied({ careProfileId: 'CP-1', permission: 'view' }, 'UNAUTHENTICATED');
});

test('malformed and nonexistent Care Profile identifiers are handled safely', async () => {
  await expectDenied({ lineUserId: 'U_USER', careProfileId: '', permission: 'view' }, 'CARE_PROFILE_NOT_FOUND');
  await expectDenied({ lineUserId: 'U_USER', careProfileId: 'CP-NOT-FOUND', permission: 'view' }, 'CARE_PROFILE_NOT_FOUND');
});

test('ambiguous multi-center relationship requires an explicit center context', async () => {
  await profile({ status: 'linked' });
  await centerRelationship({ centerId: 'CTR-1', lineUserId: 'U_MANAGER', role: 'manager' });
  await centerRelationship({ centerId: 'CTR-2', lineUserId: 'U_MANAGER', role: 'manager' });
  await expectDenied({ lineUserId: 'U_MANAGER', careProfileId: 'CP-1', permission: 'view' }, 'ACCESS_DENIED');
  const selected = await authorizeCareProfileAccess({ lineUserId: 'U_MANAGER', careProfileId: 'CP-1', permission: 'view', centerId: 'CTR-2' });
  assert.strictEqual(selected.center.center_id, 'CTR-2');
});

test('unsupported permissions deny by default', async () => {
  await profile();
  await expectDenied({ lineUserId: 'U_OWNER', careProfileId: 'CP-1', permission: 'future_permission' }, 'ACCESS_DENIED');
});
