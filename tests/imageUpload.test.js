const { test } = require('node:test');
const assert = require('node:assert');
const { decodeMedicalImage, detectImageMimeType, MAX_IMAGE_BYTES } = require('../backend/utils/imageUpload');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = Buffer.from('RIFF0000WEBP', 'ascii');

test('รับรูป JPEG ที่เป็น base64 ถูกต้อง', () => {
  const result = decodeMedicalImage(JPEG.toString('base64'), 'image/jpeg');
  assert.equal(result.ok, true);
  assert.deepEqual(result.buffer, JPEG);
});

test('ตรวจ signature ของ JPEG PNG และ WebP โดยไม่เชื่อ MIME จาก client เพียงอย่างเดียว', () => {
  assert.equal(detectImageMimeType(JPEG), 'image/jpeg');
  assert.equal(detectImageMimeType(PNG), 'image/png');
  assert.equal(detectImageMimeType(WEBP), 'image/webp');
  assert.equal(decodeMedicalImage(PNG.toString('base64'), 'image/png').ok, true);
  assert.equal(decodeMedicalImage(WEBP.toString('base64'), 'image/webp').ok, true);
});

test('ปฏิเสธข้อความที่อ้างเป็น JPEG และ MIME ที่ไม่ตรงกับ signature', () => {
  assert.equal(decodeMedicalImage(Buffer.from('plain text').toString('base64'), 'image/jpeg').error, 'invalid_image');
  assert.equal(decodeMedicalImage(PNG.toString('base64'), 'image/jpeg').error, 'invalid_image');
});

test('ปฏิเสธ signature ที่ขาดและ RIFF ที่ไม่ใช่ WEBP', () => {
  assert.equal(decodeMedicalImage(Buffer.from([0xff, 0xd8]).toString('base64'), 'image/jpeg').error, 'invalid_image');
  assert.equal(decodeMedicalImage(Buffer.from('RIFF0000WAVE', 'ascii').toString('base64'), 'image/webp').error, 'invalid_image');
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
