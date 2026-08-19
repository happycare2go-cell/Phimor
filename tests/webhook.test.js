// tests/webhook.test.js — ทดสอบ Flow เต็มผ่าน HTTP จริง (join → ส่งรูป → ยืนยัน)

const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const aiProvider = require('../backend/providers/aiProvider');
const lineClient = require('../backend/providers/lineClient');

let server, baseUrl;

before(async () => {
  const app = require('../backend/server');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  db.resetAll();
  aiProvider.clearMockQueue();
  lineClient.clearSentLog();
});

async function postWebhook(events) {
  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }),
  });
  await new Promise((r) => setTimeout(r, 60)); // เผื่อเวลาให้ประมวลผลแบบ async เสร็จก่อนตรวจสอบผล
  return res;
}

test('GET /health ต้องตอบ 200', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'ok');
});

test('Flow เต็มผ่าน HTTP: พนักงานทักในกลุ่ม → ส่งรูปส่วนตัว → ผู้จัดการยืนยัน → ครอบครัวได้รับ', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G_CENTER', requesterLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี ใจดี', center_id: center.center_id, status: 'linked' });
  await db.Residents.update((r) => r.resident_id === resident.resident_id, { care_profile_id: 'CP-1' });

  // ① พนักงานทักในกลุ่มหนึ่งครั้ง เพื่อให้ระบบรู้ว่าเป็นพนักงานของศูนย์ไหน
  await postWebhook([{
    type: 'message', replyToken: 'RT0', message: { type: 'text', text: 'สวัสดีครับ' },
    source: { type: 'group', groupId: 'G_CENTER', userId: 'U_STAFF' },
  }]);
  const staffRow = await db.CenterStaff.findOne((x) => x.line_user_id === 'U_STAFF');
  assert.ok(staffRow, 'ระบบต้องบันทึกพนักงานอัตโนมัติจากการทักในกลุ่ม');
  assert.strictEqual(staffRow.role, 'staff');

  // ② พนักงานส่งรูปในแชทส่วนตัว
  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: 'งดน้ำงดอาหาร' },
    medications: [{ name: 'Metformin', dose: '500mg หลังอาหารเช้า' }], doctorNote: null,
  });
  await postWebhook([{
    type: 'message', replyToken: 'RT1', message: { type: 'image', mockBase64: Buffer.from('fake').toString('base64') },
    source: { type: 'user', userId: 'U_STAFF' },
  }]);

  const cards = await db.PendingCards.findAll();
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].submitted_by, 'U_STAFF', 'ต้องบันทึกว่าใครเป็นคนส่งรูป');

  // ③ การ์ดต้องถูกส่งเข้าแชทส่วนตัวของเจ้าของ ไม่ใช่เข้ากลุ่ม
  const toOwner = lineClient.getSentLog().find((x) => x.type === 'push' && x.to === 'U_OWNER');
  const toGroup = lineClient.getSentLog().find((x) => x.type === 'push' && x.to === 'G_CENTER');
  assert.ok(toOwner, 'การ์ดยืนยันต้องส่งเข้าแชทส่วนตัวของผู้มีสิทธิ์อนุมัติ');
  assert.strictEqual(toGroup, undefined, 'ต้องไม่ส่งการ์ดยืนยันเข้ากลุ่มงานศูนย์');

  // ④ พนักงานทั่วไปกดยืนยันไม่ได้
  const staffTry = await postWebhook([{
    type: 'postback', replyToken: 'RT2', postback: { data: `action=confirm_card&cardId=${cards[0].card_id}` },
    source: { type: 'user', userId: 'U_STAFF' },
  }]);
  let updatedCard = await db.PendingCards.findOne((x) => x.card_id === cards[0].card_id);
  assert.strictEqual(updatedCard.status, 'pending', 'พนักงานทั่วไปต้องยืนยันไม่ได้');

  // ⑤ ผู้จัดการยืนยัน
  await postWebhook([{
    type: 'postback', replyToken: 'RT3', postback: { data: `action=confirm_card&cardId=${cards[0].card_id}` },
    source: { type: 'user', userId: 'U_OWNER' },
  }]);
  updatedCard = await db.PendingCards.findOne((x) => x.card_id === cards[0].card_id);
  assert.strictEqual(updatedCard.status, 'confirmed');

  const familyPush = lineClient.getSentLog().find((x) => x.type === 'push' && x.to === 'U_FAMILY');
  assert.ok(familyPush, 'ครอบครัวต้องได้รับข้อความหลังผู้จัดการยืนยัน');
});

test('ส่งรูปในกลุ่มงานศูนย์ ต้องไม่ประมวลผล และแนะนำให้ส่งส่วนตัวแทน', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G_CENTER', requesterLineId: 'U_OWNER' });

  await postWebhook([{
    type: 'message', replyToken: 'RT1', message: { type: 'image', mockBase64: 'x' },
    source: { type: 'group', groupId: 'G_CENTER', userId: 'U_STAFF' },
  }]);

  const cards = await db.PendingCards.findAll();
  assert.strictEqual(cards.length, 0, 'รูปในกลุ่มต้องไม่ถูกประมวลผลเลย');
  const reply = lineClient.getSentLog().find((x) => x.type === 'reply');
  assert.ok(reply.messages[0].text.includes('แชทส่วนตัว'));
});

test('พนักงานที่ระบบยังไม่รู้จัก ส่งรูปส่วนตัว ต้องได้คำแนะนำให้ทักในกลุ่มก่อน', async () => {
  await postWebhook([{
    type: 'message', replyToken: 'RT1', message: { type: 'image', mockBase64: 'x' },
    source: { type: 'user', userId: 'U_UNKNOWN_STAFF' },
  }]);
  const reply = lineClient.getSentLog().find((x) => x.type === 'reply');
  assert.ok(reply.messages[0].text.includes('กลุ่มงานศูนย์'));
  const cards = await db.PendingCards.findAll();
  assert.strictEqual(cards.length, 0);
});

test('กลุ่มที่ไม่ได้ผูกกับศูนย์ใด ทักข้อความมา ต้องไม่บันทึกเป็นพนักงาน', async () => {
  await postWebhook([{
    type: 'message', replyToken: 'RT1', message: { type: 'text', text: 'สวัสดี' },
    source: { type: 'group', groupId: 'G_UNKNOWN', userId: 'U_RANDOM' },
  }]);
  const staff = await db.CenterStaff.findOne((x) => x.line_user_id === 'U_RANDOM');
  assert.strictEqual(staff, null, 'กลุ่มที่ไม่ผูกกับศูนย์ใด ต้องไม่บันทึกใครเป็นพนักงาน');
});

test('ข้อ A2: เชิญเข้ากลุ่มโดยเจ้าของศูนย์ → ผูกกลุ่มอัตโนมัติ', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await postWebhook([{ type: 'join', source: { type: 'group', groupId: 'G_NEW', userId: 'U_OWNER' } }]);

  const updated = await db.Centers.findOne((c) => c.center_id === center.center_id);
  assert.strictEqual(updated.group_id, 'G_NEW');
});

test('ข้อ N4 (แก้ไขแล้ว): Care Profile อิสระส่งรูปแบบ 1-1 ต้องได้ข้อความสุภาพที่เสนอทางเลือก ไม่ใช่ข้อความปฏิเสธทั่วไป', async () => {
  const familyService = require('../backend/services/familyService');
  await familyService.createIndependentProfile({ ownerLineId: 'U_INDEPENDENT', patientName: 'คุณยายทองดี' });

  await postWebhook([{
    type: 'message', replyToken: 'RT1', message: { type: 'image', mockBase64: 'x' },
    source: { type: 'user', userId: 'U_INDEPENDENT' },
  }]);

  const reply = lineClient.getSentLog().find((s) => s.type === 'reply');
  assert.strictEqual(reply.messages[0].text, familyService.AI_RESTRICTED_MESSAGE);
  assert.ok(reply.messages[0].text.includes('บันทึกนัดด้วยการพิมพ์ได้เลย'), 'ต้องเสนอทางเลือกที่ใช้ได้ ไม่ใช่แค่บอกว่าทำไม่ได้');
});

test('ข้อ N4: ผู้ใช้ที่ไม่มี Care Profile เลย ส่งรูปแบบ 1-1 ยังได้ข้อความทั่วไปตามเดิม', async () => {
  await postWebhook([{
    type: 'message', replyToken: 'RT1', message: { type: 'image', mockBase64: 'x' },
    source: { type: 'user', userId: 'U_UNKNOWN' },
  }]);
  const reply = lineClient.getSentLog().find((s) => s.type === 'reply');
  assert.ok(reply.messages[0].text.includes('กลุ่มงานศูนย์'));
});

test('ข้อ N4: ครอบครัวที่ผูกกับศูนย์แล้ว (linked) ส่งรูปแบบ 1-1 ไม่ควรได้ข้อความปฏิเสธ AI แบบผู้ใช้อิสระ', async () => {
  const familyService = require('../backend/services/familyService');
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_LINKED', patient_name: 'สมศรี', center_id: center.center_id, status: 'linked' });

  await postWebhook([{
    type: 'message', replyToken: 'RT1', message: { type: 'image', mockBase64: 'x' },
    source: { type: 'user', userId: 'U_LINKED' },
  }]);
  const reply = lineClient.getSentLog().find((s) => s.type === 'reply');
  assert.notStrictEqual(reply.messages[0].text, familyService.AI_RESTRICTED_MESSAGE, 'ผู้ใช้ linked ไม่ใช่กรณีที่ N4 พูดถึง ควรได้ข้อความทั่วไปแทน');
});

test('ข้อ C5: ส่งรูปเกินอัตราที่กำหนดในหนึ่งนาที ต้องถูกปฏิเสธและแจ้งให้รอ', async () => {
  const rateLimiter = require('../backend/utils/rateLimiter');
  rateLimiter.reset();

  const center = await centerService.createCenter({ name: 'ศูนย์จำกัดอัตรา', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G_RATE', requesterLineId: 'U_OWNER' });

  // ลงทะเบียนพนักงานก่อน (ทักในกลุ่มหนึ่งครั้ง)
  await postWebhook([{
    type: 'message', replyToken: 'RT0', message: { type: 'text', text: 'สวัสดี' },
    source: { type: 'group', groupId: 'G_RATE', userId: 'U_RATE_STAFF' },
  }]);

  // ค่าเริ่มต้น 5 ครั้ง/นาที/ผู้ใช้ — ยิง 5 ครั้งแรกต้องผ่าน
  for (let i = 0; i < 5; i++) {
    aiProvider.queueMockResponse({ documentType: 'unrelated', unrelatedNote: 'ทดสอบ' });
    await postWebhook([{
      type: 'message', replyToken: `RT${i}`, message: { type: 'image', mockBase64: 'x' },
      source: { type: 'user', userId: 'U_RATE_STAFF' },
    }]);
  }

  lineClient.clearSentLog();
  aiProvider.queueMockResponse({ documentType: 'unrelated', unrelatedNote: 'ทดสอบ' });
  await postWebhook([{
    type: 'message', replyToken: 'RT6', message: { type: 'image', mockBase64: 'x' },
    source: { type: 'user', userId: 'U_RATE_STAFF' },
  }]);

  const replies = lineClient.getSentLog().filter((s) => s.type === 'reply');
  assert.ok(replies[0].messages[0].text.includes('ถี่เกินไป'), 'ครั้งที่เกินโควต้าต้องได้รับข้อความแจ้งให้รอ');

  rateLimiter.reset();
});

test('ข้อ B8: พิมพ์ข้อความที่ดูเหมือนคำสั่งจัดการผู้พัก ต้องไม่มีผลใดๆ ต่อทะเบียนผู้พักเลย', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G_TEXT', requesterLineId: 'U_OWNER' });
  await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });

  const suspiciousCommands = [
    'เพิ่มผู้พัก สมชาย ใจดี ห้อง 105',
    'ลบผู้พัก สมศรี ใจดี',
    'แก้ไขชื่อ สมศรี เป็น สมหญิง',
    'จำหน่ายผู้พัก R-1',
    '/add resident สมปอง',
  ];

  for (const text of suspiciousCommands) {
    const res = await postWebhook([{
      type: 'message', replyToken: 'RT-TXT', message: { type: 'text', text },
      source: { type: 'group', groupId: 'G_TEXT' },
    }]);
    assert.strictEqual(res.status, 200, `Server ต้องไม่ error แม้ได้รับข้อความ: "${text}"`);
  }

  const residents = await centerService.listResidents(center.center_id);
  assert.strictEqual(residents.length, 1, 'ทะเบียนผู้พักต้องมีแค่คนเดียวเท่าเดิม ไม่มีใครถูกเพิ่ม/ลบ/แก้ผ่านข้อความพิมพ์เลย');
  assert.strictEqual(residents[0].full_name, 'สมศรี ใจดี', 'ชื่อต้องไม่ถูกแก้ไขผ่านข้อความพิมพ์');
});
