process.env.NODE_ENV = 'test';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const lineClient = require('../backend/providers/lineClient');
const { authorizeCareProfileAccess } = require('../backend/services/careProfileAuthorizationService');

const OLD_OWNER = `U${'1'.repeat(32)}`;
const NEW_OWNER = `U${'2'.repeat(32)}`;
const OTHER_CENTER_OWNER = `U${'3'.repeat(32)}`;

beforeEach(() => {
  db.resetAll();
  lineClient.clearSentLog();
  delete process.env.REQUIRE_STAFF_APPROVAL;
});

afterEach(() => {
  delete process.env.REQUIRE_STAFF_APPROVAL;
});

async function seedCenter(ownerLineId = OLD_OWNER) {
  const center = await centerService.createCenter({ name:'ศูนย์ A', ownerLineId });
  await new Promise((resolve) => setImmediate(resolve));
  lineClient.clearSentLog();
  return center;
}

test('malformed target cannot mutate Center ownership or previous Owner membership', async () => {
  const center = await seedCenter();
  const before = await db.CenterStaff.findWhere((row) => row.center_id === center.center_id);
  const result = await centerService.transferOwner({
    centerId:center.center_id, newOwnerLineId:'not-a-line-user-id', actor:'admin:test',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OWNER_TARGET_INVALID');
  assert.equal((await db.Centers.findOne((row) => row.center_id === center.center_id)).owner_line_id, OLD_OWNER);
  assert.deepEqual(await db.CenterStaff.findWhere((row) => row.center_id === center.center_id), before);
});

test('unavailable strict LINE verification leaves the previous Owner untouched', async () => {
  const center = await seedCenter();
  const result = await centerService.transferOwner({
    centerId:center.center_id, newOwnerLineId:NEW_OWNER, actor:'admin:test',
    verifyLineProfile:async () => { throw new Error('provider detail must stay internal'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OWNER_TARGET_NOT_VERIFIED');
  assert.doesNotMatch(result.reason, /provider detail/i);
  assert.equal((await db.Centers.findOne((row) => row.center_id === center.center_id)).owner_line_id, OLD_OWNER);
  const oldRows = await db.CenterStaff.findWhere((row) => row.center_id === center.center_id && row.line_user_id === OLD_OWNER);
  assert.equal(oldRows.some((row) => row.role === 'owner' && row.status === 'active'), true);
  assert.equal((await db.CenterStaff.findWhere((row) => row.line_user_id === NEW_OWNER)).length, 0);
});

test('same authoritative Owner is a no-change result and does not invoke LINE', async () => {
  const center = await seedCenter();
  let calls = 0;
  const before = await db.CenterStaff.findWhere((row) => row.center_id === center.center_id);
  const result = await centerService.transferOwner({
    centerId:center.center_id, newOwnerLineId:OLD_OWNER, actor:'admin:test',
    verifyLineProfile:async () => { calls += 1; return { userId:OLD_OWNER, displayName:'เดิม' }; },
  });
  assert.equal(result.code, 'OWNER_ALREADY_CURRENT');
  assert.equal(result.noChange, true);
  assert.equal(calls, 0);
  assert.deepEqual(await db.CenterStaff.findWhere((row) => row.center_id === center.center_id), before);
});

test('strict profile lookup rejects provider failure and malformed provider identity without fallback proof', async () => {
  const failingLookup = lineClient.createVerifiedProfileLookup({
    environment:() => 'production',
    messagingClient:{ async getProfile() { throw Object.assign(new Error('raw provider'), { status:503 }); } },
  });
  await assert.rejects(failingLookup(NEW_OWNER), (error) => (
    error.code === 'LINE_PROFILE_LOOKUP_FAILED' && !error.message.includes('raw provider')
  ));
  const invalidLookup = lineClient.createVerifiedProfileLookup({
    environment:() => 'production',
    messagingClient:{ async getProfile() { return { userId:OTHER_CENTER_OWNER, displayName:'บุคคลอื่น' }; } },
  });
  await assert.rejects(invalidLookup(NEW_OWNER), { code:'LINE_PROFILE_INVALID_RESPONSE' });
});

test('existing Manager is promoted without duplication and unrelated Center memberships remain unchanged', async () => {
  const center = await seedCenter();
  const otherCenter = await centerService.createCenter({ name:'ศูนย์ B', ownerLineId:NEW_OWNER });
  await db.CenterStaff.insert({
    staff_id:'STF-TARGET-MANAGER', center_id:center.center_id, line_user_id:NEW_OWNER,
    role:'manager', status:'active', display_name:'เจ้าของใหม่',
  });
  await db.CenterStaff.insert({
    staff_id:'STF-OLD-OTHER', center_id:otherCenter.center_id, line_user_id:OLD_OWNER,
    role:'manager', status:'active',
  });
  const result = await centerService.transferOwner({
    centerId:center.center_id, newOwnerLineId:NEW_OWNER, actor:'admin:test',
  });
  assert.equal(result.ok, true);
  const targetRows = await db.CenterStaff.findWhere((row) => row.center_id === center.center_id
    && row.line_user_id === NEW_OWNER && (!row.status || row.status === 'active'));
  assert.equal(targetRows.length, 1);
  assert.equal(targetRows[0].role, 'owner');
  assert.equal((await db.Centers.findOne((row) => row.center_id === otherCenter.center_id)).owner_line_id, NEW_OWNER);
  assert.equal((await db.CenterStaff.findOne((row) => row.staff_id === 'STF-OLD-OTHER')).role, 'manager');
});

test('former Owner revoked by transfer always rejoins pending even when global approval is disabled', async () => {
  process.env.REQUIRE_STAFF_APPROVAL = 'false';
  const center = await seedCenter();
  await centerService.bindGroupToCenter({
    centerId:center.center_id, groupId:'G-STAFF-A', requesterLineId:OLD_OWNER,
  });
  const transferred = await centerService.transferOwner({
    centerId:center.center_id, newOwnerLineId:NEW_OWNER, actor:'admin:test', keepPreviousAsManager:false,
  });
  assert.equal(transferred.ok, true);
  const rejoined = await centerService.recordStaffFromGroup('G-STAFF-A', OLD_OWNER);
  assert.equal(rejoined.role, 'staff');
  assert.equal(rejoined.status, 'pending');
  assert.equal((await centerService.listCentersByStaffUser(OLD_OWNER)).length, 0);
  const pendingAudit = await db.AuditLog.findOne((row) => row.action === 'center.former_owner_rejoined_pending');
  assert.ok(pendingAudit);
  const approved = await centerService.approveStaff({
    centerId:center.center_id, targetLineId:OLD_OWNER, requesterLineId:NEW_OWNER,
  });
  assert.equal(approved.ok, true);
  assert.equal((await db.CenterStaff.findOne((row) => row.staff_id === rejoined.staff_id)).status, 'active');
});

test('Rich Menu reprojection unlinks a revoked former Owner but preserves it for another active Center role', async () => {
  let center = await seedCenter();
  await centerService.transferOwner({ centerId:center.center_id, newOwnerLineId:NEW_OWNER, actor:'admin:test' });
  assert.ok(lineClient.getSentLog().some((entry) => entry.type === 'richmenu_unlink_user' && entry.userId === OLD_OWNER));

  db.resetAll();
  lineClient.clearSentLog();
  center = await seedCenter();
  const other = await centerService.createCenter({ name:'ศูนย์อื่น', ownerLineId:OTHER_CENTER_OWNER });
  await db.CenterStaff.insert({
    staff_id:'STF-OLD-OTHER-ACTIVE', center_id:other.center_id, line_user_id:OLD_OWNER,
    role:'staff', status:'active',
  });
  lineClient.clearSentLog();
  await centerService.transferOwner({ centerId:center.center_id, newOwnerLineId:NEW_OWNER, actor:'admin:test' });
  assert.equal(lineClient.getSentLog().some((entry) => entry.type === 'richmenu_unlink_user' && entry.userId === OLD_OWNER), false);
  assert.ok(lineClient.getSentLog().some((entry) => entry.type === 'richmenu_link_user' && entry.userId === OLD_OWNER));
});

test('ownership transfer changes Center authority without rewriting patient, Family or operational records', async () => {
  const center = await seedCenter();
  const familyOwner = `U${'4'.repeat(32)}`;
  const records = {
    resident:await db.Residents.insert({ resident_id:'RES-A', center_id:center.center_id, care_profile_id:'CP-A', status:'active' }),
    profile:await db.CareProfiles.insert({ care_profile_id:'CP-A', center_id:center.center_id, owner_line_id:familyOwner, patient_name:'ผู้พักทดสอบ', status:'linked' }),
    member:await db.CareProfileMembers.insert({ member_id:'CPM-A', care_profile_id:'CP-A', line_user_id:'U-CAREGIVER', status:'active' }),
    access:await db.AccessRequests.insert({ request_id:'AR-A', center_id:center.center_id, care_profile_id:'CP-A', status:'approved' }),
    medication:await db.Medications.insert({ medication_id:'MED-A', care_profile_id:'CP-A', name:'ยาทดสอบ', created_by_center_user_id:OLD_OWNER }),
    snapshot:await db.MedicationSnapshots.insert({ snapshot_id:'MS-A', care_profile_id:'CP-A', created_by_center_user_id:OLD_OWNER }),
    vital:await db.Vitals.insert({ vital_id:'VIT-A', care_profile_id:'CP-A', center_id:center.center_id, recorded_by:OLD_OWNER }),
    appointment:await db.Appointments.insert({ appointment_id:'APT-A', care_profile_id:'CP-A', center_id:center.center_id, created_by:OLD_OWNER }),
    transport:await db.TransportPlans.insert({ plan_id:'TP-A', appointment_id:'APT-A', center_id:center.center_id, updated_by:OLD_OWNER }),
    group:await db.GroupBindings.insert({ binding_id:'GB-A', center_id:center.center_id, kind:'family', line_group_id:'G-MASKED', status:'active' }),
    notification:await db.NotificationOutbox.insert({ notification_id:'NO-A', center_id:center.center_id, status:'sent', kind:'historical' }),
  };
  const before = Object.fromEntries(Object.entries(records).map(([key, value]) => [key, JSON.stringify(value)]));
  const subscriptionBefore = {
    required:center.subscription_required, packageType:center.subscription_package_type,
    startsAt:center.subscription_start_at, endsAt:center.subscription_end_at,
  };

  const result = await centerService.transferOwner({
    centerId:center.center_id, newOwnerLineId:NEW_OWNER, actor:'admin:test', keepPreviousAsManager:false,
  });
  assert.equal(result.ok, true);
  const tables = {
    resident:[db.Residents, 'resident_id', 'RES-A'], profile:[db.CareProfiles, 'care_profile_id', 'CP-A'],
    member:[db.CareProfileMembers, 'member_id', 'CPM-A'], access:[db.AccessRequests, 'request_id', 'AR-A'],
    medication:[db.Medications, 'medication_id', 'MED-A'], snapshot:[db.MedicationSnapshots, 'snapshot_id', 'MS-A'],
    vital:[db.Vitals, 'vital_id', 'VIT-A'], appointment:[db.Appointments, 'appointment_id', 'APT-A'],
    transport:[db.TransportPlans, 'plan_id', 'TP-A'], group:[db.GroupBindings, 'binding_id', 'GB-A'],
    notification:[db.NotificationOutbox, 'notification_id', 'NO-A'],
  };
  for (const [key, [table, field, value]] of Object.entries(tables)) {
    assert.equal(JSON.stringify(await table.findOne((row) => row[field] === value)), before[key], `${key} must remain unchanged`);
  }
  const updatedCenter = await db.Centers.findOne((row) => row.center_id === center.center_id);
  assert.deepEqual({
    required:updatedCenter.subscription_required, packageType:updatedCenter.subscription_package_type,
    startsAt:updatedCenter.subscription_start_at, endsAt:updatedCenter.subscription_end_at,
  }, subscriptionBefore);
  assert.equal(updatedCenter.owner_line_id, NEW_OWNER);
  assert.equal((await db.CareProfiles.findOne((row) => row.care_profile_id === 'CP-A')).owner_line_id, familyOwner);
  const provenance = await db.Medications.findOne((row) => row.medication_id === 'MED-A');
  assert.equal(provenance.created_by_center_user_id, OLD_OWNER);
});

test('synthetic transfer journey moves current Center authority while Family and cross-domain Care Profile access stay valid', async () => {
  const center = await seedCenter();
  const familyOwner = `U${'4'.repeat(32)}`;
  await db.CareProfiles.insert({
    care_profile_id:'CP-E2E', center_id:center.center_id,
    owner_line_id:familyOwner, patient_name:'ผู้พักจำลอง', status:'linked',
  });
  await db.Residents.insert({
    resident_id:'RES-E2E', center_id:center.center_id,
    care_profile_id:'CP-E2E', status:'active',
  });

  const oldOwnerBefore = await authorizeCareProfileAccess({
    lineUserId:OLD_OWNER, careProfileId:'CP-E2E', centerId:center.center_id,
    permission:'manage_medications',
  });
  assert.equal(oldOwnerBefore.role, 'owner');
  await assert.rejects(
    authorizeCareProfileAccess({
      lineUserId:NEW_OWNER, careProfileId:'CP-E2E', centerId:center.center_id,
      permission:'view',
    }),
    { code:'ACCESS_DENIED' },
  );
  assert.equal((await authorizeCareProfileAccess({
    lineUserId:familyOwner, careProfileId:'CP-E2E', permission:'view',
  })).principalType, 'family_owner');

  assert.equal((await centerService.transferOwner({
    centerId:center.center_id, newOwnerLineId:NEW_OWNER,
    actor:'admin:test', keepPreviousAsManager:false,
  })).ok, true);

  for (const permission of ['view', 'edit_profile', 'manage_appointments', 'manage_medications', 'decide_transport']) {
    const access = await authorizeCareProfileAccess({
      lineUserId:NEW_OWNER, careProfileId:'CP-E2E', centerId:center.center_id, permission,
    });
    assert.equal(access.role, 'owner', `${permission} must follow current Center authority`);
    await assert.rejects(
      authorizeCareProfileAccess({
        lineUserId:OLD_OWNER, careProfileId:'CP-E2E', centerId:center.center_id, permission,
      }),
      { code:'CENTER_ACCESS_REVOKED' },
    );
  }
  const familyAfter = await authorizeCareProfileAccess({
    lineUserId:familyOwner, careProfileId:'CP-E2E', permission:'view',
  });
  assert.equal(familyAfter.principalType, 'family_owner');
  assert.equal(familyAfter.careProfile.owner_line_id, familyOwner);
  assert.equal(familyAfter.careProfile.center_id, center.center_id);
  assert.equal((await db.AccessRequests.findWhere((row) => row.care_profile_id === 'CP-E2E')).length, 0);
});
