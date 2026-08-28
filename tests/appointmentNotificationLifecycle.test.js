const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../backend/db');
const familyService = require('../backend/services/familyService');
const centerService = require('../backend/services/centerService');
const reminderService = require('../backend/services/reminderService');
const cardService = require('../backend/services/cardService');
const notificationService = require('../backend/services/notificationService');
const lineClient = require('../backend/providers/lineClient');

beforeEach(() => {
  db.resetAll();
  lineClient.clearSentLog();
});

async function independent({ profileId = 'CP-I', owner = 'U-FAMILY', name = 'คุณสมชาย' } = {}) {
  return db.CareProfiles.insert({
    care_profile_id:profileId, owner_line_id:owner, patient_name:name,
    status:'independent', center_id:null,
  });
}

async function linked({
  profileId = 'CP-L', owner = 'U-FAMILY', name = 'คุณสมศรี', room = '203',
  centerId = 'CTR-A', familyGroup = 'G-FAMILY', centerGroup = 'G-CENTER',
} = {}) {
  const center = await db.Centers.insert({ center_id:centerId, name:`ศูนย์ ${centerId}`, owner_line_id:`OWNER-${centerId}`, status:'active' });
  const profile = await db.CareProfiles.insert({
    care_profile_id:profileId, owner_line_id:owner, patient_name:name,
    status:'linked', center_id:centerId,
  });
  const resident = await db.Residents.insert({
    resident_id:`R-${profileId}`, center_id:centerId, care_profile_id:profileId,
    full_name:name, room, status:'active',
  });
  if (familyGroup) await db.GroupBindings.insert({
    binding_id:`GB-F-${profileId}`, kind:'family', care_profile_id:profileId,
    line_group_id:familyGroup, status:'active',
  });
  if (centerGroup) await db.GroupBindings.insert({
    binding_id:`GB-C-${centerId}`, kind:'center_staff', center_id:centerId,
    line_group_id:centerGroup, status:'active',
  });
  return { center, profile, resident };
}

async function lifecycleRows(eventType = null) {
  return db.NotificationOutbox.findWhere((item) => (
    item.kind.startsWith('appointment_')
      && !item.kind.includes('reminder')
      && (!eventType || item.meta?.eventType === eventType)
  ));
}

test('independent create queues one Family lifecycle intent and no Center intent', async () => {
  await independent();
  const result = await familyService.addAppointmentByFamily({
    careProfileId:'CP-I', hospital:'โรงพยาบาลตัวอย่าง', datetime:'2099-09-02T10:30:00+07:00',
    createdBy:'U-FAMILY', idempotencyKey:'create-independent-1',
  });
  assert.equal(result.ok, true);
  const rows = await lifecycleRows('created');
  assert.deepEqual(rows.map((item) => item.kind), ['appointment_created_family']);
  assert.match(rows[0].messages[0].text, /คุณสมชาย — มีนัดหมายใหม่/);
});

test('independent material update queues Family and identical retry is a no-op', async () => {
  await independent();
  await db.Appointments.insert({ appointment_id:'A-I', care_profile_id:'CP-I', hospital:'รพ.เดิม', datetime:'2099-09-02T10:30:00+07:00', status:'confirmed', version:1 });
  const first = await familyService.updateFamilyAppointment({ careProfileId:'CP-I', appointmentId:'A-I', patch:{hospital:'รพ.ใหม่'}, requesterLineId:'U-FAMILY' });
  const retry = await familyService.updateFamilyAppointment({ careProfileId:'CP-I', appointmentId:'A-I', patch:{hospital:'รพ.ใหม่'}, requesterLineId:'U-FAMILY' });
  assert.equal(first.ok, true);
  assert.equal(retry.noChange, true);
  assert.equal((await lifecycleRows('updated')).length, 1);
});

test('independent cancellation queues Family once and cancellation retry is idempotent', async () => {
  await independent();
  await db.Appointments.insert({ appointment_id:'A-I', care_profile_id:'CP-I', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00', status:'confirmed' });
  const first = await familyService.cancelFamilyAppointment({ careProfileId:'CP-I', appointmentId:'A-I', requesterLineId:'U-FAMILY' });
  const retry = await familyService.cancelFamilyAppointment({ careProfileId:'CP-I', appointmentId:'A-I', requesterLineId:'U-FAMILY' });
  assert.equal(first.ok, true);
  assert.equal(retry.alreadyCancelled, true);
  assert.equal((await lifecycleRows('cancelled')).length, 1);
});

test('independent one-day and day-of reminders reach Family and cancelled appointments do not', async () => {
  await independent();
  await db.Appointments.insert({ appointment_id:'A-I', care_profile_id:'CP-I', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00', status:'confirmed' });
  assert.equal((await reminderService.sendAppointmentReminders(new Date('2099-09-01T08:00:00+07:00'))).sent, 1);
  assert.equal((await reminderService.sendAppointmentReminders(new Date('2099-09-02T08:00:00+07:00'))).sent, 1);
  const reminders = await db.NotificationOutbox.findWhere((item) => item.kind === 'appointment_reminder');
  assert.equal(reminders.length, 2);
  await db.Appointments.update((item) => item.appointment_id === 'A-I', { status:'cancelled', day_before_reminded:false, same_day_reminded:false });
  assert.equal((await reminderService.sendAppointmentReminders(new Date('2099-09-02T08:00:00+07:00'))).sent, 0);
});

test('Center-linked create queues distinct Family and authoritative Center intents', async () => {
  await linked();
  const result = await familyService.addAppointmentByFamily({
    careProfileId:'CP-L', hospital:'โรงพยาบาลตัวอย่าง', datetime:'2099-09-02T10:30:00+07:00',
    createdBy:'U-FAMILY', idempotencyKey:'create-linked-1',
  });
  const rows = await lifecycleRows('created');
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((item) => item.kind)), new Set(['appointment_created_family', 'appointment_created_center']));
  assert.notEqual(rows[0].dedupe_key, rows[1].dedupe_key);
  assert.ok(rows.every((item) => item.messages[0].text.includes('คุณสมศรี')));
  assert.match(rows.find((item) => item.kind.endsWith('_center')).messages[0].text, /ห้อง 203/);
  assert.doesNotMatch(JSON.stringify(result.notificationState), /G-FAMILY|G-CENTER|คุณสมศรี|โรงพยาบาล/);
});

test('Center-linked later material updates use distinct persisted revisions', async () => {
  await linked();
  await db.Appointments.insert({ appointment_id:'A-L', care_profile_id:'CP-L', hospital:'รพ.เดิม', datetime:'2099-09-02T10:30:00+07:00', status:'confirmed', version:1 });
  await centerService.updateAppointment({ centerId:'CTR-A', appointmentId:'A-L', patch:{hospital:'รพ.ใหม่'}, requesterLineId:'OWNER-CTR-A' });
  await centerService.updateAppointment({ centerId:'CTR-A', appointmentId:'A-L', patch:{doctorName:'แพทย์ทดสอบ'}, requesterLineId:'OWNER-CTR-A' });
  const rows = await lifecycleRows('updated');
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((item) => item.meta.revision)).size, 2);
});

test('concurrent identical Center update converges to one Family and one Center revision', async () => {
  await linked();
  await db.Appointments.insert({ appointment_id:'A-L', care_profile_id:'CP-L', hospital:'รพ.เดิม', datetime:'2099-09-02T10:30:00+07:00', status:'confirmed', version:1 });
  const results = await Promise.all([
    centerService.updateAppointment({ centerId:'CTR-A', appointmentId:'A-L', patch:{hospital:'รพ.ใหม่'}, requesterLineId:'OWNER-CTR-A' }),
    centerService.updateAppointment({ centerId:'CTR-A', appointmentId:'A-L', patch:{hospital:'รพ.ใหม่'}, requesterLineId:'OWNER-CTR-A' }),
  ]);
  assert.equal(results.filter((item) => item.noChange).length, 1);
  assert.equal((await lifecycleRows('updated')).length, 2);
});

test('Center-linked cancellation queues both audiences once', async () => {
  await linked();
  await db.Appointments.insert({ appointment_id:'A-L', care_profile_id:'CP-L', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00', status:'confirmed' });
  await Promise.all([
    centerService.cancelAppointment({ centerId:'CTR-A', appointmentId:'A-L', requesterLineId:'OWNER-CTR-A' }),
    centerService.cancelAppointment({ centerId:'CTR-A', appointmentId:'A-L', requesterLineId:'OWNER-CTR-A' }),
  ]);
  const rows = await lifecycleRows('cancelled');
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((item) => item.meta.audience)).size, 2);
});

test('Center day-of reminder reaches Family and Center exactly once under concurrent execution', async () => {
  await linked();
  await db.Appointments.insert({ appointment_id:'A-L', care_profile_id:'CP-L', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00', status:'confirmed' });
  await Promise.all([
    reminderService.sendAppointmentReminders(new Date('2099-09-02T08:00:00+07:00')),
    reminderService.sendAppointmentReminders(new Date('2099-09-02T08:00:00+07:00')),
  ]);
  const rows = await db.NotificationOutbox.findWhere((item) => item.kind.includes('appointment_reminder'));
  assert.deepEqual(new Set(rows.map((item) => item.kind)), new Set(['appointment_reminder', 'appointment_reminder_center']));
  assert.equal(rows.length, 2);
});

test('Center one-day operational reminder is the existing tomorrow summary, once', async () => {
  await linked();
  await db.Appointments.insert({ appointment_id:'A-L', care_profile_id:'CP-L', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00', status:'confirmed' });
  await Promise.all([
    reminderService.sendTomorrowSummaryToCenters(new Date('2099-09-01T18:00:00+07:00')),
    reminderService.sendTomorrowSummaryToCenters(new Date('2099-09-01T18:00:00+07:00')),
  ]);
  assert.equal((await db.NotificationOutbox.findWhere((item) => item.kind === 'appointment_tomorrow_summary')).length, 1);
});

test('missing Center staff group never fails appointment persistence', async () => {
  await linked({ centerGroup:null });
  const result = await familyService.addAppointmentByFamily({
    careProfileId:'CP-L', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00',
    createdBy:'U-FAMILY', idempotencyKey:'missing-center-group',
  });
  assert.equal(result.ok, true);
  assert.equal(result.notificationState.center.reason, 'center_group_not_bound');
  assert.ok(await db.Appointments.findOne((item) => item.appointment_id === result.appointment.appointment_id));
});

test('shared Family group keeps P1 and P2 appointment intents distinct and identifiable', async () => {
  await independent({ profileId:'CP-1', owner:'U-1', name:'คุณพ่อ' });
  await independent({ profileId:'CP-2', owner:'U-2', name:'คุณแม่' });
  await db.GroupBindings.insert({ binding_id:'GB-1', kind:'family', care_profile_id:'CP-1', line_group_id:'G-SHARED', status:'active' });
  await db.GroupBindings.insert({ binding_id:'GB-2', kind:'family', care_profile_id:'CP-2', line_group_id:'G-SHARED', status:'active' });
  await familyService.addAppointmentByFamily({ careProfileId:'CP-1', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00', createdBy:'U-1', idempotencyKey:'shared-profile-one' });
  await familyService.addAppointmentByFamily({ careProfileId:'CP-2', hospital:'รพ.', datetime:'2099-09-03T10:30:00+07:00', createdBy:'U-2', idempotencyKey:'shared-profile-two' });
  const rows = (await lifecycleRows('created')).filter((item) => item.meta.audience === 'family');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((item) => item.to === 'G-SHARED'));
  assert.ok(rows.some((item) => item.messages[0].text.includes('คุณพ่อ')));
  assert.ok(rows.some((item) => item.messages[0].text.includes('คุณแม่')));
  assert.notEqual(rows[0].dedupe_key, rows[1].dedupe_key);
});

test('Center routing never uses another Center or an inactive binding', async () => {
  await linked({ centerId:'CTR-A', centerGroup:null });
  await db.GroupBindings.insert({ binding_id:'GB-A-OLD', kind:'center_staff', center_id:'CTR-A', line_group_id:'G-A-OLD', status:'inactive' });
  await db.GroupBindings.insert({ binding_id:'GB-B', kind:'center_staff', center_id:'CTR-B', line_group_id:'G-B', status:'active' });
  await familyService.addAppointmentByFamily({ careProfileId:'CP-L', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00', createdBy:'U-FAMILY', idempotencyKey:'center-isolation' });
  const centerRows = (await lifecycleRows('created')).filter((item) => item.meta.audience === 'center');
  assert.equal(centerRows.length, 0);
  assert.equal((await db.NotificationOutbox.findWhere((item) => item.to === 'G-B' || item.to === 'G-A-OLD')).length, 0);
});

test('independent profile cannot route to any Center group', async () => {
  await independent();
  await db.GroupBindings.insert({ binding_id:'GB-C', kind:'center_staff', center_id:'CTR-X', line_group_id:'G-C', status:'active' });
  await familyService.addAppointmentByFamily({ careProfileId:'CP-I', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00', createdBy:'U-FAMILY', idempotencyKey:'independent-no-center' });
  assert.equal((await lifecycleRows('created')).filter((item) => item.meta.audience === 'center').length, 0);
});

test('same create idempotency key converges to one appointment, one lifecycle intent and one transport prompt', async () => {
  await independent();
  const input = { careProfileId:'CP-I', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00', createdBy:'U-FAMILY', idempotencyKey:'same-create-request' };
  await Promise.all([familyService.addAppointmentByFamily(input), familyService.addAppointmentByFamily(input)]);
  assert.equal((await db.Appointments.findWhere(() => true)).length, 1);
  assert.equal((await lifecycleRows('created')).length, 1);
  assert.equal((await db.NotificationOutbox.findWhere((item) => item.kind === 'transport_choice_required')).length, 1);
  const texts = (await db.NotificationOutbox.findWhere(() => true)).map((item) => item.messages[0].text);
  assert.equal(texts.filter((text) => text.includes('มีนัดหมายใหม่')).length, 1);
  assert.equal(texts.filter((text) => text.includes('เลือกวิธีเดินทาง')).length, 1);
});

test('same idempotency key with a different payload is rejected', async () => {
  await independent();
  const first = await familyService.addAppointmentByFamily({ careProfileId:'CP-I', hospital:'รพ.หนึ่ง', datetime:'2099-09-02T10:30:00+07:00', createdBy:'U-FAMILY', idempotencyKey:'reuse-conflict-key' });
  const conflict = await familyService.addAppointmentByFamily({ careProfileId:'CP-I', hospital:'รพ.สอง', datetime:'2099-09-02T10:30:00+07:00', createdBy:'U-FAMILY', idempotencyKey:'reuse-conflict-key' });
  assert.equal(first.ok, true);
  assert.equal(conflict.ok, false);
  assert.equal((await db.Appointments.findWhere(() => true)).length, 1);
});

test('notification enqueue failure does not undo a valid appointment', async () => {
  await independent();
  const original = notificationService.enqueue;
  notificationService.enqueue = async () => { throw new Error('database temporarily unavailable'); };
  try {
    const result = await familyService.addAppointmentByFamily({ careProfileId:'CP-I', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00', createdBy:'U-FAMILY', idempotencyKey:'enqueue-failure' });
    assert.equal(result.ok, true);
    assert.equal(result.notificationState.family[0].reason, 'notification_enqueue_unavailable');
    assert.ok(await db.Appointments.findOne((item) => item.appointment_id === result.appointment.appointment_id));
  } finally {
    notificationService.enqueue = original;
  }
});

test('retry of the same material update can recover a previously unavailable enqueue without a new revision', async () => {
  await independent();
  await db.Appointments.insert({ appointment_id:'A-I', care_profile_id:'CP-I', hospital:'รพ.เดิม', datetime:'2099-09-02T10:30:00+07:00', status:'confirmed', version:1 });
  const original = notificationService.enqueue;
  notificationService.enqueue = async () => { throw new Error('database temporarily unavailable'); };
  try {
    const first = await familyService.updateFamilyAppointment({ careProfileId:'CP-I', appointmentId:'A-I', patch:{hospital:'รพ.ใหม่'}, requesterLineId:'U-FAMILY' });
    assert.equal(first.ok, true);
    assert.equal(first.notificationState.family[0].reason, 'notification_enqueue_unavailable');
  } finally {
    notificationService.enqueue = original;
  }
  const retry = await familyService.updateFamilyAppointment({ careProfileId:'CP-I', appointmentId:'A-I', patch:{hospital:'รพ.ใหม่'}, requesterLineId:'U-FAMILY' });
  assert.equal(retry.noChange, true);
  assert.equal(retry.appointment.version, 2);
  assert.equal((await lifecycleRows('updated')).length, 1);
});

test('notification delivery worker race sends one provider request', async () => {
  await independent();
  await familyService.addAppointmentByFamily({ careProfileId:'CP-I', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00', createdBy:'U-FAMILY', idempotencyKey:'worker-race' });
  lineClient.clearSentLog();
  await Promise.all([notificationService.processPending(), notificationService.processPending()]);
  const lifecyclePushes = lineClient.getSentLog().filter((item) => item.messages[0].text.includes('มีนัดหมายใหม่'));
  assert.equal(lifecyclePushes.length, 1);
});

test('Family actor cannot update another actor profile or a cross-profile appointment', async () => {
  await independent({ profileId:'CP-A', owner:'U-A' });
  await independent({ profileId:'CP-B', owner:'U-B' });
  await db.Appointments.insert({ appointment_id:'A-B', care_profile_id:'CP-B', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00', status:'confirmed' });
  assert.equal((await familyService.updateFamilyAppointment({ careProfileId:'CP-B', appointmentId:'A-B', patch:{hospital:'โจมตี'}, requesterLineId:'U-A' })).ok, false);
  assert.equal((await familyService.cancelFamilyAppointment({ careProfileId:'CP-A', appointmentId:'A-B', requesterLineId:'U-A' })).ok, false);
});

test('Center staff service cannot mutate another Center appointment', async () => {
  await linked({ centerId:'CTR-A' });
  await db.Centers.insert({ center_id:'CTR-B', owner_line_id:'OWNER-B', status:'active' });
  await db.Appointments.insert({ appointment_id:'A-L', care_profile_id:'CP-L', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00', status:'confirmed' });
  assert.equal((await centerService.updateAppointment({ centerId:'CTR-B', appointmentId:'A-L', patch:{hospital:'โจมตี'}, requesterLineId:'OWNER-B' })).ok, false);
  assert.equal((await centerService.cancelAppointment({ centerId:'CTR-B', appointmentId:'A-L', requesterLineId:'OWNER-B' })).ok, false);
});

test('Center document-confirm creation queues canonical Family and Center appointment intents', async () => {
  const center = await centerService.createCenter({ name:'ศูนย์ทดสอบ', ownerLineId:'U-OWNER' });
  await centerService.bindGroupToCenter({ centerId:center.center_id, groupId:'G-CENTER', requesterLineId:'U-OWNER' });
  const profile = await db.CareProfiles.insert({ care_profile_id:'CP-CARD', owner_line_id:'U-FAMILY', patient_name:'คุณยาย', status:'linked', center_id:center.center_id });
  await db.GroupBindings.insert({ binding_id:'GB-F-CARD', kind:'family', care_profile_id:'CP-CARD', line_group_id:'G-FAMILY', status:'active' });
  await db.Residents.insert({ resident_id:'R-CARD', center_id:center.center_id, care_profile_id:'CP-CARD', full_name:'คุณยาย', room:'101', status:'active' });
  await db.PendingCards.insert({
    card_id:'CARD-A', center_id:center.center_id, resident_id:'R-CARD', status:'pending', created_at:new Date().toISOString(),
    ai_result:{ documentType:'medical', appointment:{ hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00' }, medications:[] },
    edited_fields:[], submitted_by:'U-STAFF',
  });
  const confirmed = await cardService.confirmCard('CARD-A', 'U-OWNER', 'เจ้าของศูนย์');
  assert.equal(confirmed.ok, true);
  assert.deepEqual(new Set((await lifecycleRows('created')).map((item) => item.kind)), new Set(['appointment_created_family', 'appointment_created_center']));
});

test('Center document-confirm keeps appointment committed when the existing Family summary push fails', async () => {
  const center = await centerService.createCenter({ name:'ศูนย์ทดสอบ', ownerLineId:'U-OWNER' });
  await centerService.bindGroupToCenter({ centerId:center.center_id, groupId:'G-CENTER', requesterLineId:'U-OWNER' });
  await db.CareProfiles.insert({ care_profile_id:'CP-CARD', owner_line_id:'U-FAMILY', patient_name:'คุณยาย', status:'linked', center_id:center.center_id });
  await db.GroupBindings.insert({ binding_id:'GB-F-CARD', kind:'family', care_profile_id:'CP-CARD', line_group_id:'G-FAMILY', status:'active' });
  await db.Residents.insert({ resident_id:'R-CARD', center_id:center.center_id, care_profile_id:'CP-CARD', full_name:'คุณยาย', room:'101', status:'active' });
  await db.PendingCards.insert({ card_id:'CARD-FAIL', center_id:center.center_id, resident_id:'R-CARD', status:'pending', created_at:new Date().toISOString(), ai_result:{ documentType:'medical', appointment:{ hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00' }, medications:[] }, edited_fields:[], submitted_by:'U-STAFF' });
  const originalPush = lineClient.pushMessage;
  lineClient.pushMessage = async () => { throw new Error('LINE unavailable'); };
  try {
    const confirmed = await cardService.confirmCard('CARD-FAIL', 'U-OWNER', 'เจ้าของศูนย์');
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.sentToFamily, false);
    assert.equal(confirmed.queuedForLater, true);
    assert.equal((await db.Appointments.findWhere((item) => item.confirmed_from_card_id === 'CARD-FAIL')).length, 1);
    assert.equal((await db.PendingFamilyDeliveries.findWhere((item) => item.card_id === 'CARD-FAIL')).length, 1);
  } finally {
    lineClient.pushMessage = originalPush;
  }
});

test('lifecycle message and metadata contain no raw LINE/group/internal binding IDs', async () => {
  await linked();
  await familyService.addAppointmentByFamily({ careProfileId:'CP-L', hospital:'รพ.', datetime:'2099-09-02T10:30:00+07:00', createdBy:'U-FAMILY', idempotencyKey:'safe-copy-check' });
  for (const item of await lifecycleRows('created')) {
    const text = item.messages[0].text;
    assert.doesNotMatch(text, /CP-L|CTR-A|G-FAMILY|G-CENTER|U-FAMILY|GB-/);
    assert.equal('lineGroupId' in item.meta, false);
  }
});

test('Family appointment create UI prevents double submit without browser persistence', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'liff-app', 'family', 'index.html'), 'utf8');
  const start = html.indexOf('async function saveAppointment()');
  const end = html.indexOf('async function saveMedication()', start);
  const source = html.slice(start, end);
  assert.match(source, /appointmentCreateRequest\?\.inFlight/);
  assert.match(source, /button\.disabled=true/);
  assert.match(source, /idempotencyKey:request\.key/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});
