const { AI_ERROR_CODES, AIProviderError } = require('./aiErrors');

const DOCUMENT_PROMPT = `คุณคือผู้เชี่ยวชาญด้านการอ่านเอกสารทางการแพทย์ภาษาไทย
    จัดประเภท subtype ตามเนื้อหา: ตารางผลตรวจเลือด/ปัสสาวะ/สิ่งส่งตรวจเป็น lab_report,
    รายการยาหรือซองยาเป็น medication, ใบนัดเป็น appointment, บันทึก/คำสั่งแพทย์เป็น doctor_note,
    เอกสารที่มีหลายประเภทเป็น mixed และเอกสารแพทย์อื่นเป็น other_medical
    โปรดอ่านภาพเอกสารนี้และสกัดข้อมูลออกมาเป็น JSON เท่านั้น โดยมีโครงสร้างดังนี้เป๊ะๆ (ห้ามมีข้อความอื่นนอกจาก JSON):
    {
      "documentType": "medical" หรือ "unrelated" (ถ้าไม่ใช่เอกสารทางการแพทย์ ให้ตอบ unrelated),
      "documentSubtype": "lab_report" | "medication" | "appointment" | "doctor_note" | "mixed" | "other_medical",
      "unrelatedNote": "เหตุผลสั้นๆ ที่ปฏิเสธ (ถ้าเป็น unrelated)",
      "nameGuess": "ชื่อ-นามสกุลของผู้ป่วย (ถ้าไม่มีให้ตอบ null)",
      "nameConfidence": 0.0 ถึง 1.0 (ความมั่นใจ),
      "appointment": {
        "hospital": "ชื่อโรงพยาบาล",
        "datetime": "วันเวลานัดหมายในรูปแบบ ISO 8601 เช่น 2026-08-25T09:00:00 (ถ้าไม่มีเวลาให้สมมติเป็น 09:00:00, ถ้าไม่มีนัดเลยให้เป็น null)",
        "clinicOrDepartment": "ชื่อคลินิกหรือแผนก ถ้าไม่มีให้เป็น null",
        "reasonForVisit": "เหตุผลที่นัดหรือหัตถการ ถ้าไม่มีให้เป็น null",
        "relatedCondition": "โรคหรือภาวะที่ระบุชัดในเอกสารเท่านั้น ห้ามเดาจากแผนก ถ้าไม่มีให้เป็น null",
        "doctorName": "ชื่อแพทย์ ถ้าไม่มีให้เป็น null",
        "note": "หมายเหตุการนัด เช่น งดน้ำงดอาหาร"
      },
      "medications": [
        { "name": "ชื่อยา", "dose": "วิธีใช้ยา", "condition": "โรคที่ยานี้ใช้รักษาเมื่อเอกสารระบุชัด ถ้าไม่ระบุให้เป็นข้อความว่าง" }
      ],
      "doctorNote": "คำสั่งแพทย์อื่นๆ (ถ้าไม่มีให้ตอบ null)"
    }`;

function invalid(message) { throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, message); }
function nullableString(value, field) {
  if (value !== null && typeof value !== 'string') invalid(`${field} must be a string or null`);
}

function validateDocumentResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Document result must be an object');
  if (!['medical', 'unrelated'].includes(value.documentType)) invalid('documentType is missing or invalid');
  if (value.documentType === 'unrelated') {
    if (typeof value.unrelatedNote !== 'string' || !value.unrelatedNote.trim()) invalid('unrelatedNote is required');
    return {
      documentType: 'unrelated', unrelatedNote: value.unrelatedNote,
      domainCode: AI_ERROR_CODES.UNRELATED_DOCUMENT,
      nameGuess: value.nameGuess ?? null,
      nameConfidence: Number.isFinite(value.nameConfidence) ? value.nameConfidence : 0,
      appointment: value.appointment ?? null,
      medications: Array.isArray(value.medications) ? value.medications : [],
      doctorNote: value.doctorNote ?? null,
      documentSubtype: null,
    };
  }
  for (const field of ['nameGuess', 'nameConfidence', 'appointment', 'medications', 'doctorNote']) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) invalid(`${field} is required`);
  }
  nullableString(value.nameGuess, 'nameGuess');
  nullableString(value.doctorNote, 'doctorNote');
  if (!Number.isFinite(value.nameConfidence) || value.nameConfidence < 0 || value.nameConfidence > 1) invalid('nameConfidence is invalid');
  if (value.appointment !== null && (typeof value.appointment !== 'object' || Array.isArray(value.appointment))) invalid('appointment is invalid');
  if (!Array.isArray(value.medications)) invalid('medications must be an array');
  for (const medication of value.medications) {
    if (!medication || typeof medication !== 'object' || typeof medication.name !== 'string' || !medication.name.trim()) invalid('Medication name is required');
    if (medication.dose !== undefined && typeof medication.dose !== 'string') invalid('Medication dose is invalid');
    if (medication.condition !== undefined && typeof medication.condition !== 'string') invalid('Medication condition is invalid');
  }
  const allowedSubtypes = new Set(['lab_report', 'medication', 'appointment', 'doctor_note', 'mixed', 'other_medical']);
  let documentSubtype = value.documentSubtype;
  if (documentSubtype !== undefined && documentSubtype !== null && !allowedSubtypes.has(documentSubtype)) {
    invalid('documentSubtype is invalid');
  }
  // Backwards compatibility for existing provider fixtures. Only an explicit
  // lab_report classification can enter the Lab extraction path.
  if (!documentSubtype) {
    const present = [value.appointment ? 'appointment' : null, value.medications.length ? 'medication' : null,
      value.doctorNote ? 'doctor_note' : null].filter(Boolean);
    documentSubtype = present.length > 1 ? 'mixed' : (present[0] || 'other_medical');
  }
  return { ...value, documentSubtype };
}

module.exports = { DOCUMENT_PROMPT, validateDocumentResult };
