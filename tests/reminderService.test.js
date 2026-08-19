// tests/reminderService.test.js — ทดสอบ FR-G (แจ้งเตือนนัด 2 จังหวะ) FR-I (สรุปรายสัปดาห์)

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const familyService = require('../backend/services/familyService');
const reminderService = require('../backend/services/reminderService');
const lineClient = require('../backend/providers/lineClient');

beforeEach(() => {
  db.resetAll();
  lineClient.clearSentLog();
});

function atHour(date, h) {
  const d = new Date(date);
  d.setHours(h, 0, 0, 0);
  return d;
}

test('FR-G1: นัดพรุ่งนี้ต้องถูกเตือนแบบ day_before', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U_FAMILY', patientName: 'ทองดี' });
  const today = new Date('2569-08-18T08:00:00+07:00');
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  await db.Appointments.insert({
    appointment_id: 'A1', care_profile_id: profile.care_profile_id,
    hospital: 'รพ.จุฬาฯ', datetime: atHour(tomorrow, 9).toISOString(),
  });

  const result = await reminderService.sendAppointmentReminders(today);
  assert.strictEqual(result.sent, 1);

  const pushed = lineClient.getSentLog().find((s) => s.to === 'U_FAMILY');
  assert.ok(pushed.messages[0].text.includes('พรุ่งนี้มีนัด'));
});

test('FR-G1: นัดวันนี้ต้องถูกเตือนแบบ same_day', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U_FAMILY', patientName: 'ทองดี' });
  const today = new Date('2569-08-18T08:00:00+07:00');
  await db.Appointments.insert({
    appointment_id: 'A1', care_profile_id: profile.care_profile_id,
    hospital: 'รพ.จุฬาฯ', datetime: atHour(today, 14).toISOString(),
  });

  const result = await reminderService.sendAppointmentReminders(today);
  assert.strictEqual(result.sent, 1);
  const pushed = lineClient.getSentLog().find((s) => s.to === 'U_FAMILY');
  assert.ok(pushed.messages[0].text.includes('วันนี้มีนัด'));
});

test('นัดที่ไม่ตรงกับวันนี้หรือพรุ่งนี้ ต้องไม่ถูกเตือน', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U_FAMILY', patientName: 'ทองดี' });
  const today = new Date('2569-08-18T08:00:00+07:00');
  const nextWeek = new Date(today); nextWeek.setDate(nextWeek.getDate() + 7);
  await db.Appointments.insert({
    appointment_id: 'A1', care_profile_id: profile.care_profile_id,
    hospital: 'รพ.จุฬาฯ', datetime: atHour(nextWeek, 9).toISOString(),
  });

  const result = await reminderService.sendAppointmentReminders(today);
  assert.strictEqual(result.sent, 0);
});

test('กันเตือนซ้ำ: เรียกซ้ำด้วยวันเดียวกัน ไม่ส่งซ้ำสอง', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U_FAMILY', patientName: 'ทองดี' });
  const today = new Date('2569-08-18T08:00:00+07:00');
  await db.Appointments.insert({
    appointment_id: 'A1', care_profile_id: profile.care_profile_id,
    hospital: 'รพ.จุฬาฯ', datetime: atHour(today, 14).toISOString(),
  });

  const first = await reminderService.sendAppointmentReminders(today);
  const second = await reminderService.sendAppointmentReminders(today);
  assert.strictEqual(first.sent, 1);
  assert.strictEqual(second.sent, 0, 'เรียกซ้ำต้องไม่นับว่าส่งเพิ่มอีก');

  const pushCount = lineClient.getSentLog().filter((s) => s.type === 'push').length;
  assert.strictEqual(pushCount, 1, 'ต้องมีข้อความออกไปแค่ครั้งเดียวเท่านั้น');
});

test('นัดเดียวกันอาจถูกเตือนทั้งสองจังหวะได้ถ้าเรียกคนละวัน (day_before แล้วค่อย same_day)', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U_FAMILY', patientName: 'ทองดี' });
  const day1 = new Date('2569-08-18T08:00:00+07:00');
  const day2 = new Date('2569-08-19T08:00:00+07:00'); // วันถัดมา = วันนัดจริง
  await db.Appointments.insert({
    appointment_id: 'A1', care_profile_id: profile.care_profile_id,
    hospital: 'รพ.จุฬาฯ', datetime: atHour(day2, 9).toISOString(),
  });

  const r1 = await reminderService.sendAppointmentReminders(day1); // เตือนล่วงหน้า
  const r2 = await reminderService.sendAppointmentReminders(day2); // เตือนวันนัดจริง
  assert.strictEqual(r1.sent, 1);
  assert.strictEqual(r2.sent, 1);

  const texts = lineClient.getSentLog().map((s) => s.messages[0].text);
  assert.ok(texts.some((t) => t.includes('พรุ่งนี้มีนัด')));
  assert.ok(texts.some((t) => t.includes('วันนี้มีนัด')));
});

test('ครอบครัวที่ผูกกลุ่มไลน์ไว้ ต้องส่งเข้ากลุ่ม ไม่ใช่ส่งหาตัวบุคคล', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U_FAMILY', patientName: 'ทองดี' });
  await familyService.bindFamilyGroup({ careProfileId: profile.care_profile_id, groupId: 'G_FAMILY', requesterLineId: 'U_FAMILY' });

  const today = new Date('2569-08-18T08:00:00+07:00');
  await db.Appointments.insert({
    appointment_id: 'A1', care_profile_id: profile.care_profile_id,
    hospital: 'รพ.จุฬาฯ', datetime: atHour(today, 14).toISOString(),
  });

  await reminderService.sendAppointmentReminders(today);
  const pushed = lineClient.getSentLog().find((s) => s.type === 'push');
  assert.strictEqual(pushed.to, 'G_FAMILY', 'ต้องส่งเข้ากลุ่มที่ผูกไว้ ไม่ใช่ส่งหาตัวบุคคลเจ้าของโปรไฟล์');
});

// ── FR-I ──
async function setupCenterWithUpcomingAppt(daysFromNow) {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G_CENTER', requesterLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  const profile = await db.CareProfiles.insert({
    care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี ใจดี', center_id: center.center_id, status: 'linked',
  });
  await db.Residents.update((r) => r.resident_id === resident.resident_id, { care_profile_id: profile.care_profile_id });

  const today = new Date('2569-08-18T08:00:00+07:00');
  const apptDate = new Date(today); apptDate.setDate(apptDate.getDate() + daysFromNow);
  await db.Appointments.insert({
    appointment_id: 'A1', care_profile_id: profile.care_profile_id, hospital: 'รพ.จุฬาฯ', datetime: atHour(apptDate, 9).toISOString(),
  });
  return { center, today };
}

test('FR-I1: สรุปรายสัปดาห์ส่งเข้ากลุ่มงานศูนย์ เมื่อมีนัดในสัปดาห์นั้น', async () => {
  const { center, today } = await setupCenterWithUpcomingAppt(3); // นัดอีก 3 วัน อยู่ในสัปดาห์นี้แน่นอน
  const result = await reminderService.sendWeeklySummary(today);
  assert.strictEqual(result.sent, 1);

  const pushed = lineClient.getSentLog().find((s) => s.to === 'G_CENTER');
  assert.ok(pushed);
  assert.ok(pushed.messages[0].text.includes('สมศรี ใจดี'));
  assert.ok(pushed.messages[0].text.includes('รพ.จุฬาฯ'));
});

test('FR-I2: ศูนย์ไม่ต้องดำเนินการใดๆ — ไม่มีนัดในสัปดาห์นี้ ไม่ส่งข้อความรบกวน', async () => {
  const { center, today } = await setupCenterWithUpcomingAppt(20); // นัดอีก 20 วัน เกินสัปดาห์นี้
  const result = await reminderService.sendWeeklySummary(today);
  assert.strictEqual(result.sent, 0, 'ไม่ควรส่งข้อความถ้าไม่มีนัดในสัปดาห์นี้ เพื่อไม่ให้ศูนย์เบื่อข้อความที่ไม่มีประโยชน์');
});

test('ศูนย์ที่ยังไม่ผูกกลุ่มไลน์ ไม่ถูกส่งสรุป (ป้องกัน error)', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ยังไม่ผูกกลุ่ม', ownerLineId: 'U_OWNER2' });
  const result = await reminderService.sendWeeklySummary(new Date('2569-08-18T08:00:00+07:00'));
  assert.strictEqual(result.sent, 0);
});

// ── FR-K3 ──
test('ข้อ K3 (แก้ไขแล้ว): สรุปนัดพรุ่งนี้ส่งเข้ากลุ่มงานศูนย์ เมื่อมีนัดวันพรุ่งนี้จริง', async () => {
  const { center, today } = await setupCenterWithUpcomingAppt(1); // นัดพรุ่งนี้พอดี
  const result = await reminderService.sendTomorrowSummaryToCenters(today);
  assert.strictEqual(result.sent, 1);

  const pushed = lineClient.getSentLog().find((s) => s.to === 'G_CENTER');
  assert.ok(pushed);
  assert.ok(pushed.messages[0].text.includes('สรุปนัดพรุ่งนี้'));
  assert.ok(pushed.messages[0].text.includes('สมศรี ใจดี'));
});

test('ข้อ K3: ไม่มีนัดพรุ่งนี้ ต้องไม่ส่งข้อความรบกวนศูนย์', async () => {
  const { center, today } = await setupCenterWithUpcomingAppt(5); // นัดอีก 5 วัน ไม่ใช่พรุ่งนี้
  const result = await reminderService.sendTomorrowSummaryToCenters(today);
  assert.strictEqual(result.sent, 0);
});

test('ข้อ K3: ต้องระบุชัดว่ารายการไหน "ยังไม่ได้จัดการเดินทาง" (ยังค้างอยู่)', async () => {
  const transportService = require('../backend/services/transportService');
  const { center, today } = await setupCenterWithUpcomingAppt(1);

  const result = await reminderService.sendTomorrowSummaryToCenters(today);
  const pushed = lineClient.getSentLog().find((s) => s.to === 'G_CENTER');
  assert.ok(pushed.messages[0].text.includes('ยังไม่ได้จัดการเดินทาง'), 'ยังไม่มี Transport Plan เลย ต้องถูกทำเครื่องหมายว่าค้างอยู่');
});
