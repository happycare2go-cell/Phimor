const crypto = require('node:crypto');

const PUBLIC_ERROR_DEFINITIONS = Object.freeze({
  CENTER_MAPPING_NOT_FOUND: Object.freeze({ message:'ไม่พบการเชื่อมสาขาสำหรับระบบภายนอกนี้', retryable:false }),
  RESIDENT_MAPPING_INVALID: Object.freeze({ message:'การเชื่อมผู้พักไม่ถูกต้องหรือไม่พร้อมใช้งาน', retryable:false }),
  CARE_PROFILE_RELATIONSHIP_INVALID: Object.freeze({ message:'ความสัมพันธ์ของผู้พักและ Care Profile ไม่ถูกต้อง', retryable:false }),
  INVALID_FINALIZED_RECORD: Object.freeze({ message:'ข้อมูล finalized record ไม่ถูกต้องตามสัญญา', retryable:false }),
  INVALID_EXTERNAL_RECORD_ID: Object.freeze({ message:'รหัสรายการต้นทางไม่ถูกต้อง', retryable:false }),
  SUBJECT_MAPPING_NOT_FOUND: Object.freeze({ message:'ยังไม่พบการเชื่อมผู้พักสำหรับระบบภายนอกนี้', retryable:false }),
  GROUP_RECONCILIATION_BLOCKED: Object.freeze({ message:'การตรวจสอบกลุ่ม LINE ยังไม่ผ่าน จึงยังไม่ส่งการแจ้งเตือน', retryable:false }),
  CAPABILITY_NOT_ENABLED: Object.freeze({ message:'ศูนย์ยังไม่ได้เปิดใช้ความสามารถที่ event นี้ต้องการ', retryable:false }),
  EVENT_ID_REUSED: Object.freeze({ message:'event_id นี้เคยใช้กับข้อมูลที่ต่างกัน', retryable:false }),
  INTEGRATION_SCOPE_FORBIDDEN: Object.freeze({ message:'Integration Client ไม่มีสิทธิ์ส่งข้อมูลนี้', retryable:false }),
  INVALID_CREDENTIAL: Object.freeze({ message:'Integration credential ไม่ถูกต้องหรือถูกเพิกถอนแล้ว', retryable:false }),
  RATE_LIMITED: Object.freeze({ message:'เรียกใช้งานถี่เกินไป กรุณารอตาม Retry-After', retryable:true }),
  TEMPORARY_PROCESSING_UNAVAILABLE: Object.freeze({ message:'ระบบยังประมวลผล event ไม่สำเร็จและจะลองใหม่ตามนโยบาย', retryable:true }),
  PROCESSING_RETRY_EXHAUSTED: Object.freeze({ message:'ระบบประมวลผล event ไม่สำเร็จภายในจำนวนครั้งที่กำหนด', retryable:false }),
  ADAPTER_SOURCE_CHANGED: Object.freeze({ message:'รูปแบบข้อมูลต้นทางเปลี่ยน กรุณาให้ผู้ดูแลรับข้อมูลตัวอย่างใหม่', retryable:false }),
});

const INTERNAL_CODE_MAP = Object.freeze({
  EXTERNAL_CENTER_MAPPING_NOT_FOUND:'CENTER_MAPPING_NOT_FOUND',
  EXTERNAL_CENTER_REQUIRED:'CENTER_MAPPING_NOT_FOUND',
  CENTER_INACTIVE:'CENTER_MAPPING_NOT_FOUND',
  CROSS_TENANT_SUBJECT_MAPPING:'RESIDENT_MAPPING_INVALID',
  SUBJECT_MAPPING_NOT_CONFIRMED:'RESIDENT_MAPPING_INVALID',
  RESIDENT_NOT_FOUND:'RESIDENT_MAPPING_INVALID',
  RESIDENT_NOT_READY:'CARE_PROFILE_RELATIONSHIP_INVALID',
  CARE_PROFILE_RELATIONSHIP_MISMATCH:'CARE_PROFILE_RELATIONSHIP_INVALID',
  INVALID_EXTERNAL_RECORD_ID:'INVALID_EXTERNAL_RECORD_ID',
  CAPABILITY_DISABLED:'CAPABILITY_NOT_ENABLED',
  EVENT_ID_PAYLOAD_CONFLICT:'EVENT_ID_REUSED',
  EVENT_SCOPE_DENIED:'INTEGRATION_SCOPE_FORBIDDEN',
  CENTER_SCOPE_DENIED:'INTEGRATION_SCOPE_FORBIDDEN',
  CROSS_TENANT_CENTER_MAPPING:'INTEGRATION_SCOPE_FORBIDDEN',
  INVALID_INTEGRATION_IDENTITY:'INVALID_CREDENTIAL',
  INVALID_INTEGRATION_TOKEN:'INVALID_CREDENTIAL',
  INTEGRATION_CREDENTIAL_INVALID:'INVALID_CREDENTIAL',
  INTEGRATION_CREDENTIAL_REVOKED:'INVALID_CREDENTIAL',
  INTEGRATION_CREDENTIAL_EXPIRED:'INVALID_CREDENTIAL',
  RATE_LIMITED:'RATE_LIMITED',
  ADAPTER_SOURCE_CHANGED:'ADAPTER_SOURCE_CHANGED',
  ADAPTER_UNIT_UNSUPPORTED:'ADAPTER_SOURCE_CHANGED',
  ADAPTER_VALUE_INVALID:'ADAPTER_SOURCE_CHANGED',
  ADAPTER_DATE_INVALID:'ADAPTER_SOURCE_CHANGED',
  ADAPTER_DATETIME_INVALID:'ADAPTER_SOURCE_CHANGED',
});

function cleanCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 100);
}

function safeRequestReference(seed = null) {
  const value = seed === null || seed === undefined || seed === '' ? crypto.randomUUID() : String(seed);
  return `iref_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function publicCodeFor(input, { status = null, state = null } = {}) {
  const internal = cleanCode(typeof input === 'string' ? input : input?.code);
  if (state === 'dead') return 'PROCESSING_RETRY_EXHAUSTED';
  if (Number(status) === 429) return 'RATE_LIMITED';
  if (Number(status) >= 500) return 'TEMPORARY_PROCESSING_UNAVAILABLE';
  if (PUBLIC_ERROR_DEFINITIONS[internal]) return internal;
  if (INTERNAL_CODE_MAP[internal]) return INTERNAL_CODE_MAP[internal];
  if (Number(status) === 401) return 'INVALID_CREDENTIAL';
  if (Number(status) === 403) return 'INTEGRATION_SCOPE_FORBIDDEN';
  if (Number(status) === 409 && internal === 'EVENT_ID_PAYLOAD_CONFLICT') return 'EVENT_ID_REUSED';
  return 'INVALID_FINALIZED_RECORD';
}

function publicIntegrationError(input, { status = null, state = null, requestId = null } = {}) {
  const code = publicCodeFor(input, { status, state });
  const definition = PUBLIC_ERROR_DEFINITIONS[code] || PUBLIC_ERROR_DEFINITIONS.INVALID_FINALIZED_RECORD;
  return {
    code,
    message:definition.message,
    retryable:state === 'dead' ? false : definition.retryable,
    request_id:safeRequestReference(requestId),
  };
}

module.exports = {
  PUBLIC_ERROR_DEFINITIONS,
  INTERNAL_CODE_MAP,
  publicCodeFor,
  publicIntegrationError,
  safeRequestReference,
};
