const crypto=require('node:crypto');
const {INTEGRATION_EVENT_TYPES}=require('./platform');
class IntegrationEventError extends Error{constructor(code,message,status=400){super(message);this.name='IntegrationEventError';this.code=code;this.status=status;}}
function exactKeys(object,allowed,code){if(!object||typeof object!=='object'||Array.isArray(object))throw new IntegrationEventError(code,'รูปแบบ event ไม่ถูกต้อง',400);for(const key of Object.keys(object))if(!allowed.includes(key))throw new IntegrationEventError(code,`ไม่รองรับ field ${key}`,400);}
function requiredId(value,label='identifier'){const clean=String(value||'').trim();if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(clean))throw new IntegrationEventError('INVALID_EVENT_IDENTIFIER',`${label} ไม่ถูกต้อง`,400);return clean;}
function timestamp(value){if(typeof value!=='string'||!value.trim())throw new IntegrationEventError('INVALID_EVENT_TIME','วันเวลา event ไม่ถูกต้อง',400);const d=new Date(value);if(!Number.isFinite(d.getTime()))throw new IntegrationEventError('INVALID_EVENT_TIME','วันเวลา event ไม่ถูกต้อง',400);return d.toISOString();}
function text(value,max){if(value===undefined||value===null||value==='')return null;const clean=String(value).trim();if(!clean)return null;if(clean.length>max)throw new IntegrationEventError('EVENT_VALUE_TOO_LONG','ข้อมูล event ยาวเกินกำหนด',400);return clean;}
function stableStringify(value){if(Array.isArray(value))return `[${value.map(stableStringify).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;return JSON.stringify(value);}
function normalizeEnvelope(input){exactKeys(input,['schemaVersion','eventId','eventType','occurredAt','subject','recorder','data'],'INVALID_EVENT_ENVELOPE');
  if(input.schemaVersion!=='1.0')throw new IntegrationEventError('UNSUPPORTED_SCHEMA_VERSION','schemaVersion ไม่รองรับ',400);
  const eventId=requiredId(input.eventId,'Event ID');const eventType=String(input.eventType||'').trim();if(!INTEGRATION_EVENT_TYPES.includes(eventType))throw new IntegrationEventError('UNSUPPORTED_EVENT_TYPE','eventType ไม่รองรับ',400);
  exactKeys(input.subject,['externalCenterId','externalResidentId','firstName','lastName','displayName','room'],'INVALID_EVENT_SUBJECT');
  const subject={externalCenterId:requiredId(input.subject.externalCenterId,'External Center ID'),externalResidentId:requiredId(input.subject.externalResidentId,'External Resident ID'),firstName:text(input.subject.firstName,120),lastName:text(input.subject.lastName,120),displayName:text(input.subject.displayName,240),room:text(input.subject.room,80)};
  let recorder=null;if(input.recorder!==undefined&&input.recorder!==null){exactKeys(input.recorder,['externalStaffId','displayName'],'INVALID_EVENT_RECORDER');recorder={externalStaffId:text(input.recorder.externalStaffId,160),displayName:text(input.recorder.displayName,160)};if(!recorder.externalStaffId&&!recorder.displayName)recorder=null;}
  exactKeys(input.data,eventType==='care.vitals.recorded'?['externalRecordId','observations']:['externalRecordId','items','vitalSigns'],'INVALID_EVENT_DATA');
  const data={...input.data,externalRecordId:input.data.externalRecordId?requiredId(input.data.externalRecordId,'External record ID'):eventId};
  if(eventType==='care.vitals.recorded'&&!Array.isArray(data.observations))throw new IntegrationEventError('EVENT_OBSERVATIONS_REQUIRED','ต้องมี observations',400);
  if(eventType==='care.daily_report.recorded'){if(!Array.isArray(data.items))throw new IntegrationEventError('EVENT_DAILY_ITEMS_REQUIRED','ต้องมี items',400);if(data.vitalSigns!==undefined&&data.vitalSigns!==null){exactKeys(data.vitalSigns,['occurredAt','observations'],'INVALID_EVENT_VITALS');if(!Array.isArray(data.vitalSigns.observations))throw new IntegrationEventError('EVENT_OBSERVATIONS_REQUIRED','ต้องมี observations',400);}}
  const envelope={schemaVersion:'1.0',eventId,eventType,occurredAt:timestamp(input.occurredAt),subject,recorder,data};
  const serialized=stableStringify(envelope);if(Buffer.byteLength(serialized,'utf8')>256*1024)throw new IntegrationEventError('EVENT_TOO_LARGE','event มีขนาดใหญ่เกินกำหนด',413);
  return {envelope,serialized,payloadSha256:crypto.createHash('sha256').update(serialized).digest('hex')};}
module.exports={IntegrationEventError,normalizeEnvelope,stableStringify};
