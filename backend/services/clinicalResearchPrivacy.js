const SAFE_IDENTIFIER_PATTERNS = Object.freeze([
  /\b[UCR][0-9a-f]{16,}\b/i,
  /\b(?:CP|CAREPROFILE|RES|RESIDENT|CASE|CONSULTATION|CENTER|CTR)[-_][A-Za-z0-9_-]{2,}\b/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:\+?66|0)[\s-]?[1-9](?:[\s-]?\d){7,8}\b/,
  /(?:ชื่อผู้ป่วย|ชื่อผู้รับบริการ|ชื่อญาติ|ชื่อผู้ติดต่อ|patient\s*name|relative\s*name|full\s*name)\s*[:=]?/i,
  /(?:ที่อยู่|address)\s*[:=]?/i,
  /(?:วันเดือนปีเกิด|วันเกิด|เกิดวันที่|date\s*of\s*birth|\bdob\b)\s*[:=]?/i,
]);

const DEIDENTIFIED_SUMMARY_PATTERNS = Object.freeze([
  ...SAFE_IDENTIFIER_PATTERNS,
  /\b\d(?:[\s-]?\d){12}\b/,
  /(?:ชื่อ(?:ผู้ป่วย|ผู้รับบริการ|นามสกุล)?|patient\s*name|full\s*name)\s*[:=]/i,
  /(?:เลขบัตร(?:ประชาชน)?|national\s*id|passport)\s*[:=]?/i,
  /(?:line\s*(?:user\s*)?id|ไลน์ไอดี)\s*[:=]?/i,
  /(?:วันเดือนปีเกิด|วันเกิด|เกิดวันที่|date\s*of\s*birth|\bdob\b)\s*[:=]?/i,
  /(?:ที่อยู่|address)\s*[:=]/i,
]);

const MAX_DEIDENTIFIED_SUMMARY_CHARS = 6000;
const MIN_RESEARCH_FOCUS_CHARS = 5;
const MAX_RESEARCH_FOCUS_CHARS = 2000;

function normalized(value) {
  return String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function privacyViolation(value, { blockedTerms = [], conversationTexts = [] } = {}) {
  const query = normalized(value);
  if (!query || query.length > 500) return 'INVALID_RESEARCH_QUERY';
  if (SAFE_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(query))) return 'IDENTIFIER_IN_RESEARCH_QUERY';
  if (blockedTerms.some((term) => {
    const blocked = normalized(term);
    return blocked.length >= 3 && query.includes(blocked);
  })) return 'PRIVATE_TERM_IN_RESEARCH_QUERY';
  if (conversationTexts.some((text) => {
    const source = normalized(text);
    return (source.length >= 20 && query.includes(source))
      || (query.length >= 20 && source.includes(query));
  })) return 'COPIED_CONVERSATION_IN_RESEARCH_QUERY';
  return null;
}

function sanitizeResearchPlan(plan, privacy = {}) {
  const acceptedTopics = [];
  const rejectedTopics = [];
  for (const topic of (plan?.researchTopics || []).slice(0, 4)) {
    const fields = [topic.question, ...(topic.deidentifiedSearchTerms || [])];
    const reason = fields.map((value) => privacyViolation(value, privacy)).find(Boolean);
    if (reason) {
      rejectedTopics.push(Object.freeze({ type:topic.type, reason:'RESEARCH_QUERY_PRIVACY_REJECTED' }));
      continue;
    }
    acceptedTopics.push(Object.freeze({
      type:topic.type,
      question:normalized(topic.question).slice(0, 500),
      deidentifiedSearchTerms:Object.freeze(topic.deidentifiedSearchTerms.map((term) => normalized(term).slice(0, 240))),
    }));
  }
  return Object.freeze({
    acceptedTopics:Object.freeze(acceptedTopics),
    rejectedTopics:Object.freeze(rejectedTopics),
    errorCode:rejectedTopics.length ? 'RESEARCH_QUERY_PRIVACY_REJECTED' : null,
  });
}

function validateDeidentifiedPilotSummary(value) {
  if (typeof value !== 'string') {
    return Object.freeze({ ok:false, errorCode:'DEIDENTIFIED_SUMMARY_REQUIRED' });
  }
  const summary = value.normalize('NFC').trim();
  if (summary.length < 20 || summary.length > MAX_DEIDENTIFIED_SUMMARY_CHARS) {
    return Object.freeze({ ok:false, errorCode:'DEIDENTIFIED_SUMMARY_REQUIRED' });
  }
  if (DEIDENTIFIED_SUMMARY_PATTERNS.some((pattern) => pattern.test(summary))) {
    return Object.freeze({ ok:false, errorCode:'DEIDENTIFIED_SUMMARY_PRIVACY_REJECTED' });
  }
  return Object.freeze({ ok:true, summary });
}

function validateResearchFocus(value, { enforcePrivacy = true } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    return Object.freeze({ ok:false, errorCode:'CLINICAL_RESEARCH_FOCUS_REQUIRED' });
  }
  const researchFocus = value.normalize('NFC').trim();
  if (researchFocus.length < MIN_RESEARCH_FOCUS_CHARS || researchFocus.length > MAX_RESEARCH_FOCUS_CHARS) {
    return Object.freeze({ ok:false, errorCode:'CLINICAL_RESEARCH_FOCUS_INVALID' });
  }
  if (enforcePrivacy && DEIDENTIFIED_SUMMARY_PATTERNS.some((pattern) => pattern.test(researchFocus))) {
    return Object.freeze({ ok:false, errorCode:'CLINICAL_RESEARCH_FOCUS_PRIVACY_REJECTED' });
  }
  return Object.freeze({ ok:true, researchFocus });
}

module.exports = {
  SAFE_IDENTIFIER_PATTERNS, DEIDENTIFIED_SUMMARY_PATTERNS, MAX_DEIDENTIFIED_SUMMARY_CHARS,
  MIN_RESEARCH_FOCUS_CHARS, MAX_RESEARCH_FOCUS_CHARS,
  normalized, privacyViolation, sanitizeResearchPlan, validateDeidentifiedPilotSummary,
  validateResearchFocus,
};
