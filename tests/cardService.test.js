// tests/cardService.test.js — ทดสอบ FR-C, D, E, F (หัวใจของระบบ)

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const cardService = require('../backend/services/cardService');
const aiProvider = require('../backend/providers/aiProvider');
const lineClient = require('../backend/providers/lineClient');

beforeEach(() => {
  db.resetAll();
  aiProvider.clearMockQueue();
  lineClient.clearSentLog();
});

async function setupCenterWithResident() {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G_CENTER', requesterLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี', aliases: ['คุณแม่สมศรี'] });
  return { center, resident };
}

test('เกณฑ์ยอมรับข้อ 10: รูปที่ไม่ใช่เอกสารทางการแพทย์ต้องถูกปฏิเสธ ไม่สร้างการ์ด', async () => {
  const { center } = await setupCenterWithResident();
  aiProvider.queueMockResponse({ documentType: 'unrelated', unrelatedNote: 'รูปนี้ดูเหมือนเป็นรูปอาหาร' });

  const result = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });
  assert.strictEqual(result.rejected, true);
  assert.ok(result.reason.includes('รูปอาหาร'));

  const allCards = await db.PendingCards.findAll();
  assert.strictEqual(allCards.length, 0, 'ห้ามสร้างการ์ดถ้ารูปไม่เกี่ยวข้อง');
});

test('FR-D2: มั่นใจสูง จับคู่ชื่อได้ตรงเป๊ะ → ไปสถานะ pending ทันที', async () => {
  const { center, resident } = await setupCenterWithResident();
  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: '' },
    medications: [], doctorNote: null,
  });

  const result = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });
  assert.strictEqual(result.needsSelection, false);
  assert.strictEqual(result.card.resident_id, resident.resident_id);
  assert.strictEqual(result.card.status, 'pending');
});

test('FR-D3: ชื่อไม่ชัดเจนหรือใกล้เคียงหลายคน → ต้องถาม ห้ามเดา', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G1', requesterLineId: 'U_OWNER' });
  await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี รักดี' }); // ชื่อใกล้เคียงกันมาก

  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี', nameConfidence: 0.5,
    appointment: null, medications: [], doctorNote: null,
  });

  const result = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });
  assert.strictEqual(result.needsSelection, true, 'ชื่อกำกวมต้องถามเสมอ');
  assert.ok(result.candidates.length >= 1);

  const card = await db.PendingCards.findOne((c) => c.card_id === result.card.card_id);
  assert.strictEqual(card.status, 'awaiting_selection');
  assert.strictEqual(card.resident_id, null, 'ห้ามเดาแล้วเลือกให้เอง');
});

test('ผู้พักเกิน 13 คน — candidates ต้องไม่เกิน 13 (ข้อจำกัด Quick Reply)', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G1', requesterLineId: 'U_OWNER' });
  for (let i = 0; i < 20; i++) {
    await centerService.addResident({ centerId: center.center_id, fullName: `ผู้พักทดสอบ ${i}` });
  }
  aiProvider.queueMockResponse({ documentType: 'medical', nameGuess: 'ไม่ทราบชื่อ', nameConfidence: 0.1, appointment: null, medications: [], doctorNote: null });

  const result = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });
  assert.ok(result.candidates.length <= 13, `candidates ต้องไม่เกิน 13 แต่ได้ ${result.candidates.length}`);
});

test('ข้อ C3/G2: ปฏิเสธเมื่อ AI อ่านวันที่เป็นอดีต ไม่สร้างการ์ดผิด', async () => {
  const { center } = await setupCenterWithResident();
  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2020-01-01T09:00:00', note: '' },
    medications: [], doctorNote: null,
  });
  const result = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });
  assert.strictEqual(result.rejected, true);
  assert.ok(result.reason.includes('ผ่านมาแล้ว'));
});

test('เกณฑ์ยอมรับข้อ 4, F1: ข้อมูลไม่ถูกส่งให้ครอบครัวจนกว่าจะยืนยัน', async () => {
  const { center } = await setupCenterWithResident();
  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: '' }, medications: [], doctorNote: null,
  });
  await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });

  const sentLog = lineClient.getSentLog();
  const pushedToFamily = sentLog.filter((s) => s.type === 'push');
  assert.strictEqual(pushedToFamily.length, 0, 'ยังไม่ยืนยัน ห้ามมี Push ใดๆ ออกไปหาครอบครัว');
});

test('เกณฑ์ยอมรับข้อ 5, E9: กดยืนยันซ้ำต้องไม่ส่งข้อมูลซ้ำ', async () => {
  const { center, resident } = await setupCenterWithResident();
  // แต่งตั้งผู้จัดการคนที่สอง เพื่อทดสอบว่าคนละคนกดยืนยันซ้ำก็ไม่ส่งซ้ำ
  await centerService.appointManager({ centerId: center.center_id, targetLineId: 'U_MANAGER2', requesterLineId: 'U_OWNER' });

  const profile = await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี ใจดี', center_id: center.center_id, status: 'linked' });
  await db.Residents.update((r) => r.resident_id === resident.resident_id, { care_profile_id: profile.care_profile_id });

  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: '' }, medications: [], doctorNote: null,
  });
  const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });

  const first = await cardService.confirmCard(card.card_id, 'U_OWNER', 'พี่นวล');
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.sentToFamily, true);

  const second = await cardService.confirmCard(card.card_id, 'U_MANAGER2', 'พี่หน่อย');
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.alreadyConfirmed, true);

  const pushCount = lineClient.getSentLog().filter((s) => s.type === 'push').length;
  assert.strictEqual(pushCount, 1, 'ต้องส่งแค่ครั้งเดียวแม้กดยืนยันซ้ำ');
});

test('เกณฑ์ยอมรับข้อ 6, E10: การ์ดหมดอายุแล้วยืนยันไม่ได้', async () => {
  const { center } = await setupCenterWithResident();
  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: '' }, medications: [], doctorNote: null,
  });
  const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });

  // จำลองว่าการ์ดถูกสร้างเมื่อ 25 ชั่วโมงที่แล้ว (เกิน 24 ชม.)
  await db.PendingCards.update((c) => c.card_id === card.card_id, {
    created_at: new Date(Date.now() - 25 * 3600000).toISOString(),
  });

  const result = await cardService.confirmCard(card.card_id, 'U_OWNER', 'พี่นวล');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.expired, true);
});

test('F2: ข้อความที่ส่งให้ครอบครัวต้องระบุชื่อผู้ตรวจสอบ', async () => {
  const { center, resident } = await setupCenterWithResident();
  const profile = await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี ใจดี', center_id: center.center_id, status: 'linked' });
  await db.Residents.update((r) => r.resident_id === resident.resident_id, { care_profile_id: profile.care_profile_id });

  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: '' }, medications: [], doctorNote: null,
  });
  const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });
  await cardService.confirmCard(card.card_id, 'U_OWNER', 'พี่นวล');

  const pushed = lineClient.getSentLog().find((s) => s.type === 'push');
  assert.ok(pushed.messages[0].text.includes('ตรวจสอบโดย พี่นวล'));
});

test('F3: ครอบครัวยังไม่ผูกบัญชี → เก็บคิว ไม่ error', async () => {
  const { center } = await setupCenterWithResident(); // ไม่ผูก Care Profile เลย
  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: '' }, medications: [], doctorNote: null,
  });
  const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });
  const result = await cardService.confirmCard(card.card_id, 'U_OWNER', 'พี่นวล');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.sentToFamily, false);
  assert.strictEqual(result.queuedForLater, true);
});

test('G2 ชั้นที่ 2: แก้ไขการ์ดให้เป็นวันที่อดีตต้องถูกปฏิเสธ', async () => {
  const { center } = await setupCenterWithResident();
  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: '' }, medications: [], doctorNote: null,
  });
  const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });

  const patchResult = await cardService.patchCard(card.card_id, {
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2020-01-01T09:00:00' }, editedFields: ['appointment.datetime'],
  });
  assert.strictEqual(patchResult.ok, false);
});

test('E4: รูปต้นฉบับต้องถูกเก็บไว้ในการ์ด เพื่อให้หน้าแก้ไขแสดงเทียบได้', async () => {
  const { center } = await setupCenterWithResident();
  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: '' }, medications: [], doctorNote: null,
  });
  const fakeImage = Buffer.from('fake-jpeg-bytes-for-testing');
  const result = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: fakeImage });

  assert.ok(result.card.image_base64, 'ต้องเก็บรูปไว้เป็น Base64');
  assert.strictEqual(Buffer.from(result.card.image_base64, 'base64').toString(), fakeImage.toString());

  const forEdit = await cardService.getCardForEdit(result.card.card_id);
  assert.strictEqual(forEdit.imageBase64, result.card.image_base64, 'getCardForEdit ต้องคืนรูปด้วยเสมอ (ข้อ E4)');
});

test('E8: editedFields ต้องบันทึกว่าช่องไหนถูกแก้ไขโดยมนุษย์', async () => {
  const { center } = await setupCenterWithResident();
  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: '' }, medications: [], doctorNote: null,
  });
  const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });

  const result = await cardService.patchCard(card.card_id, {
    appointment: { hospital: 'รพ.รามาฯ', datetime: '2099-01-01T09:00:00' }, editedFields: ['appointment.hospital'],
  });
  assert.strictEqual(result.ok, true);
  assert.ok(result.card.edited_fields.includes('appointment.hospital'));
});

test('ข้อ F4 (แก้ไขแล้ว): ข้อความยืนยันที่ส่งให้ครอบครัวต้องแนบปุ่มแจ้งข้อมูลไม่ถูกต้องเสมอ', async () => {
  const { center, resident } = await setupCenterWithResident();
  const profile = await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี ใจดี', center_id: center.center_id, status: 'linked' });
  await db.Residents.update((r) => r.resident_id === resident.resident_id, { care_profile_id: profile.care_profile_id });

  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: '' }, medications: [], doctorNote: null,
  });
  const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });
  await cardService.confirmCard(card.card_id, 'U_OWNER', 'พี่นวล');

  const pushed = lineClient.getSentLog().find((s) => s.type === 'push');
  const quickReplyItems = pushed.messages[0].quickReply?.items || [];
  assert.strictEqual(quickReplyItems.length, 1);
  assert.strictEqual(quickReplyItems[0].action.label, '⚠️ ข้อมูลไม่ถูกต้อง');
  assert.ok(quickReplyItems[0].action.data.includes(card.card_id));
});

test('ข้อ F4: ครอบครัวแจ้งข้อมูลผิด → ต้องแจ้งกลับกลุ่มงานศูนย์ทันที', async () => {
  const { center, resident } = await setupCenterWithResident();
  const profile = await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี ใจดี', center_id: center.center_id, status: 'linked' });
  await db.Residents.update((r) => r.resident_id === resident.resident_id, { care_profile_id: profile.care_profile_id });

  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: '' }, medications: [], doctorNote: null,
  });
  const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });
  await cardService.confirmCard(card.card_id, 'U_OWNER', 'พี่นวล');
  lineClient.clearSentLog(); // เคลียร์ Log การส่งครอบครัวก่อน เพื่อดูเฉพาะผลของการแจ้งปัญหา

  const result = await cardService.reportCardIssue(card.card_id, 'U_FAMILY', 'วันนัดผิด ควรเป็นวันที่ 20 ไม่ใช่ 15');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.notifiedCenter, true);

  const centerMsg = lineClient.getSentLog().find((s) => s.to === 'G_CENTER');
  assert.ok(centerMsg, 'ต้องแจ้งกลับกลุ่มงานศูนย์');
  assert.ok(centerMsg.messages[0].text.includes('ไม่ถูกต้อง'));
  assert.ok(centerMsg.messages[0].text.includes('วันนัดผิด'));
});

test('ข้อ F4: แจ้งปัญหาก่อนที่การ์ดจะถูกยืนยันไม่ได้ (ป้องกันแจ้งข้อมูลที่ยังไม่ส่งจริง)', async () => {
  const { center } = await setupCenterWithResident();
  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: '' }, medications: [], doctorNote: null,
  });
  const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });

  const result = await cardService.reportCardIssue(card.card_id, 'U_FAMILY', null);
  assert.strictEqual(result.ok, false);
});

test('ข้อ J5 (แก้ไขแล้ว): นัดที่บันทึกจากรูปศูนย์ต้องระบุ source_center_id ชัดเจน (ไม่ใช่แค่ care_profile_id ทางอ้อม)', async () => {
  const { center, resident } = await setupCenterWithResident();
  const profile = await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี ใจดี', center_id: center.center_id, status: 'linked' });
  await db.Residents.update((r) => r.resident_id === resident.resident_id, { care_profile_id: profile.care_profile_id });

  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: '' },
    medications: [{ name: 'Metformin', dose: '500mg' }], doctorNote: null,
  });
  const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });
  await cardService.confirmCard(card.card_id, 'U_OWNER', 'พี่นวล');

  const appt = await db.Appointments.findOne((a) => a.care_profile_id === profile.care_profile_id);
  assert.strictEqual(appt.source_center_id, center.center_id, 'ต้องรู้ว่าข้อมูลนี้มาจากศูนย์ไหนโดยตรง ไม่ต้องอนุมานผ่าน Resident');
  assert.strictEqual(appt.source, 'center_photo');

  const med = await db.Medications.findOne((m) => m.care_profile_id === profile.care_profile_id);
  assert.strictEqual(med.source_center_id, center.center_id);
});

test('ข้อ J5: นัดที่ครอบครัวบันทึกเองต้องระบุ source_center_id เป็น null อย่างชัดเจน (ไม่ใช่ไม่มี Field เลย)', async () => {
  const familyService = require('../backend/services/familyService');
  const profile = await familyService.createIndependentProfile({ ownerLineId: 'U1', patientName: 'ทองดี' });
  const result = await familyService.addAppointmentByFamily({ careProfileId: profile.care_profile_id, hospital: 'รพ.ทดสอบ', datetime: '2099-01-01T09:00:00', createdBy: 'U1' });

  assert.strictEqual('source_center_id' in result.appointment, true, 'Field ต้องมีอยู่ใน Record แม้ค่าจะเป็น null');
  assert.strictEqual(result.appointment.source_center_id, null);
  assert.strictEqual(result.appointment.source, 'family_manual');
});
