// providers/aiProvider.js
// Interface กลางสำหรับเรียก AI อ่านเอกสาร — ของจริงเรียก Anthropic/Gemini
// ตอนนี้เป็น Mock ที่ตั้งค่าคำตอบล่วงหน้าได้ (สำหรับ Dev ต่อยอด และสำหรับ Test)
//
// อ้างอิง: Phimor_Technical_Design.docx หมวด 6 (ข้อกำหนดด้าน AI)
// - ต้องคืนค่าความมั่นใจ (confidence) เพื่อตัดสินว่าจะถามหรือไม่ (ข้อ D2, D3)
// - ต้องปฏิเสธเอกสารที่ไม่เกี่ยวข้อง ไม่เดา
// - ห้ามให้คำแนะนำทางการแพทย์

let mockQueue = [];

/**
 * ตั้งค่าคำตอบที่จะคืนใน interpretDocument ครั้งถัดไป (ใช้ใน Test เท่านั้น)
 * @param {object} response
 */
function queueMockResponse(response) {
  mockQueue.push(response);
}

function clearMockQueue() {
  mockQueue = [];
}

/**
 * อ่านเอกสารทางการแพทย์จากรูปภาพ
 * @param {Buffer} imageBuffer
 * @returns {Promise<{
 *   documentType: 'medical'|'unrelated',
 *   unrelatedNote?: string,
 *   nameGuess: string|null,
 *   nameConfidence: number,        // 0..1
 *   appointment: {hospital, datetime, note}|null,
 *   medications: Array<{name, dose}>,
 *   doctorNote: string|null
 * }>}
 */
async function interpretDocument(imageBuffer) {
  if (mockQueue.length > 0) {
    return mockQueue.shift();
  }
  // ไม่มี Mock ตั้งไว้ — พฤติกรรม Default ปลอดภัยที่สุดคือปฏิเสธ ไม่เดา
  // (Dev แทนที่ฟังก์ชันนี้ทั้งหมดด้วยการเรียก Anthropic/Gemini จริงตอน Deploy)
  return {
    documentType: 'unrelated',
    unrelatedNote: 'ยังไม่ได้เชื่อมต่อ AI Provider จริง (โหมด Mock ไม่มีคำตอบตั้งไว้)',
    nameGuess: null,
    nameConfidence: 0,
    appointment: null,
    medications: [],
    doctorNote: null,
  };
}

/**
 * แปลผลตรวจแล็บเป็นภาษาที่เข้าใจง่าย (ฟีเจอร์ Plus — Care Profile ที่ผูกศูนย์เท่านั้น)
 * ต้องปฏิบัติตามกฎเหล็ก: อธิบายค่า+ช่วงปกติเท่านั้น ห้ามวินิจฉัย ห้ามแนะนำการรักษา
 */
async function interpretLabResult(imageBuffer) {
  if (mockQueue.length > 0) {
    return mockQueue.shift();
  }
  return {
    documentType: 'unrelated',
    extractedValues: [],
    plainExplanation: 'ยังไม่ได้เชื่อมต่อ AI Provider จริง',
    hasDangerousValue: false,
    disclaimer: 'กรุณาปรึกษาแพทย์เพื่อการวินิจฉัยที่ถูกต้อง',
  };
}

module.exports = { interpretDocument, interpretLabResult, queueMockResponse, clearMockQueue };
