// tests/nameMatch.test.js — ทดสอบ FR-D การจับคู่ชื่อผู้พัก (utils/nameMatch.js)

const { test } = require('node:test');
const assert = require('node:assert');
const { matchResident, similarity } = require('../backend/utils/nameMatch');

const residents = [
  { resident_id: 'R-1', full_name: 'สมศรี ใจดี', aliases: ['คุณแม่สมศรี', 'ป้าศรี'] },
  { resident_id: 'R-2', full_name: 'สมชาย รักดี', aliases: [] },
  { resident_id: 'R-3', full_name: 'บุญมี ทองแท้', aliases: ['ตาบุญมี'] },
];

test('ชื่อตรงเป๊ะ → มั่นใจและจับคู่ได้ทันที ไม่ต้องถาม', () => {
  const r = matchResident('สมศรี ใจดี', residents);
  assert.strictEqual(r.needsSelection, false);
  assert.strictEqual(r.matched.resident_id, 'R-1');
});

test('ใช้ชื่ออื่นที่ใช้ (alias) แทนชื่อเต็ม → ยังจับคู่ได้', () => {
  const r = matchResident('คุณแม่สมศรี', residents);
  assert.strictEqual(r.needsSelection, false);
  assert.strictEqual(r.matched.resident_id, 'R-1');
});

test('ชื่อคลาดเคลื่อนเล็กน้อย (typo หนึ่งตัวอักษร) → ยังมั่นใจพอ', () => {
  const r = matchResident('สมศรี ใจด', residents); // ขาดตัวสุดท้ายไปหนึ่งตัว
  assert.strictEqual(r.needsSelection, false);
  assert.strictEqual(r.matched.resident_id, 'R-1');
});

test('ข้อ D3: ชื่อกำกวมมาก (แค่คำว่า "สม") → ต้องถาม ห้ามเดา', () => {
  const r = matchResident('สม', residents);
  assert.strictEqual(r.needsSelection, true);
  assert.strictEqual(r.matched, null);
});

test('ข้อ D3: ชื่อว่างเปล่าหรือ null → ต้องถามเสมอ', () => {
  assert.strictEqual(matchResident('', residents).needsSelection, true);
  assert.strictEqual(matchResident(null, residents).needsSelection, true);
  assert.strictEqual(matchResident(undefined, residents).needsSelection, true);
});

test('ไม่มีผู้พักในศูนย์เลย → ต้องถาม (ไม่ error)', () => {
  const r = matchResident('สมศรี ใจดี', []);
  assert.strictEqual(r.needsSelection, true);
  assert.deepStrictEqual(r.candidates, []);
});

test('ชื่อไม่ตรงกับใครเลยในศูนย์ → ต้องถาม ไม่ใช่จับคู่ผิดคนไปเลย', () => {
  const r = matchResident('วิชัย แสงทอง', residents); // ไม่มีในรายชื่อเลย
  assert.strictEqual(r.needsSelection, true);
});

test('ผู้พักเกิน 13 คน → candidates ต้องไม่เกิน 13 (ข้อจำกัด Quick Reply ของ LINE)', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ resident_id: `R-${i}`, full_name: `ผู้พักทดสอบ ${i}`, aliases: [] }));
  const r = matchResident('ไม่ทราบชื่อเลย', many);
  assert.ok(r.candidates.length <= 13);
});

test('similarity: ชื่อเหมือนกันเป๊ะ = คะแนนเต็ม 1', () => {
  assert.strictEqual(similarity('สมศรี ใจดี', 'สมศรี ใจดี'), 1);
});

test('similarity: ชื่อว่างเปล่า = คะแนน 0', () => {
  assert.strictEqual(similarity('', 'สมศรี'), 0);
  assert.strictEqual(similarity('สมศรี', ''), 0);
});
