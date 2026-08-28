// tests/transportService.test.js — ทดสอบ FR-K, FR-L, FR-M (Flow ล่าสุด)

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const transportService = require('../backend/services/transportService');
const lineClient = require('../backend/providers/lineClient');

beforeEach(() => {
  db.resetAll();
  lineClient.clearSentLog();
});

async function setupLinkedProfile() {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G_CENTER', requesterLineId: 'U_OWNER' });
  const profile = await db.CareProfiles.insert({
    care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี ใจดี', center_id: center.center_id, status: 'linked',
  });
  return { center, profile };
}

test('FR-L1, L2: ครอบครัวเลือก "เราไปเอง" → จบกระบวนการ ไม่ส่งต่อศูนย์', async () => {
  const { center, profile } = await setupLinkedProfile();
  const plan = await transportService.createTransportPlan({ appointmentId: 'A1', careProfileId: profile.care_profile_id, centerId: center.center_id });

  const result = await transportService.familyChooseSelf(plan.plan_id, 'U_FAMILY');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 'family_handled');

  const updated = await db.TransportPlans.findOne((p) => p.plan_id === plan.plan_id);
  assert.strictEqual(updated.family_choice, 'self');
  assert.strictEqual(updated.family_decided_by, 'U_FAMILY');
});

test('Care Profile อิสระเลือกไปเองได้ และ concurrent confirm สร้าง transition/audit ครั้งเดียว', async () => {
  const profile = await db.CareProfiles.insert({
    care_profile_id:'CP-INDEPENDENT', owner_line_id:'U_FAMILY', patient_name:'คุณยายอิสระ', center_id:null, status:'independent',
  });
  const plan = await transportService.createTransportPlan({ appointmentId:'A-INDEPENDENT', careProfileId:profile.care_profile_id, centerId:null });

  const [first, second] = await Promise.all([
    transportService.familyChooseSelf(plan.plan_id, 'U_FAMILY'),
    transportService.familyChooseSelf(plan.plan_id, 'U_FAMILY'),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal([first, second].filter((result) => result.duplicate).length, 1);
  const updated = await db.TransportPlans.findOne((item) => item.plan_id === plan.plan_id);
  assert.equal(updated.center_id, null);
  assert.equal(updated.family_choice, 'self');
  assert.equal(updated.status, 'family_handled');
  assert.equal(updated.history.filter((item) => item.event === 'family_choice=self').length, 1);
  const audits = await db.AuditLog.findWhere((item) => item.action === 'transport.family_self' && item.meta?.planId === plan.plan_id);
  assert.equal(audits.length, 1);
});

test('เกณฑ์ยอมรับข้อ 8: กดให้ศูนย์จัดการ → การ์ดคำขอส่งไปกลุ่มงานศูนย์เท่านั้น', async () => {
  const { center, profile } = await setupLinkedProfile();
  const plan = await transportService.createTransportPlan({ appointmentId: 'A1', careProfileId: profile.care_profile_id, centerId: center.center_id });

  const result = await transportService.familyRequestCenter(plan.plan_id, 'U_FAMILY');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 'awaiting_center');

  const sentToGroup = lineClient.getSentLog().find((s) => s.type === 'push' && s.to === 'G_CENTER');
  assert.ok(sentToGroup, 'ต้องส่งการ์ดคำขอไปกลุ่มงานศูนย์');
});

test('ข้อ L4: ศูนย์ต้องเลือกได้แค่ center_own หรือ care2go เท่านั้น ไม่มีตัวเลือกปฏิเสธ', async () => {
  const { center, profile } = await setupLinkedProfile();
  const plan = await transportService.createTransportPlan({ appointmentId: 'A1', careProfileId: profile.care_profile_id, centerId: center.center_id });
  await transportService.familyRequestCenter(plan.plan_id, 'U_FAMILY');

  const invalidChoice = await transportService.centerChoose(plan.plan_id, 'decline', 'U_OWNER', {});
  assert.strictEqual(invalidChoice.ok, false, 'ต้องไม่มีตัวเลือกปฏิเสธในระบบ');
});

test('เกณฑ์ยอมรับข้อ 9, L5: ศูนย์เลือกจัดการเอง → สถานะเป็นตัวการ ครอบครัวเห็นราคาและผู้ออกใบเสร็จ', async () => {
  const { center, profile } = await setupLinkedProfile();
  await transportService.updateRateCard(center.center_id, { escort_enabled: true, escort_price: 800, vehicle_enabled: true, vehicle_price: 600 }, 'U_OWNER');

  const plan = await transportService.createTransportPlan({ appointmentId: 'A1', careProfileId: profile.care_profile_id, centerId: center.center_id });
  await transportService.familyRequestCenter(plan.plan_id, 'U_FAMILY');

  const result = await transportService.centerChoose(plan.plan_id, 'center_own', 'U_OWNER', { needs: ['escort', 'vehicle'] });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.liabilityMode, 'principal');

  const familyMsg = lineClient.getSentLog().find((s) => s.type === 'push' && s.to === 'U_FAMILY');
  assert.ok(familyMsg.messages[0].text.includes('800'));
  assert.ok(familyMsg.messages[0].text.includes('ออกใบเสร็จโดยศูนย์'));
});

test('เกณฑ์ยอมรับข้อ 10, L6: ศูนย์เลือกใช้ Care2Go → สถานะเป็นตัวแทน ครอบครัวเห็นว่า Care2Go ติดต่อตรง', async () => {
  const { center, profile } = await setupLinkedProfile();
  const plan = await transportService.createTransportPlan({ appointmentId: 'A1', careProfileId: profile.care_profile_id, centerId: center.center_id });
  await transportService.familyRequestCenter(plan.plan_id, 'U_FAMILY');

  const result = await transportService.centerChoose(plan.plan_id, 'care2go', 'U_OWNER', { needs: ['vehicle'] });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.liabilityMode, 'agent');
  assert.ok(result.care2goBookingId);

  const familyMsg = lineClient.getSentLog().find((s) => s.type === 'push' && s.to === 'U_FAMILY');
  assert.ok(familyMsg.messages[0].text.includes('Care2Go จะติดต่อคุณโดยตรง'));
  assert.ok(familyMsg.messages[0].text.includes('ออกใบเสร็จโดย Care2Go'));
});

test('Care2Go: ผูกกลุ่มปฏิบัติการแล้วคำขอจากศูนย์ส่งรายละเอียดต้นทาง ปลายทาง วันเวลา และเบอร์ติดต่อ', async () => {
  const center = await centerService.createCenter({ name:'สาขาสุขุมวิท', ownerLineId:'U_OWNER', address:'สุขุมวิท 50 กรุงเทพฯ', contactPhone:'0812345678' });
  const profile = await db.CareProfiles.insert({ care_profile_id:'CP-1', owner_line_id:'U_FAMILY', patient_name:'สมศรี ใจดี', center_id:center.center_id, status:'linked' });
  await db.Residents.insert({ resident_id:'R-1', center_id:center.center_id, care_profile_id:profile.care_profile_id, full_name:'สมศรี ใจดี', status:'active' });
  await db.Appointments.insert({ appointment_id:'A1', care_profile_id:profile.care_profile_id, hospital:'โรงพยาบาลกลาง', datetime:'2026-09-01T09:00:00+07:00' });
  await transportService.bindCare2goOperationsGroup('G_CARE2GO', 'U_OPS');
  const plan = await transportService.createTransportPlan({ appointmentId:'A1', careProfileId:profile.care_profile_id, centerId:center.center_id });
  await transportService.familyRequestCenter(plan.plan_id, 'U_FAMILY');
  const result = await transportService.centerChoose(plan.plan_id, 'care2go', 'U_OWNER', { needs:['vehicle'] });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.operationsNotified, true);
  const sent = lineClient.getSentLog().find((s) => s.to === 'G_CARE2GO');
  assert.ok(sent);
  const serialized = JSON.stringify(sent.messages[0]);
  for (const expected of ['สาขาสุขุมวิท','สุขุมวิท 50','โรงพยาบาลกลาง','0812345678','2026-09-01']) assert.ok(serialized.includes(expected));
});

test('Care2Go: ญาติเลือกโดยตรงแล้วแจ้งกลุ่มแบบข้อมูลอย่างเดียว ไม่มีปุ่มรับงาน', async () => {
  const { center, profile } = await setupLinkedProfile();
  await db.Appointments.insert({ appointment_id:'A1', care_profile_id:profile.care_profile_id, hospital:'รพ.ทดสอบ', datetime:'2026-09-01T09:00:00+07:00' });
  await transportService.bindCare2goOperationsGroup('G_CARE2GO', 'U_OPS');
  const plan = await transportService.createTransportPlan({ appointmentId:'A1', careProfileId:profile.care_profile_id, centerId:center.center_id });
  const requested = await transportService.familyRequestCare2go(plan.plan_id, 'U_FAMILY');
  assert.strictEqual(requested.ok, true);
  assert.strictEqual(requested.operationsNotified, true);
  const sent = lineClient.getSentLog().find((s) => s.to === 'G_CARE2GO');
  const serialized = JSON.stringify(sent.messages[0]);
  assert.ok(serialized.includes('กรุณาโทรประสานผู้ติดต่อโดยตรง'));
  assert.ok(!serialized.includes('care2go_ack'));
  assert.ok(!serialized.includes('care2go_confirm'));
});

test('เกณฑ์ยอมรับข้อ 11, M2: ปิดบริการค่ารถ → ศูนย์เลือก "จัดการเอง" สำหรับรถไม่ได้', async () => {
  const { center, profile } = await setupLinkedProfile();
  await transportService.updateRateCard(center.center_id, { escort_enabled: true, escort_price: 800, vehicle_enabled: false, vehicle_price: 0 }, 'U_OWNER');

  const plan = await transportService.createTransportPlan({ appointmentId: 'A1', careProfileId: profile.care_profile_id, centerId: center.center_id });
  await transportService.familyRequestCenter(plan.plan_id, 'U_FAMILY');

  const result = await transportService.centerChoose(plan.plan_id, 'center_own', 'U_OWNER', { needs: ['vehicle'] });
  assert.strictEqual(result.ok, false, 'ศูนย์ปิดบริการรถ ต้องเลือกจัดการเองสำหรับรถไม่ได้');
  assert.ok(result.reason.includes('รถรับส่ง'));

  // แต่ยังเลือก Care2Go สำหรับรถได้ตามปกติ
  const viaCare2go = await transportService.centerChoose(plan.plan_id, 'care2go', 'U_OWNER', { needs: ['vehicle'] });
  assert.strictEqual(viaCare2go.ok, true);
});

test('ข้อ L8: ศูนย์เปลี่ยนการตัดสินใจได้ก่อนถึงนัด พร้อมบันทึกประวัติ', async () => {
  const { center, profile } = await setupLinkedProfile();
  const plan = await transportService.createTransportPlan({ appointmentId: 'A1', careProfileId: profile.care_profile_id, centerId: center.center_id });
  await transportService.familyRequestCenter(plan.plan_id, 'U_FAMILY');
  await transportService.centerChoose(plan.plan_id, 'center_own', 'U_OWNER', { needs: [] });

  const changed = await transportService.centerChangeChoice(plan.plan_id, 'care2go', 'U_OWNER', { needs: ['vehicle'] });
  assert.strictEqual(changed.ok, true);
  assert.strictEqual(changed.liabilityMode, 'agent');

  const updated = await db.TransportPlans.findOne((p) => p.plan_id === plan.plan_id);
  assert.ok(updated.history.length >= 2, 'ต้องมีประวัติการเปลี่ยนบันทึกไว้');
});

test('ข้อ L11: Care2Go จัดหาไม่ได้ → แจ้งกลับและส่งสถานะกลับให้ศูนย์ตัดสินใจใหม่', async () => {
  const { center, profile } = await setupLinkedProfile();
  const plan = await transportService.createTransportPlan({ appointmentId: 'A1', careProfileId: profile.care_profile_id, centerId: center.center_id });
  await transportService.familyRequestCenter(plan.plan_id, 'U_FAMILY');
  await transportService.centerChoose(plan.plan_id, 'care2go', 'U_OWNER', { needs: ['vehicle'] });

  const futureDate = new Date(Date.now() + 20 * 3600000).toISOString(); // นัดอีก 20 ชม. (เกิน 12 ชม. เส้นตาย)
  const result = await transportService.markCare2goUnavailable(plan.plan_id, futureDate);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.metDeadline, true);

  const updated = await db.TransportPlans.findOne((p) => p.plan_id === plan.plan_id);
  assert.strictEqual(updated.status, 'awaiting_center', 'ต้องกลับไปให้ศูนย์ตัดสินใจใหม่');

  const centerMsg = lineClient.getSentLog().find((s) => s.to === 'G_CENTER' && s.messages[0].text.includes('ไม่สามารถจัดหา'));
  assert.ok(centerMsg);
});

test('M6: เฉพาะเจ้าของ/ผู้จัดการเท่านั้นที่แก้ไข Rate Card ได้', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const rc = await transportService.updateRateCard(center.center_id, { escort_enabled: true, escort_price: 500 }, 'U_OWNER');
  assert.strictEqual(rc.escort_price, 500);
  assert.strictEqual(rc.updated_by, 'U_OWNER');
});

// ── FR-L10 ──
async function setupAwaitingFamilyPlan(hoursUntilAppt) {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G_CENTER', requesterLineId: 'U_OWNER' });
  const profile = await db.CareProfiles.insert({
    care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี ใจดี', center_id: center.center_id, status: 'linked',
  });
  const referenceDate = new Date('2569-08-18T08:00:00+07:00');
  const apptDate = new Date(referenceDate.getTime() + hoursUntilAppt * 3600000);
  await db.Appointments.insert({ appointment_id: 'A1', care_profile_id: profile.care_profile_id, hospital: 'รพ.ทดสอบ', datetime: apptDate.toISOString() });
  const plan = await transportService.createTransportPlan({ appointmentId: 'A1', careProfileId: profile.care_profile_id, centerId: center.center_id });
  return { center, profile, plan, referenceDate };
}

test('ข้อ L10: เหลือ 12 ชม. → เตือนครอบครัวจังหวะแรก (ยังไม่รบกวนศูนย์)', async () => {
  const { plan, referenceDate } = await setupAwaitingFamilyPlan(10); // อยู่ในช่วง 6-12 ชม.
  const result = await transportService.remindPendingFamilyChoices(referenceDate);
  assert.strictEqual(result.reminded, 1);

  const familyMsg = lineClient.getSentLog().find((s) => s.to === 'U_FAMILY');
  const centerMsg = lineClient.getSentLog().find((s) => s.to === 'G_CENTER');
  assert.ok(familyMsg, 'ต้องเตือนครอบครัว');
  assert.ok(familyMsg.messages[0].text.includes('12 ชั่วโมง'));
  assert.strictEqual(centerMsg, undefined, 'จังหวะแรกยังไม่ต้องรบกวนศูนย์');

  const updated = await db.TransportPlans.findOne((p) => p.plan_id === plan.plan_id);
  assert.deepStrictEqual(updated.reminder_stages_sent, ['stage_12h']);
});

test('ข้อ L10: เหลือ 6 ชม. → เตือนครอบครัวจังหวะสุดท้าย และแจ้งศูนย์ด้วย', async () => {
  const { plan, referenceDate } = await setupAwaitingFamilyPlan(4); // อยู่ในช่วง 0-6 ชม.
  const result = await transportService.remindPendingFamilyChoices(referenceDate);
  assert.strictEqual(result.reminded, 1);

  const familyMsg = lineClient.getSentLog().find((s) => s.to === 'U_FAMILY');
  const centerMsg = lineClient.getSentLog().find((s) => s.to === 'G_CENTER');
  assert.ok(familyMsg.messages[0].text.includes('6 ชั่วโมง'));
  assert.ok(centerMsg, 'จังหวะสุดท้ายต้องแจ้งศูนย์ด้วย');
  assert.ok(centerMsg.messages[0].text.includes('6 ชั่วโมง'));

  const updated = await db.TransportPlans.findOne((p) => p.plan_id === plan.plan_id);
  assert.deepStrictEqual(updated.reminder_stages_sent, ['stage_6h']);
});

test('ข้อ L10: เตือนรวมไม่เกิน 2 ครั้งต่อนัด แม้ระบบจะเช็คทุก 30 นาที', async () => {
  const { plan, referenceDate } = await setupAwaitingFamilyPlan(10);

  // จำลองการเช็คซ้ำหลายรอบในช่วง 12 ชม. — ต้องเตือนแค่ครั้งเดียว
  for (let i = 0; i < 5; i++) {
    await transportService.remindPendingFamilyChoices(new Date(referenceDate.getTime() + i * 30 * 60000));
  }
  let pushCount = lineClient.getSentLog().filter((s) => s.to === 'U_FAMILY').length;
  assert.strictEqual(pushCount, 1, 'ช่วง 12 ชม. ต้องเตือนแค่ครั้งเดียว');

  // ข้ามมาช่วง 6 ชม. แล้วเช็คซ้ำอีกหลายรอบ
  const sixHourMark = new Date(referenceDate.getTime() + 5 * 3600000);
  for (let i = 0; i < 5; i++) {
    await transportService.remindPendingFamilyChoices(new Date(sixHourMark.getTime() + i * 30 * 60000));
  }
  pushCount = lineClient.getSentLog().filter((s) => s.to === 'U_FAMILY').length;
  assert.strictEqual(pushCount, 2, 'รวมทั้งหมดต้องเตือนแค่ 2 ครั้งเท่านั้น');
});

test('ข้อ L10: นัดเหลือมากกว่า 12 ชม. ยังไม่ต้องเตือน', async () => {
  const { referenceDate } = await setupAwaitingFamilyPlan(48); // เหลือ 48 ชม. ยังไม่ถึงจังหวะแรก
  const result = await transportService.remindPendingFamilyChoices(referenceDate);
  assert.strictEqual(result.reminded, 0);
});

test('ข้อ L10: เตือนจังหวะเดิมไปแล้ว ต้องไม่เตือนซ้ำในจังหวะเดียวกัน', async () => {
  const { referenceDate } = await setupAwaitingFamilyPlan(10);
  const first = await transportService.remindPendingFamilyChoices(referenceDate);
  assert.strictEqual(first.reminded, 1);

  lineClient.clearSentLog();
  const second = await transportService.remindPendingFamilyChoices(referenceDate);
  assert.strictEqual(second.reminded, 0, 'จังหวะเดิมต้องไม่เตือนซ้ำ');
  assert.strictEqual(lineClient.getSentLog().length, 0);
});

test('ข้อ L10: นัดที่ผ่านไปแล้ว ไม่ต้องเตือน (กันข้อมูลเก่าค้าง)', async () => {
  const { referenceDate } = await setupAwaitingFamilyPlan(-5); // นัดผ่านไปแล้ว 5 ชม.
  const result = await transportService.remindPendingFamilyChoices(referenceDate);
  assert.strictEqual(result.reminded, 0);
});

test('ข้อ L10: แผนที่ครอบครัวตัดสินใจไปแล้ว (ไม่ใช่ awaiting_family) ต้องไม่ถูกเตือน', async () => {
  const { plan, referenceDate } = await setupAwaitingFamilyPlan(10);
  await transportService.familyChooseSelf(plan.plan_id, 'U_FAMILY');
  const result = await transportService.remindPendingFamilyChoices(referenceDate);
  assert.strictEqual(result.reminded, 0);
});
