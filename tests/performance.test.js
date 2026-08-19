// tests/performance.test.js — วัด Overhead ของโค้ดเราเอง (ไม่รวม Latency จริงของ AI/LINE ที่ยังเป็น Mock)
//
// ⚠️ ข้อจำกัดสำคัญที่ต้องเข้าใจก่อนอ่านผล: เกณฑ์ในหมวด 7 ของ Technical Design ระบุว่า
// "ตั้งแต่ส่งรูปจนการ์ดยืนยันปรากฏ ต้องไม่เกิน 30 วินาที" — เวลาส่วนใหญ่ในโลกจริงมาจาก
// การเรียก AI Vision API (มักใช้เวลา 2-8 วินาที) ซึ่งตอนนี้ยังเป็น Mock ที่ตอบเกือบทันที
// ดังนั้น Test ชุดนี้วัดได้แค่ "โค้ดของเราเองไม่ใช่ตัวถ่วงเวลา" เท่านั้น
// เมื่อเชื่อม AI จริงแล้ว ต้องวัดซ้ำอีกครั้งกับ Service จริงก่อนสรุปว่าเข้าเกณฑ์

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const cardService = require('../backend/services/cardService');
const aiProvider = require('../backend/providers/aiProvider');
const lineClient = require('../backend/providers/lineClient');
const { matchResident } = require('../backend/utils/nameMatch');

beforeEach(() => {
  db.resetAll();
  aiProvider.clearMockQueue();
  lineClient.clearSentLog();
});

test('Overhead ของโค้ดเรา (ไม่รวม AI จริง) ต้องเร็วกว่า 1 วินาทีมาก — เผื่อพื้นที่ให้ AI จริงใช้เวลาได้เต็มที่', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G1', requesterLineId: 'U_OWNER' });
  await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });

  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00' }, medications: [], doctorNote: null,
  });

  const start = Date.now();
  await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });
  const elapsed = Date.now() - start;

  console.log(`    Overhead จริงที่วัดได้: ${elapsed}ms (เกณฑ์รวมทั้งหมดคือ 30,000ms)`);
  assert.ok(elapsed < 1000, `โค้ดของเราเองใช้เวลา ${elapsed}ms ควรเร็วกว่า 1 วินาทีมาก เพื่อเผื่อเวลาให้ AI จริง`);
});

test('การจับคู่ชื่อยังเร็วพอ แม้ศูนย์มีผู้พักเต็มความจุ (50 คน — เกินกลุ่มเป้าหมาย <15 เตียงมาก)', () => {
  const residents = Array.from({ length: 50 }, (_, i) => ({
    resident_id: `R-${i}`, full_name: `ผู้พักทดสอบหมายเลข ${i} นามสกุลยาวๆ`, aliases: [`ชื่อเล่น${i}`],
  }));

  const start = Date.now();
  for (let i = 0; i < 100; i++) {
    matchResident('ผู้พักทดสอบหมายเลข 25 นามสกุลยาวๆ', residents);
  }
  const elapsed = Date.now() - start;

  console.log(`    จับคู่ชื่อ 100 ครั้ง กับผู้พัก 50 คน ใช้เวลารวม: ${elapsed}ms (เฉลี่ย ${(elapsed/100).toFixed(2)}ms/ครั้ง)`);
  assert.ok(elapsed < 500, `การจับคู่ชื่อ 100 ครั้งควรเร็วกว่า 500ms รวม แต่ใช้ไป ${elapsed}ms`);
});

test('ดึงตารางนัดของศูนย์ที่มีผู้พักและนัดหมายจำนวนมาก ยังทำงานเร็ว', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ใหญ่ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G1', requesterLineId: 'U_OWNER' });

  // จำลองศูนย์ขนาด 15 เตียง (กลุ่มเป้าหมายสูงสุดตามกลยุทธ์) แต่ละคนมีนัด 5 รายการ
  for (let i = 0; i < 15; i++) {
    const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: `ผู้พัก ${i}` });
    const profile = await db.CareProfiles.insert({
      care_profile_id: `CP-${i}`, owner_line_id: `U_FAMILY_${i}`, patient_name: `ผู้พัก ${i}`, center_id: center.center_id, status: 'linked',
    });
    await db.Residents.update((r) => r.resident_id === resident.resident_id, { care_profile_id: profile.care_profile_id });
    for (let j = 0; j < 5; j++) {
      await db.Appointments.insert({
        appointment_id: `A-${i}-${j}`, care_profile_id: profile.care_profile_id,
        hospital: `รพ.ทดสอบ ${j}`, datetime: new Date(Date.now() + (j + 1) * 86400000).toISOString(),
      });
    }
  }

  const start = Date.now();
  const residents = await centerService.listResidents(center.center_id);
  const elapsed = Date.now() - start;

  console.log(`    ดึงรายชื่อผู้พัก 15 คน (75 นัดรวม) ใช้เวลา: ${elapsed}ms`);
  assert.strictEqual(residents.length, 15);
  assert.ok(elapsed < 200, `ควรเร็วกว่า 200ms แต่ใช้ไป ${elapsed}ms`);
});

test('ยืนยันการ์ดพร้อมกันหลายใบไม่ทำให้ระบบช้าผิดปกติ (จำลองช่วงเร่งด่วนตอนเช้า)', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G1', requesterLineId: 'U_OWNER' });

  const cardIds = [];
  for (let i = 0; i < 10; i++) {
    await centerService.addResident({ centerId: center.center_id, fullName: `ผู้พัก ${i}` });
    aiProvider.queueMockResponse({
      documentType: 'medical', nameGuess: `ผู้พัก ${i}`, nameConfidence: 0.95,
      appointment: { hospital: 'รพ.ทดสอบ', datetime: '2099-01-01T09:00:00' }, medications: [], doctorNote: null,
    });
    const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('x') });
    cardIds.push(card.card_id);
  }

  const start = Date.now();
  await Promise.all(cardIds.map((id) => cardService.confirmCard(id, 'U_STAFF', 'พนักงาน')));
  const elapsed = Date.now() - start;

  console.log(`    ยืนยัน 10 การ์ดพร้อมกัน ใช้เวลารวม: ${elapsed}ms`);
  assert.ok(elapsed < 1000, `ยืนยัน 10 การ์ดพร้อมกันควรเร็วกว่า 1 วินาที แต่ใช้ไป ${elapsed}ms`);
});
