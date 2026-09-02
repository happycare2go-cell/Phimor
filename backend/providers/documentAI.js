const { AI_ERROR_CODES, AIProviderError } = require('./aiErrors');
const { trustedTaskInstructions } = require('./promptSafety');

const DOCUMENT_PROMPT = trustedTaskInstructions(`คุณคือผู้เชี่ยวชาญด้านการอ่านเอกสารทางการแพทย์ภาษาไทย
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
        {
          "name": "ชื่อยา",
          "strength": "ความแรงของยาที่เห็นบนฉลาก ถ้าไม่มีให้เป็นข้อความว่าง",
          "dose": "ปริมาณที่ใช้ต่อครั้งตามฉลาก ถ้าไม่มีให้เป็นข้อความว่าง",
          "unit": "หน่วยของปริมาณต่อครั้ง เช่น เม็ด หรือ มล. ถ้าไม่มีให้เป็นข้อความว่าง",
          "frequency": "ความถี่ตามฉลาก ถ้าไม่มีให้เป็นข้อความว่าง",
          "timing": "เวลาใช้ยาหรือความสัมพันธ์กับอาหารตามฉลาก ถ้าไม่มีให้เป็นข้อความว่าง",
          "instruction": "ข้อความคำสั่งใช้ยาตามฉลาก โดยไม่แต่งเติม",
          "route": "ทางใช้ยาที่ระบุบนฉลาก ถ้าไม่มีให้เป็นข้อความว่าง",
          "amount": "จำนวนที่ได้รับทั้งหมดตามฉลากพร้อมหน่วย เช่น 30 เม็ด หรือ 1 ขวด ถ้าไม่มีให้เป็นข้อความว่าง",
          "condition": "หมายเหตุหรือข้อบ่งใช้เฉพาะที่เอกสารระบุชัด ถ้าไม่ระบุให้เป็นข้อความว่าง",
          "uncertainFields": ["ชื่อ field ที่อ่านไม่ชัดจาก name, strength, dose, unit, frequency, timing, instruction, route, amount, condition"]
        }
      ],
      "doctorNote": "คำสั่งแพทย์อื่นๆ (ถ้าไม่มีให้ตอบ null)"
    }`);

function invalid(message) { throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, message); }
function nullableString(value, field) {
  if (value !== null && typeof value !== 'string') invalid(`${field} must be a string or null`);
}

const MEDICATION_FIELDS = Object.freeze([
  'name', 'strength', 'dose', 'unit', 'frequency', 'timing', 'instruction', 'route', 'amount', 'condition',
]);

function validatedMedication(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.name !== 'string' || !value.name.trim()) invalid('Medication name is required');
  const medication = {};
  for (const field of MEDICATION_FIELDS) {
    if (value[field] !== undefined && typeof value[field] !== 'string') invalid(`Medication ${field} is invalid`);
    medication[field] = value[field] === undefined ? '' : value[field];
  }
  if (value.uncertainFields !== undefined && !Array.isArray(value.uncertainFields)) {
    invalid('Medication uncertainFields is invalid');
  }
  medication.uncertainFields = [...new Set((value.uncertainFields || [])
    .filter((field) => MEDICATION_FIELDS.includes(field)))];
  return medication;
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
  const medications = value.medications.map(validatedMedication);
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
  return { ...value, medications, documentSubtype };
}

module.exports = { DOCUMENT_PROMPT, MEDICATION_FIELDS, validateDocumentResult };
