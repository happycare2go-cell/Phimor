// tests/centerService.test.js — ทดสอบ FR-A, FR-B, FR-J

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');

beforeEach(() => db.resetAll());

test('FR-A1: สร้างศูนย์แล้วเจ้าของมีสิทธิ์ owner ทันที', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const staff = await centerService.listStaff(center.center_id);
  assert.strictEqual(staff.length, 1);
  assert.strictEqual(staff[0].role, 'owner');
});

test('FR-A2, A3: ผูกกลุ่มไลน์งานศูนย์ — เฉพาะเจ้าของ/ผู้จัดการเท่านั้น', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });

  const byOutsider = await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G1', requesterLineId: 'U_STRANGER' });
  assert.strictEqual(byOutsider.ok, false, 'คนนอกไม่ควรผูกกลุ่มได้');

  const byOwner = await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G1', requesterLineId: 'U_OWNER' });
  assert.strictEqual(byOwner.ok, true);

  const rebind = await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G2', requesterLineId: 'U_OWNER' });
  assert.strictEqual(rebind.replacedPrevious, true, 'ผูกกลุ่มใหม่ต้องรู้ว่าทับของเดิม');
});

test('FR-A4: เฉพาะเจ้าของเท่านั้นที่แต่งตั้งผู้จัดการได้', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });

  const byOwner = await centerService.appointManager({ centerId: center.center_id, targetLineId: 'U_MGR', requesterLineId: 'U_OWNER' });
  assert.strictEqual(byOwner.ok, true);

  const byManager = await centerService.appointManager({ centerId: center.center_id, targetLineId: 'U_MGR2', requesterLineId: 'U_MGR' });
  assert.strictEqual(byManager.ok, false, 'ผู้จัดการต้องแต่งตั้งผู้จัดการคนอื่นไม่ได้');
});

test('FR-B2, B7: เพิ่มผู้พักแล้วได้ลิงก์เชิญทันที', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const { resident, inviteUrl, inviteExpiresAt } = await centerService.addResident({
    centerId: center.center_id, fullName: 'สมศรี ใจดี', aliases: ['คุณแม่สมศรี'], room: '203', familyPhone: '0812345678',
  });
  assert.strictEqual(resident.status, 'active');
  assert.ok(inviteUrl.includes('token='));
  assert.ok(new Date(inviteExpiresAt) > new Date());
});

test('เกณฑ์ยอมรับข้อ 1: เพิ่มผู้พักใหม่แล้วปรากฏในรายชื่อทันที', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  const list = await centerService.listResidents(center.center_id);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].full_name, 'สมศรี ใจดี');
});

test('FR-B5, B6: จำหน่ายผู้พักออก — เพิกถอนสิทธิ์ศูนย์ทันที แต่ Care Profile ยังอยู่กับครอบครัว', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });

  // จำลองว่าผูก Care Profile แล้ว
  const profile = await db.CareProfiles.insert({
    care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี ใจดี',
    center_id: center.center_id, status: 'linked',
  });
  await db.Residents.update((r) => r.resident_id === resident.resident_id, { care_profile_id: profile.care_profile_id });

  const result = await centerService.dischargeResident(resident.resident_id, 'U_OWNER');
  assert.strictEqual(result.ok, true);
  assert.ok(result.familyNotice.includes('ข้อมูลทั้งหมดยังอยู่กับคุณ'));

  const updatedResident = await db.Residents.findOne((r) => r.resident_id === resident.resident_id);
  assert.strictEqual(updatedResident.status, 'discharged');

  const updatedProfile = await db.CareProfiles.findOne((p) => p.care_profile_id === profile.care_profile_id);
  assert.strictEqual(updatedProfile.status, 'independent', 'ต้องเปลี่ยนเป็นอิสระอัตโนมัติ (ข้อ N6)');
  assert.strictEqual(updatedProfile.center_id, null);
});

test('ข้อ B6 (แก้ไขแล้ว): จำหน่ายผู้พักออกต้อง Push ข้อความไปหาครอบครัวจริง ไม่ใช่แค่คืนค่าให้ศูนย์เห็น', async () => {
  const lineClient = require('../backend/providers/lineClient');
  lineClient.clearSentLog();

  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  const profile = await db.CareProfiles.insert({
    care_profile_id: 'CP-2', owner_line_id: 'U_FAMILY_2', patient_name: 'สมศรี ใจดี',
    center_id: center.center_id, status: 'linked',
  });
  await db.Residents.update((r) => r.resident_id === resident.resident_id, { care_profile_id: profile.care_profile_id });

  const result = await centerService.dischargeResident(resident.resident_id, 'U_OWNER');
  assert.strictEqual(result.familyNotified, true, 'ต้องยืนยันว่าส่งสำเร็จ');

  const pushed = lineClient.getSentLog().find((s) => s.type === 'push' && s.to === 'U_FAMILY_2');
  assert.ok(pushed, 'ต้องมีการ Push ข้อความไปหาเจ้าของ Care Profile จริง');
  assert.ok(pushed.messages[0].text.includes('ข้อมูลทั้งหมดยังอยู่กับคุณ'));
});

test('ข้อ B6: ถ้ามีกลุ่มไลน์ครอบครัวผูกไว้ ต้องส่งเข้ากลุ่ม ไม่ใช่ส่งหาตัวบุคคล', async () => {
  const lineClient = require('../backend/providers/lineClient');
  lineClient.clearSentLog();

  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  const profile = await db.CareProfiles.insert({
    care_profile_id: 'CP-3', owner_line_id: 'U_FAMILY_3', patient_name: 'สมศรี ใจดี',
    center_id: center.center_id, status: 'linked',
  });
  await db.Residents.update((r) => r.resident_id === resident.resident_id, { care_profile_id: profile.care_profile_id });
  await db.GroupBindings.insert({ binding_id: 'GB-1', care_profile_id: profile.care_profile_id,
    line_group_id: 'G_FAMILY_TEST', kind: 'family', status:'active', bound_at: db.now() });

  await centerService.dischargeResident(resident.resident_id, 'U_OWNER');
  const pushed = lineClient.getSentLog().find((s) => s.type === 'push');
  assert.strictEqual(pushed.to, 'G_FAMILY_TEST');
});

test('ข้อ K1, K2 (แก้ไขแล้ว): ตารางนัดของศูนย์ต้องแสดงทุกผู้พัก เรียงตามเวลา และไฮไลต์รายการที่ยังไม่ตัดสินใจ', async () => {
  const transportService = require('../backend/services/transportService');
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });

  const { resident: r1 } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  const p1 = await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_F1', patient_name: 'สมศรี ใจดี', center_id: center.center_id, status: 'linked' });
  await db.Residents.update((r) => r.resident_id === r1.resident_id, { care_profile_id: p1.care_profile_id });
  await db.Appointments.insert({ appointment_id: 'A-LATE', care_profile_id: p1.care_profile_id, hospital: 'รพ.ทีหลัง', datetime: '2099-01-05T09:00:00' });

  const { resident: r2 } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมชาย ใจดี' });
  const p2 = await db.CareProfiles.insert({ care_profile_id: 'CP-2', owner_line_id: 'U_F2', patient_name: 'สมชาย ใจดี', center_id: center.center_id, status: 'linked' });
  await db.Residents.update((r) => r.resident_id === r2.resident_id, { care_profile_id: p2.care_profile_id });
  await db.Appointments.insert({ appointment_id: 'A-EARLY', care_profile_id: p2.care_profile_id, hospital: 'รพ.ก่อน', datetime: '2099-01-01T09:00:00' });

  // นัดของ r2 มี Transport Plan ตัดสินใจแล้ว ส่วนของ r1 ยังไม่มีเลย
  await transportService.createTransportPlan({ appointmentId: 'A-EARLY', careProfileId: p2.care_profile_id, centerId: center.center_id });

  const rows = await centerService.getCenterAppointments(center.center_id);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].appointmentId, 'A-EARLY', 'ต้องเรียงตามเวลาก่อนหลัง (ข้อ K1)');
  assert.strictEqual(rows[1].appointmentId, 'A-LATE');

  assert.strictEqual(rows[1].needsAttention, true, 'นัดที่ยังไม่มี Transport Plan เลยต้องถูกไฮไลต์ (ข้อ K2)');
  assert.strictEqual(rows[0].needsAttention, true, 'สถานะ awaiting_family ก็ยังถือว่าต้องให้ความสนใจอยู่');
});

test('ข้อ G3: ตารางนัดของศูนย์ต้องไม่แสดงนัดที่ผ่านไปแล้ว', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  const profile = await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_F1', patient_name: 'สมศรี ใจดี', center_id: center.center_id, status: 'linked' });
  await db.Residents.update((r) => r.resident_id === resident.resident_id, { care_profile_id: profile.care_profile_id });
  await db.Appointments.insert({ appointment_id: 'A-OLD', care_profile_id: profile.care_profile_id, hospital: 'รพ.เก่า', datetime: '2020-01-01T09:00:00' });
  await db.Appointments.insert({ appointment_id: 'A-NEW', care_profile_id: profile.care_profile_id, hospital: 'รพ.ใหม่', datetime: '2099-01-01T09:00:00' });

  const rows = await centerService.getCenterAppointments(center.center_id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].appointmentId, 'A-NEW');
});

test('เกณฑ์ยอมรับข้อ 7: จำหน่ายออกแล้ว ศูนย์เรียก API ดูข้อมูลไม่ได้ (ทดสอบระดับ Query)', async () => {
  const { centerCanAccessResident } = require('../backend/middleware/auth');
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });

  const beforeDischarge = await centerCanAccessResident(center.center_id, resident.resident_id);
  assert.strictEqual(beforeDischarge, true);

  await centerService.dischargeResident(resident.resident_id, 'U_OWNER');
  const afterDischarge = await centerCanAccessResident(center.center_id, resident.resident_id);
  assert.strictEqual(afterDischarge, false, 'จำหน่ายออกแล้วต้องเข้าถึงไม่ได้แม้เรียกตรงระดับ Query');
});

test('FR-J1: นำเข้ารายชื่อแบบชุด ตรวจชื่อซ้ำก่อนบันทึก', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });

  const result = await centerService.importResidentsBulk(center.center_id, [
    { fullName: 'สมศรี ใจดี' },   // ซ้ำ ต้องข้าม
    { fullName: 'สมชาย ใจดี' },   // ใหม่
  ]);
  assert.strictEqual(result.imported.length, 1);
  assert.strictEqual(result.skippedDuplicates.length, 1);
});

test('ข้อ O1 (แก้ไขแล้ว): เพิ่มผู้พักด้วยเบอร์ที่ตรงกับ Care Profile อิสระเดิม ต้องส่งคำขอเชื่อมต่อ ไม่เชื่อมทันที', async () => {
  const familyService = require('../backend/services/familyService');

  // ครอบครัวสร้าง Care Profile อิสระเองไว้ก่อนแล้ว พร้อมเบอร์โทร
  const profile = await familyService.createIndependentProfile({
    ownerLineId: 'U_FAMILY_EXIST', patientName: 'สมหญิง ใจงาม', familyPhone: '0899999999',
  });

  const centerB = await centerService.createCenter({ name: 'ศูนย์ใหม่', ownerLineId: 'U_OWNER_B' });
  const { accessRequestSent } = await centerService.addResident({
    centerId: centerB.center_id, fullName: 'สมหญิง ใจงาม', familyPhone: '0899999999',
  });

  assert.strictEqual(accessRequestSent, true, 'ต้องส่งคำขอเชื่อมต่ออัตโนมัติเมื่อเจอเบอร์ตรงกัน');

  // ยืนยันว่ายังไม่เชื่อมทันที (ต้องรอครอบครัวอนุมัติก่อน)
  const stillIndependent = await db.CareProfiles.findOne((p) => p.care_profile_id === profile.care_profile_id);
  assert.strictEqual(stillIndependent.center_id, null, 'ห้ามเชื่อมอัตโนมัติ ต้องรอครอบครัวอนุมัติ');

  const requests = await db.AccessRequests.findWhere((r) => r.care_profile_id === profile.care_profile_id);
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].center_id, centerB.center_id);
});

test('เพิ่มผู้พักด้วยเบอร์ใหม่ที่ไม่เคยมีในระบบ ต้องไม่ส่งคำขอเชื่อมต่อใดๆ', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const { accessRequestSent } = await centerService.addResident({
    centerId: center.center_id, fullName: 'คนใหม่ไม่เคยมี', familyPhone: '0800000000',
  });
  assert.strictEqual(accessRequestSent, false);
});
