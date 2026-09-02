const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function detectImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function decodeMedicalImage(imageBase64, imageMimeType = 'image/jpeg') {
  if (!ALLOWED_IMAGE_TYPES.has(imageMimeType)) {
    return { ok: false, status: 415, error: 'unsupported_image', message: 'รองรับรูป JPEG, PNG หรือ WebP เท่านั้น กรุณาเลือกรูปใหม่หรือถ่ายภาพหน้าจอก่อนอัปโหลด' };
  }
  if (typeof imageBase64 !== 'string' || !imageBase64.trim()) {
    return { ok: false, status: 400, error: 'invalid_image', message: 'ไม่พบข้อมูลรูปภาพ' };
  }
  const clean = imageBase64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    return { ok: false, status: 400, error: 'invalid_image', message: 'ข้อมูลรูปภาพไม่ถูกต้อง' };
  }
  const buffer = Buffer.from(clean, 'base64');
  if (!buffer.length) return { ok: false, status: 400, error: 'invalid_image', message: 'รูปภาพว่างเปล่า' };
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, error: 'image_too_large', message: 'รูปภาพมีขนาดใหญ่เกิน 6 MB กรุณาลดขนาดแล้วลองใหม่' };
  }
  const detectedMimeType = detectImageMimeType(buffer);
  if (!detectedMimeType || detectedMimeType !== imageMimeType) {
    return { ok: false, status: 400, error: 'invalid_image', message: 'ชนิดไฟล์รูปภาพไม่ตรงกับข้อมูลรูป กรุณาเลือกรูปใหม่' };
  }
  return { ok: true, buffer, mimeType: imageMimeType };
}

module.exports = { decodeMedicalImage, detectImageMimeType, MAX_IMAGE_BYTES, ALLOWED_IMAGE_TYPES };
