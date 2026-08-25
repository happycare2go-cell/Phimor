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

const MEDICATION_SCOPE_RULES = Object.freeze([
  {
    category:'medication_change_review', physicianEscalationMayBeRequired:true,
    patterns:[
      /(?:หมอ|แพทย์).*(?:ปรับ|เพิ่ม|ลด|เปลี่ยน).*(?:ยา|ขนาด|โดส|เม็ด)/i,
      /(?:ปรับ|เพิ่ม|ลด|เปลี่ยน).*(?:ยา|ขนาดยา|โดส|dose|dosage).*(?:ระวัง|เหมาะ|ได้ไหม|อย่างไร|ยังไง)/i,
      /(?:individual|personal).*(?:dose|dosage|medication).*(?:change|adjust)/i,
    ],
  },
  {
    category:'medication_disease_context', physicianEscalationMayBeRequired:true,
    patterns:[
      /(?:โรค|ไต|ตับ|เบาหวาน|ความดัน|หัวใจ|ตั้งครรภ์|ให้นม).*(?:ยา|metformin|ใช้.*ได้ไหม|กิน.*ได้ไหม)/i,
      /(?:ยา|metformin).*(?:ผู้ป่วย|คนเป็น|โรค|ไต|ตับ|เบาหวาน|ความดัน|หัวใจ|ตั้งครรภ์|ให้นม)/i,
      /(?:medicine|medication|drug|metformin).*(?:disease|condition|kidney|renal|liver|hepatic|diabetes|pregnan|breastfeed)/i,
      /(?:disease|condition|kidney|renal|liver|hepatic|diabetes|pregnan|breastfeed).*(?:medicine|medication|drug|metformin)/i,
      /can\s+[A-Za-z][A-Za-z0-9-]{2,}\s+be used.*(?:disease|condition|kidney|renal|liver|hepatic|diabetes|pregnan|breastfeed)/i,
    ],
  },
  {
    category:'drug_interaction', physicianEscalationMayBeRequired:false,
    patterns:[
      /(?:ยา|กิน|ใช้).*(?:สองตัว|หลายตัว|ร่วมกัน|ด้วยกัน|พร้อมกัน).*(?:ได้ไหม|ปลอดภัย|มีปฏิกิริยา)/i,
      /(?:medicine|medication|drug)s?.*(?:together|same time|interact|interaction|compatible)/i,
      /(?:interact|interaction|together|same time).*(?:medicine|medication|drug)s?/i,
    ],
  },
  {
    category:'missed_dose_or_adherence', physicianEscalationMayBeRequired:false,
    patterns:[
      /(?:ลืม|ขาด|ไม่ได้).*(?:กิน|รับประทาน|ใช้).*(?:ยา|มื้อ|dose)/i,
      /(?:กินยา|รับประทานยา|ใช้ยา).*(?:สม่ำเสมอ|ตรงเวลา|ต่อเนื่อง)/i,
      /(?:missed?|forgot|forget|skipped?).*(?:dose|medicine|medication|pill)/i,
      /medication adherence|take.*medication.*regularly/i,
    ],
  },
  {
    category:'adverse_effects', physicianEscalationMayBeRequired:false,
    patterns:[
      /(?:ยา|ยานี้)?.*(?:ผลข้างเคียง|อาการไม่พึงประสงค์|แพ้ยา).*(?:อะไร|อย่างไร|ยังไง|บ้าง)?/i,
      /(?:adverse|side) effects?|drug reaction/i,
    ],
  },
  {
    category:'precautions_contraindications', physicianEscalationMayBeRequired:true,
    patterns:[
      /(?:ยา|ยานี้)?.*(?:ข้อห้ามใช้|ข้อควรระวัง|ห้ามใช้).*(?:อะไร|โรค|กรณี|บ้าง)?/i,
      /contraindications?|precautions?|warnings?.*(?:medicine|medication|drug)?/i,
    ],
  },
  {
    category:'usual_dosing', physicianEscalationMayBeRequired:false,
    patterns:[
      /(?:ยา|metformin|[A-Za-z][A-Za-z0-9-]{2,}).*(?:ปกติ|ทั่วไป)?.*(?:ขนาด|โดส|กี่เม็ด|เท่าไหร่|เท่าไร)/i,
      /(?:ขนาดยา|โดส|ขนาดที่ใช้|กี่เม็ด).*(?:ปกติ|ทั่วไป|เท่าไหร่|เท่าไร|ตามข้อบ่งใช้)/i,
      /(?:usual|standard|typical|normal).*(?:dose|dosage|dosing)|dosing ranges?(?: by indication)?/i,
    ],
  },
  {
    category:'medication_administration', physicianEscalationMayBeRequired:false,
    patterns:[
      /(?:ยา|ยานี้).*(?:กิน|ใช้|รับประทาน).*(?:อย่างไร|ยังไง|ตอนไหน|ก่อนอาหาร|หลังอาหาร)/i,
      /how (?:should|do).*(?:take|use).*(?:medicine|medication|drug)|administration instructions?/i,
    ],
  },
  {
    category:'medication_indication', physicianEscalationMayBeRequired:false,
    patterns:[
      /(?:ยานี้|ยาตัวนี้|ชื่อยา|เรื่องยา|metformin|[A-Za-z][A-Za-z0-9-]{2,}).*(?:ใช้)?\s*(?:รักษาอะไร|ใช้ทำอะไร|มีข้อบ่งใช้อะไร)/i,
      /what (?:is|are).*(?:medicine|medication|drug).*(?:used for|treat)|(?:medicine|medication|drug).*(?:indication|used for)/i,
      /what is [A-Za-z][A-Za-z0-9-]{2,} used for/i,
    ],
  },
  {
    category:'medication_advice', physicianEscalationMayBeRequired:false,
    patterns:[
      /(?:เรื่องยา|เกี่ยวกับยา|ชื่อยา|รายการยา|ยานี้|ยาตัว|ยาสอง|ยาหลาย|ยาที่|ยาของ|ยาอะไร|ยา\s|ยา$|เภสัช|ขนาดยา|โดส|เม็ด|แคปซูล|กินยา|รับประทานยา|ใช้ยา)/i,
      /\b(?:medicine|medication|drug|pharmacist|pharmacy|dose|dosage|dosing|tablet|capsule|pill)\b/i,
    ],
  },
]);

const CLEARLY_OUT_OF_SCOPE_PATTERNS = Object.freeze([
  /(?:พยากรณ์อากาศ|อากาศวันนี้|ผลฟุตบอล|ดูดวง|เลขหวย|ราคาหุ้น|สูตรอาหาร|สถานที่ท่องเที่ยว)/i,
  /\b(?:weather forecast|football score|lottery number|stock price|travel itinerary|cooking recipe)\b/i,
]);

function medicationScopeClassification(text) {
  const rule = MEDICATION_SCOPE_RULES.find((candidate) =>
    candidate.patterns.some((pattern) => pattern.test(text)));
  if (!rule) return null;
  return {
    action:'pharmacist_consultation_eligible', category:rule.category, reasonCode:null,
    physicianEscalationMayBeRequired:rule.physicianEscalationMayBeRequired,
  };
}

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
  const medicationScope = medicationScopeClassification(normalized);
  if (medicationScope) return medicationScope;
  const existing = deterministicClassification(normalized);
  if (!existing) {
    if (CLEARLY_OUT_OF_SCOPE_PATTERNS.some((pattern) => pattern.test(normalized))) {
      return { action:'out_of_scope', category:'non_pharmacy', reasonCode:'NON_PHARMACY_QUESTION' };
    }
    return { action:'needs_review', category:'ambiguous', reasonCode:'SCOPE_REVIEW_REQUIRED' };
  }
  if (['medication_advice', 'dose_change', 'stop_start_medication'].includes(existing.intent)) {
    return { action:'pharmacist_consultation_eligible', category:existing.intent, reasonCode:null };
  }
  if (['diagnosis', 'treatment'].includes(existing.intent)) {
    return { action:'medical_escalation', category:existing.intent, reasonCode:existing.reasonCode };
  }
  return { action:'out_of_scope', category:'non_pharmacy', reasonCode:'NON_PHARMACY_QUESTION' };
}

module.exports = {
  EMERGENCY_PATTERNS, MEDICATION_SCOPE_RULES, CLEARLY_OUT_OF_SCOPE_PATTERNS,
  medicationScopeClassification, classifyConsultationSafety,
};
