const OMITTED_CONTEXT_KEYS = new Set([
  'caseid', 'careprofileid', 'residentid', 'centerid', 'appointmentid',
  'snapshotid', 'messageid', 'reportid', 'groupid', 'lineuserid',
  'linegroupid', 'ownerlineid', 'customerlineuserid', 'pharmacistid',
  'referenceid', 'requesterlineid', 'authorization', 'authorizationmetadata',
  'phone', 'phonenumber', 'email', 'address', 'patientname', 'relativename',
  'fullname',
]);

const DIRECT_IDENTIFIER_PATTERNS = Object.freeze([
  /\b[UCR][0-9a-f]{16,}\b/gi,
  /\b(?:CP|CAREPROFILE|RES|RESIDENT|CASE|CONSULTATION|CENTER|CTR)[-_][A-Za-z0-9_-]{2,}\b/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /(?:\+?66|0)[\s-]?[1-9](?:[\s-]?\d){7,8}\b/g,
  /(?:ชื่อผู้ป่วย|ชื่อผู้รับบริการ|ชื่อญาติ|ชื่อผู้ติดต่อ|patient\s*name|relative\s*name|full\s*name)\s*[:=]?\s*[^,;\n]{1,120}/gi,
  /(?:ที่อยู่|address)\s*[:=]?\s*[^,;\n]{1,200}/gi,
  /(?:วันเดือนปีเกิด|วันเกิด|เกิดวันที่|date\s*of\s*birth|\bdob\b)\s*[:=]?\s*[^,;\n]{1,100}/gi,
]);

function normalizedKey(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function omittedContextKey(value) {
  const key = String(value || '');
  return OMITTED_CONTEXT_KEYS.has(normalizedKey(key)) || /(?:_id|Id|ID)$/.test(key);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactClinicalText(value, blockedTerms = []) {
  let result = String(value || '');
  for (const pattern of DIRECT_IDENTIFIER_PATTERNS) result = result.replace(pattern, '[ข้อมูลระบุตัวตนถูกตัดออก]');
  for (const term of blockedTerms) {
    const candidate = String(term || '').normalize('NFC').trim();
    if (candidate.length < 3) continue;
    result = result.replace(new RegExp(escapeRegExp(candidate), 'giu'), '[ข้อมูลระบุตัวตนถูกตัดออก]');
  }
  return result;
}

function minimizeAIClinicalContext(value, { blockedTerms = [] } = {}) {
  if (typeof value === 'string') return redactClinicalText(value, blockedTerms);
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => minimizeAIClinicalContext(item, { blockedTerms })));
  }
  if (!value || typeof value !== 'object') return value;
  const projected = {};
  for (const [key, item] of Object.entries(value)) {
    if (omittedContextKey(key)) continue;
    projected[key] = minimizeAIClinicalContext(item, { blockedTerms });
  }
  return Object.freeze(projected);
}

module.exports = {
  OMITTED_CONTEXT_KEYS, DIRECT_IDENTIFIER_PATTERNS,
  normalizedKey, omittedContextKey, redactClinicalText, minimizeAIClinicalContext,
};
