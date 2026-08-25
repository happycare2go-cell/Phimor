const { deterministicClassification } = require('./plusIntentService');

const EMERGENCY_PATTERNS = Object.freeze([
  /(?:เจ็บ|แน่น|ปวด)\s*หน้าอก.*(?:รุนแรง|หายใจ|เหงื่อแตก|จะเป็นลม)/i,
  /หายใจ(?:ไม่ออก|ลำบากมาก|ติดขัดรุนแรง)/i,
  /หมดสติ|ไม่รู้สึกตัว|ปลุกไม่ตื่น/i,
  /หน้าเบี้ยว.*แขนขา.*อ่อนแรง|พูดไม่ชัด.*อ่อนแรง/i,
  /ชัก(?:ต่อเนื่อง|ไม่หยุด)|เลือดออก(?:มาก|ไม่หยุด)/i,
  /(?:ฆ่าตัวตาย|ทำร้ายตัวเอง|ไม่อยากมีชีวิตอยู่)/i,
  /(?:severe|crushing)\s+chest\s+pain/i,
  /(?:can(?:not|'t)|unable to)\s+breathe/i,
  /unconscious|unresponsive|severe bleeding/i,
  /suicid(?:e|al)|self[- ]harm/i,
]);

const ENGLISH_MEDICATION_PATTERNS = Object.freeze([
  /can i take (?:these|two).*(?:medicine|medication|drug).*(?:together|at the same time)/i,
  /(?:medicine|medication|drug).*(?:interaction|safe together)/i,
  /should i (?:stop|start|increase|decrease|change).*(?:medicine|medication|dose)/i,
]);

function classifyConsultationSafety(text) {
  const normalized = typeof text === 'string' ? text.normalize('NFC').trim() : '';
  if (!normalized) {
    return { action:'medical_escalation', category:'invalid_input', reasonCode:'QUESTION_REQUIRED' };
  }
  if (EMERGENCY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      action:'emergency_block', category:'possible_emergency',
      reasonCode:'POSSIBLE_EMERGENCY',
      message:'อาการที่แจ้งอาจต้องได้รับความช่วยเหลือเร่งด่วน กรุณาติดต่อบริการฉุกเฉินหรือสถานพยาบาลใกล้ที่สุดทันที',
    };
  }
  if (ENGLISH_MEDICATION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { action:'pharmacist_consultation_eligible', category:'medication_advice', reasonCode:null };
  }
  const existing = deterministicClassification(normalized);
  if (!existing) {
    return { action:'medical_escalation', category:'unsupported_or_ambiguous', reasonCode:'SCOPE_REVIEW_REQUIRED' };
  }
  if (['medication_advice', 'dose_change', 'stop_start_medication'].includes(existing.intent)) {
    return { action:'pharmacist_consultation_eligible', category:existing.intent, reasonCode:null };
  }
  if (['diagnosis', 'treatment'].includes(existing.intent)) {
    return { action:'medical_escalation', category:existing.intent, reasonCode:existing.reasonCode };
  }
  return { action:'pharmacist_consultation_eligible', category:existing.intent, reasonCode:null };
}

module.exports = { EMERGENCY_PATTERNS, classifyConsultationSafety };
