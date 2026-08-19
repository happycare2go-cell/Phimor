// tests/familyService.test.js — ทดสอบ FR-H, FR-N

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const familyService = require('../backend/services/familyService');

beforeEach(() => db.resetAll());

test('เกณฑ์ยอมรับข้อ 9: หน้ายินยอม PDPA ต้องบันทึกก่อนถึงจะผูกบัญชีได้', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const { resident, inviteUrl } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  const token = inviteUrl.split('token=')[1];

  const withoutConsent = await familyService.hasValidConsent('U_FAMILY');
  assert.strictEqual(withoutConsent, false);

  await familyService.recordConsent('U_FAMILY', true);
  const withConsent = await familyService.hasValidConsent('U_FAMILY');
  assert.strictEqual(withConsent, true);
});

test('เกณฑ์ยอมรับข้อ 8: ผูกบัญชีแล้วเห็นข้อมูลย้อนหลังครบ (ผ่านคิวที่เก็บไว้ก่อนผูก)', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const { inviteUrl } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  const token = inviteUrl.split('token=')[1];

  const result = await familyService.acceptInvite(token, 'U_FAMILY');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.careProfile.owner_line_id, 'U_FAMILY');
  assert.strictEqual(result.careProfile.status, 'linked');

  // ใช้ลิงก์ซ้ำต้องไม่ได้
  const reuse = await familyService.acceptInvite(token, 'U_OTHER');
  assert.strictEqual(reuse.ok, false);
});

test('ลิงก์เชิญหมดอายุแล้วใช้ไม่ได้', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const { resident, inviteUrl } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  const token = inviteUrl.split('token=')[1];
  await db.Invites.update((i) => i.invite_token === token, { expires_at: new Date(Date.now() - 1000).toISOString() });

  const result = await familyService.acceptInvite(token, 'U_FAMILY');
  assert.strictEqual(result.ok, false);
  assert.ok(result.reason.includes('หมดอายุ'));
});

test('FR-N1: ครอบครัวสร้าง Care Profile อิสระเองได้โดยไม่ผ่านศูนย์', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U_FAMILY', patientName: 'คุณยายทองดี' });
  assert.strictEqual(profile.status, 'independent');
  assert.strictEqual(profile.center_id, null);
});

test('เกณฑ์ยอมรับข้อ 18: Care Profile อิสระใช้ AI ไม่ได้ แต่ฟีเจอร์พื้นฐานใช้ได้', async () => {
  const independent = await familyService.createIndependentProfile({ ownerLineId: 'U1', patientName: 'ทองดี' });
  assert.strictEqual(familyService.canUseAiFeatures(independent), false);

  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const linked = await db.CareProfiles.insert({
    care_profile_id: 'CP-2', owner_line_id: 'U2', patient_name: 'สมศรี', center_id: center.center_id, status: 'linked',
  });
  assert.strictEqual(familyService.canUseAiFeatures(linked), true);
});

test('G2: ครอบครัวบันทึกนัดเป็นอดีตไม่ได้', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U1', patientName: 'ทองดี' });
  const result = await familyService.addAppointmentByFamily({
    careProfileId: profile.care_profile_id, hospital: 'รพ.ทดสอบ', datetime: '2020-01-01T09:00:00', createdBy: 'U1',
  });
  assert.strictEqual(result.ok, false);
});

test('G3: นัดที่ผ่านไปแล้วไม่ปรากฏในรายการนัดใกล้ถึง', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U1', patientName: 'ทองดี' });
  await db.Appointments.insert({ appointment_id: 'A1', care_profile_id: profile.care_profile_id, hospital: 'รพ.เก่า', datetime: '2020-01-01T09:00:00' });
  await familyService.addAppointmentByFamily({ careProfileId: profile.care_profile_id, hospital: 'รพ.ใหม่', datetime: '2099-01-01T09:00:00', createdBy: 'U1' });

  const upcoming = await familyService.getUpcomingAppointments(profile.care_profile_id);
  assert.strictEqual(upcoming.length, 1);
  assert.strictEqual(upcoming[0].hospital, 'รพ.ใหม่');

  const history = await familyService.getFullHistory(profile.care_profile_id);
  assert.strictEqual(history.appointments.length, 2, 'ประวัติทั้งหมดต้องยังมีนัดเก่าอยู่');
});

test('FR-N1: ผูกกลุ่มไลน์ครอบครัวด้วยตนเองได้ เฉพาะเจ้าของ', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U1', patientName: 'ทองดี' });
  const byOwner = await familyService.bindFamilyGroup({ careProfileId: profile.care_profile_id, groupId: 'G1', requesterLineId: 'U1' });
  assert.strictEqual(byOwner.ok, true);

  const byOther = await familyService.bindFamilyGroup({ careProfileId: profile.care_profile_id, groupId: 'G2', requesterLineId: 'U_STRANGER' });
  assert.strictEqual(byOther.ok, false);
});

test('FR-H4: ส่งออก PDF จริง — ได้ไฟล์ PDF ที่ถูกต้อง กรองตามช่วงวันที่', async () => {
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U1', patientName: 'คุณยายทองดี' });
  await db.CareProfiles.update((p) => p.care_profile_id === profile.care_profile_id, { blood_type: 'O+', height_cm: 150, weight_kg: 52 });

  await db.Appointments.insert({ appointment_id: 'A1', care_profile_id: profile.care_profile_id, hospital: 'รพ.ในช่วง', datetime: '2050-06-15T09:00:00+07:00' });
  await db.Appointments.insert({ appointment_id: 'A2', care_profile_id: profile.care_profile_id, hospital: 'รพ.นอกช่วง', datetime: '2060-01-01T09:00:00+07:00' });
  await db.Medications.insert({ medication_id: 'M1', care_profile_id: profile.care_profile_id, name: 'Paracetamol', dose: '500mg' });

  const result = await familyService.exportHistoryToPdf(profile.care_profile_id, { fromDate: '2050-01-01', toDate: '2050-12-31' });
  assert.strictEqual(result.ok, true);
  assert.ok(Buffer.isBuffer(result.pdfBuffer), 'ต้องได้ Buffer ของไฟล์ PDF จริง');
  assert.ok(result.pdfBuffer.length > 1000, 'ไฟล์ PDF ต้องมีเนื้อหาจริง ไม่ใช่ไฟล์ว่าง');
  assert.strictEqual(result.pdfBuffer.slice(0, 4).toString(), '%PDF', 'ต้องขึ้นต้นด้วย PDF Header ที่ถูกต้อง');
  assert.strictEqual(result.recordCount, 2, 'ต้องกรองนัดนอกช่วงวันที่ออก เหลือแค่ 1 นัด + 1 ยา');
});
