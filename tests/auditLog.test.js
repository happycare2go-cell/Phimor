// tests/auditLog.test.js — เกณฑ์ยอมรับข้อ 12: Audit Log บันทึกครบทุกการส่งข้อมูล ตรวจสอบย้อนหลังได้

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const cardService = require('../backend/services/cardService');
const transportService = require('../backend/services/transportService');
const accessService = require('../backend/services/accessService');
const aiProvider = require('../backend/providers/aiProvider');

beforeEach(() => {
  db.resetAll();
  aiProvider.clearMockQueue();
});

test('การยืนยันการ์ดต้องมี Audit Log ระบุผู้ยืนยันและเวลา', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G1', requesterLineId: 'U_OWNER' });
  await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });

  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00' }, medications: [], doctorNote: null,
  });
  const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });
  await cardService.confirmCard(card.card_id, 'U_OWNER', 'พี่นวล');

  const logs = await db.AuditLog.findWhere((l) => l.action === 'card.confirmed');
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].actor_line_id, 'U_OWNER');
  assert.strictEqual(logs[0].meta.cardId, card.card_id);
  assert.ok(logs[0].at, 'ต้องมีเวลาที่บันทึก');
});

test('การตัดสินใจของศูนย์เรื่องเดินทางต้องมี Audit Log', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const profile = await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี', center_id: center.center_id, status: 'linked' });
  const plan = await transportService.createTransportPlan({ appointmentId: 'A1', careProfileId: profile.care_profile_id, centerId: center.center_id });

  await transportService.familyRequestCenter(plan.plan_id, 'U_FAMILY');
  await transportService.centerChoose(plan.plan_id, 'care2go', 'U_OWNER', { needs: ['vehicle'] });

  const familyLog = await db.AuditLog.findWhere((l) => l.action === 'transport.family_request_center');
  const centerLog = await db.AuditLog.findWhere((l) => l.action === 'transport.center_choice');
  assert.strictEqual(familyLog.length, 1);
  assert.strictEqual(familyLog[0].actor_line_id, 'U_FAMILY');
  assert.strictEqual(centerLog.length, 1);
  assert.strictEqual(centerLog[0].actor_line_id, 'U_OWNER');
  assert.strictEqual(centerLog[0].meta.choice, 'care2go');
});

test('การจำหน่ายผู้พักออกต้องมี Audit Log', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  await centerService.dischargeResident(resident.resident_id, 'U_OWNER');

  const logs = await db.AuditLog.findWhere((l) => l.action === 'resident.discharged');
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].meta.residentId, resident.resident_id);
});

test('การตอบคำขอเชื่อมต่อต้องมี Audit Log', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  const profile = await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี', center_id: null, status: 'independent' });
  const { request } = await accessService.createAccessRequest({ centerId: center.center_id, careProfileId: profile.care_profile_id, requestedBy: 'U_OWNER' });
  await accessService.respondAccessRequest(request.request_id, true, 'U_FAMILY');

  const logs = await db.AuditLog.findWhere((l) => l.action === 'access_request.responded');
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].meta.approved, true);
});

test('Audit Log ต้องเรียงลำดับเหตุการณ์ตรวจสอบย้อนหลังได้ (เก่าไปใหม่)', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.appointManager({ centerId: center.center_id, targetLineId: 'U_MGR', requesterLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  await centerService.dischargeResident(resident.resident_id, 'U_MGR');

  const allLogs = await db.AuditLog.findAll();
  assert.ok(allLogs.length >= 2);
  const times = allLogs.map((l) => new Date(l.at).getTime());
  const sorted = [...times].sort((a, b) => a - b);
  assert.deepStrictEqual(times, sorted, 'ลำดับเวลาต้องเรียงถูกต้องตามที่เกิดขึ้นจริง');
});
