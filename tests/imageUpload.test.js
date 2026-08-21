const { test } = require('node:test');
const assert = require('node:assert');
const { decodeMedicalImage, MAX_IMAGE_BYTES } = require('../backend/utils/imageUpload');

test('รับรูป JPEG ที่เป็น base64 ถูกต้อง', () => {
  const result = decodeMedicalImage(Buffer.from('image').toString('base64'), 'image/jpeg');
  assert.equal(result.ok, true);
  assert.equal(result.buffer.toString(), 'image');
});

test('ปฏิเสธ HEIC ดิบเพื่อไม่ส่ง MIME ผิดให้ AI', () => {
  const result = decodeMedicalImage(Buffer.from('heic').toString('base64'), 'image/heic');
  assert.equal(result.ok, false);
  assert.equal(result.status, 415);
});

test('ปฏิเสธรูปที่เกินขนาดหลังแปลง', () => {
  const result = decodeMedicalImage(Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64'), 'image/jpeg');
  assert.equal(result.ok, false);
  assert.equal(result.status, 413);
});

test('ปฏิเสธ base64 ที่เสียหาย', () => {
  const result = decodeMedicalImage('%%%not-base64%%%', 'image/jpeg');
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});
