const crypto=require('node:crypto');
const {normalizeEnvelope,stableStringify}=require('./integrationEvents');
const {normalizeObservations}=require('./vitalSigns');

const TARGET_EVENT_TYPE='care.daily_report.finalized';
const MAX_SAMPLE_BYTES=256*1024;
const MAX_FIELDS=250;
const MAX_DEPTH=8;
const MAX_ARRAY_ITEMS=20;
const MAX_PREVIEW_LENGTH=160;
const BLOCKED_KEYS=new Set(['__proto__','prototype','constructor']);
const SECRET_KEY=/(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|credential)/i;

const TARGET_FIELDS=Object.freeze([
  {id:'eventId',label:'รหัสเหตุการณ์ต้นทาง',section:'ข้อมูลรายงาน',type:'identifier',required:false,aliases:['event_id','eventid','message_id']},
  {id:'subject.externalCenterId',label:'รหัสสาขาต้นทาง',section:'ข้อมูลผู้พัก',type:'identifier',required:true,aliases:['center_id','center_code','branch_id','branch_code','external_center_id']},
  {id:'subject.externalResidentId',label:'รหัสผู้พักต้นทาง',section:'ข้อมูลผู้พัก',type:'identifier',required:true,aliases:['resident_id','resident_code','patient_id','patient_code','external_resident_id']},
  {id:'subject.displayName',label:'ชื่อ-นามสกุลผู้พัก',section:'ข้อมูลผู้พัก',type:'text',required:false,stronglyRecommended:true,aliases:['full_name','display_name','resident_name','patient_name','name']},
  {id:'data.externalRecordId',label:'รหัสรายงานต้นทาง',section:'ข้อมูลรายงาน',type:'identifier',required:true,aliases:['record_id','report_id','daily_id','external_record_id']},
  {id:'data.careDate',label:'วันที่รายงาน',section:'ข้อมูลรายงาน',type:'date',required:true,aliases:['care_date','report_date','record_date','date']},
  {id:'data.recordedAt',label:'เวลาบันทึก',section:'ข้อมูลรายงาน',type:'datetime',required:true,aliases:['recorded_at','created_at','record_time','reported_at']},
  {id:'data.finalizedAt',label:'เวลายืนยัน',section:'ข้อมูลรายงาน',type:'datetime',required:true,aliases:['finalized_at','approved_at','confirmed_at','verified_at']},
  {id:'data.finalizedBy.externalStaffId',label:'รหัสผู้ยืนยัน',section:'ผู้ยืนยัน',type:'identifier',required:false,finalizerIdentity:true,aliases:['finalizer_id','approved_by_id','manager_id','external_staff_id']},
  {id:'data.finalizedBy.displayName',label:'ชื่อผู้ยืนยัน',section:'ผู้ยืนยัน',type:'text',required:false,finalizerIdentity:true,aliases:['finalizer_name','approved_by_name','manager_name','display_name']},
  {id:'data.recordedBy.externalStaffId',label:'รหัสผู้บันทึก',section:'ผู้บันทึก',type:'identifier',required:false,aliases:['recorder_id','recorded_by_id','staff_id']},
  {id:'data.recordedBy.displayName',label:'ชื่อผู้บันทึก',section:'ผู้บันทึก',type:'text',required:false,aliases:['recorder_name','recorded_by_name','staff_name']},
  {id:'vitals.temperature',label:'อุณหภูมิ',section:'สัญญาณชีพ',type:'number',measurementType:'temperature',unit:'Cel',acceptedUnits:['Cel','°C','C','c'],aliases:['temperature','temp','body_temperature']},
  {id:'vitals.bloodPressureSystolic',label:'ความดันตัวบน',section:'สัญญาณชีพ',type:'number',measurementType:'blood_pressure_systolic',unit:'mm[Hg]',acceptedUnits:['mm[Hg]','mmHg','mmhg'],aliases:['systolic','bp_sys','sbp']},
  {id:'vitals.bloodPressureDiastolic',label:'ความดันตัวล่าง',section:'สัญญาณชีพ',type:'number',measurementType:'blood_pressure_diastolic',unit:'mm[Hg]',acceptedUnits:['mm[Hg]','mmHg','mmhg'],aliases:['diastolic','bp_dia','dbp']},
  {id:'vitals.pulse',label:'ชีพจร',section:'สัญญาณชีพ',type:'number',measurementType:'pulse',unit:'/min',acceptedUnits:['/min','bpm','ครั้ง/นาที'],aliases:['pulse','heart_rate','hr']},
  {id:'vitals.spo2',label:'SpO2',section:'สัญญาณชีพ',type:'number',measurementType:'spo2',unit:'%',acceptedUnits:['%','percent'],aliases:['spo2','oxygen_saturation','o2_sat']},
  {id:'data.generalReport',label:'รายงานทั่วไป',section:'รายงานทั่วไป',type:'text',required:false,aliases:['general_report','general_note','symptom_note','note','remark','comment']},
]);
const TARGET_BY_ID=new Map(TARGET_FIELDS.map((field)=>[field.id,field]));

class IntegrationAdapterError extends Error{
  constructor(code,message,status=400){super(message);this.name='IntegrationAdapterError';this.code=code;this.status=status;}
}
function assertSafeKey(key){if(BLOCKED_KEYS.has(String(key)))throw new IntegrationAdapterError('ADAPTER_UNSAFE_SOURCE_KEY','พบชื่อ field ที่ไม่ปลอดภัย',400);}
function preview(value){if(value===null)return 'ไม่มีข้อมูล';if(typeof value==='boolean')return value?'จริง':'เท็จ';const text=String(value);return text.length>MAX_PREVIEW_LENGTH?`${text.slice(0,MAX_PREVIEW_LENGTH)}…`:text;}
function keyForLocator(locator){return Buffer.from(stableStringify(locator)).toString('base64url');}
function pathLabel(path){return path.join('.');}

function sanitizeSample(input){
  if(!input||typeof input!=='object')throw new IntegrationAdapterError('ADAPTER_SAMPLE_INVALID','ข้อมูลตัวอย่างต้องเป็น object หรือ array',400);
  const bytes=Buffer.byteLength(JSON.stringify(input??null),'utf8');
  if(bytes>MAX_SAMPLE_BYTES)throw new IntegrationAdapterError('ADAPTER_SAMPLE_TOO_LARGE','ข้อมูลตัวอย่างมีขนาดใหญ่เกินกำหนด',413);
  let fields=0;
  function walk(value,path=[],depth=0){
    if(depth>MAX_DEPTH)throw new IntegrationAdapterError('ADAPTER_SAMPLE_TOO_DEEP','ข้อมูลตัวอย่างซ้อนกันลึกเกินกำหนด',400);
    if(value===null||typeof value!=='object')return value;
    if(Array.isArray(value)){
      if(value.length>MAX_ARRAY_ITEMS)throw new IntegrationAdapterError('ADAPTER_SAMPLE_ARRAY_TOO_LARGE','รายการในข้อมูลตัวอย่างยาวเกินกำหนด',400);
      return value.map((item,index)=>walk(item,[...path,String(index)],depth+1));
    }
    const clean=Object.create(null);
    for(const [key,valueItem] of Object.entries(value)){
      assertSafeKey(key);fields+=1;if(fields>MAX_FIELDS)throw new IntegrationAdapterError('ADAPTER_SAMPLE_FIELD_LIMIT','ข้อมูลตัวอย่างมี field มากเกินกำหนด',400);
      clean[key]=SECRET_KEY.test(key)?null:walk(valueItem,[...path,key],depth+1);
    }
    return clean;
  }
  const payload=walk(input);
  return{payload,sizeBytes:bytes,structuralFingerprint:crypto.createHash('sha256').update(structuralShape(payload)).digest('hex')};
}
function structuralShape(value){
  if(Array.isArray(value))return `[${value.map(structuralShape).sort().join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${structuralShape(value[key])}`).join(',')}}`;
  return value===null?'null':typeof value;
}
function primitive(value){return value===null||['string','number','boolean'].includes(typeof value);}
function objectUnitPath(container,path){const key=path.at(-1);if(!key||!container||typeof container!=='object'||Array.isArray(container))return null;const explicit=[`${key}_unit`,`${key}Unit`,`${key}_source_unit`,`${key}SourceUnit`].find((candidate)=>primitive(container[candidate])&&container[candidate]!==null);if(explicit)return[...path.slice(0,-1),explicit];if(['value','numeric_value','numericValue','measurement_value','measurementValue'].includes(key)){const generic=['unit','source_unit','sourceUnit'].find((candidate)=>primitive(container[candidate])&&container[candidate]!==null);if(generic)return[...path.slice(0,-1),generic];}return null;}
function discoverFields(payload){
  const result=[];const seen=new Set();
  function add(field){const locatorKey=keyForLocator(field.locator);if(seen.has(locatorKey)||result.length>=MAX_FIELDS)return;seen.add(locatorKey);result.push({...field,locatorKey});}
  function objectWalk(value,path=[],depth=0,parent=null){
    if(depth>MAX_DEPTH||result.length>=MAX_FIELDS)return;
    if(primitive(value)){const key=path.at(-1)||'';const secret=SECRET_KEY.test(key);const unitPath=objectUnitPath(parent,path);add({locator:{kind:'object_path',path,...(unitPath?{unitPath}:{})},sourcePath:pathLabel(path),valuePreview:secret?'ข้อมูลลับ — ไม่สามารถใช้จับคู่':preview(value),unitPreview:unitPath?preview(getPath(payload,unitPath)):null,valueType:value===null?'null':typeof value,selectable:!secret&&value!==null,secret});return;}
    if(Array.isArray(value)){discoverArray(value,path,depth);return;}
    for(const [key,child] of Object.entries(value||{})){assertSafeKey(key);objectWalk(child,[...path,key],depth+1,value);}
  }
  function discoverArray(array,arrayPath,depth){
    if(!array.length)return;
    if(!array.every((item)=>item&&typeof item==='object'&&!Array.isArray(item))){add({locator:{kind:'unstable_array',arrayPath},sourcePath:pathLabel(arrayPath),valuePreview:'ตำแหน่งข้อมูลไม่คงที่ — ยังใช้ไม่ได้',valueType:'array',selectable:false,unstable:true});return;}
    const candidates=['type','code','kind','name','measurement_type','measurementType'];
    const discriminator=candidates.find((key)=>array.every((item)=>primitive(item[key])&&item[key]!==null)&&new Set(array.map((item)=>String(item[key]))).size===array.length);
    if(!discriminator){add({locator:{kind:'unstable_array',arrayPath},sourcePath:pathLabel(arrayPath),valuePreview:'ตำแหน่งข้อมูลไม่คงที่ — ยังใช้ไม่ได้',valueType:'array',selectable:false,unstable:true});return;}
    for(const item of array){
      for(const [key,value] of Object.entries(item)){if(key===discriminator||!primitive(value)||value===null)continue;assertSafeKey(key);
        const unitKey=['unit','source_unit','sourceUnit'].find((candidate)=>primitive(item[candidate])&&item[candidate]!==null)||null;
        const locator={kind:'array_match',arrayPath,where:{field:discriminator,equals:String(item[discriminator])},valuePath:[key],...(unitKey&&unitKey!==key?{unitPath:[unitKey]}:{})};
        add({locator,sourcePath:`${pathLabel(arrayPath)}[${discriminator}=${String(item[discriminator])}].${key}`,valuePreview:preview(value),unitPreview:unitKey?preview(item[unitKey]):null,valueType:typeof value,selectable:true});
      }
    }
  }
  objectWalk(payload);return result;
}
function getPath(value,path){let current=value;for(const key of path||[]){assertSafeKey(key);if(!current||typeof current!=='object'||!Object.prototype.hasOwnProperty.call(current,key))return undefined;current=current[key];}return current;}
function extractLocator(payload,locator){
  if(locator?.kind==='object_path')return{value:getPath(payload,locator.path),unit:locator.unitPath?getPath(payload,locator.unitPath):null};
  if(locator?.kind==='array_match'){
    const array=getPath(payload,locator.arrayPath);if(!Array.isArray(array))return{value:undefined,unit:null};
    const matches=array.filter((item)=>item&&typeof item==='object'&&String(getPath(item,[locator.where?.field]))===String(locator.where?.equals));
    if(matches.length!==1)throw new IntegrationAdapterError('ADAPTER_SOURCE_CHANGED','รูปแบบข้อมูลต้นทางเปลี่ยน',422);
    return{value:getPath(matches[0],locator.valuePath),unit:locator.unitPath?getPath(matches[0],locator.unitPath):null};
  }
  throw new IntegrationAdapterError('ADAPTER_LOCATOR_INVALID','ตำแหน่งข้อมูลต้นทางไม่ถูกต้อง',400);
}
function normalizeNumber(value){if(typeof value==='number'&&Number.isFinite(value))return value;const matches=String(value??'').replace(/,/g,'').match(/[-+]?\d+(?:\.\d+)?/g)||[];if(matches.length!==1)throw new IntegrationAdapterError('ADAPTER_VALUE_INVALID','ค่าตัวเลขจากระบบต้นทางไม่ชัดเจน',422);const number=Number(matches[0]);if(!Number.isFinite(number))throw new IntegrationAdapterError('ADAPTER_VALUE_INVALID','ค่าตัวเลขจากระบบต้นทางไม่ถูกต้อง',422);return number;}
function slashDateParts(clean,withTime=false){
  const pattern=withTime?/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/:/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/;
  const match=clean.match(pattern);if(!match)return null;
  const day=Number(match[1]);const month=Number(match[2]);let year=Number(match[3]);
  // Buddhist Era makes the Thai DD/MM order explicit. Gregorian slash dates
  // with both components <= 12 are locale-ambiguous and must not be guessed.
  if(year<2400&&day<=12&&month<=12)throw new IntegrationAdapterError(withTime?'ADAPTER_DATETIME_INVALID':'ADAPTER_DATE_INVALID',withTime?'วันเวลาจากระบบต้นทางไม่ชัดเจน':'วันที่จากระบบต้นทางไม่ชัดเจน',422);
  if(year>=2400)year-=543;
  return{day,month,year,hour:withTime?Number(match[4]):0,minute:withTime?Number(match[5]):0,second:withTime?Number(match[6]||0):0};
}
function normalizeDate(value){const clean=String(value??'').trim();if(/^\d{4}-\d{2}-\d{2}$/.test(clean)){const date=new Date(`${clean}T00:00:00Z`);if(date.toISOString().slice(0,10)===clean)return clean;}const parts=slashDateParts(clean);if(parts){const iso=`${String(parts.year).padStart(4,'0')}-${String(parts.month).padStart(2,'0')}-${String(parts.day).padStart(2,'0')}`;const date=new Date(`${iso}T00:00:00Z`);if(Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===iso)return iso;}throw new IntegrationAdapterError('ADAPTER_DATE_INVALID','วันที่จากระบบต้นทางไม่ชัดเจน',422);}
function normalizeDatetime(value){const clean=String(value??'').trim();const parts=slashDateParts(clean,true);if(parts){if(parts.hour>23||parts.minute>59||parts.second>59)throw new IntegrationAdapterError('ADAPTER_DATETIME_INVALID','วันเวลาจากระบบต้นทางไม่ชัดเจน',422);const calendar=new Date(Date.UTC(parts.year,parts.month-1,parts.day));if(calendar.getUTCFullYear()!==parts.year||calendar.getUTCMonth()!==parts.month-1||calendar.getUTCDate()!==parts.day)throw new IntegrationAdapterError('ADAPTER_DATETIME_INVALID','วันเวลาจากระบบต้นทางไม่ชัดเจน',422);const iso=`${parts.year}-${String(parts.month).padStart(2,'0')}-${String(parts.day).padStart(2,'0')}T${String(parts.hour).padStart(2,'0')}:${String(parts.minute).padStart(2,'0')}:${String(parts.second).padStart(2,'0')}+07:00`;const parsed=new Date(iso);if(Number.isFinite(parsed.getTime()))return parsed.toISOString();}
  // ISO datetime must carry an explicit UTC marker or numeric offset so the
  // result never depends on the backend machine timezone.
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(clean)){const date=new Date(clean);if(Number.isFinite(date.getTime()))return date.toISOString();}
  throw new IntegrationAdapterError('ADAPTER_DATETIME_INVALID','วันเวลาจากระบบต้นทางไม่ชัดเจน',422);}
function normalizeTargetValue(target,value){if(value===undefined||value===null||String(value).trim()==='')return null;if(value&&typeof value==='object')throw new IntegrationAdapterError('ADAPTER_SOURCE_CHANGED','ชนิดข้อมูลต้นทางเปลี่ยน',422);if(target.type==='number')return normalizeNumber(value);if(target.type==='date')return normalizeDate(value);if(target.type==='datetime')return normalizeDatetime(value);const clean=String(value).trim();if(!clean)return null;if(clean.length>(target.type==='identifier'?160:5000))throw new IntegrationAdapterError('ADAPTER_VALUE_TOO_LONG','ข้อมูลที่จับคู่ยาวเกินกำหนด',422);return clean;}
function inferKnownUnit(target,value){const clean=String(value??'').trim().toLowerCase();return(target.acceptedUnits||[]).find((unit)=>clean.endsWith(String(unit).toLowerCase()))||null;}
function hasUnknownUnitSuffix(value){if(typeof value==='number')return false;const clean=String(value??'').trim();if(!clean)return false;return clean.replace(/[-+]?\d+(?:[.,]\d+)?/,'').trim().length>0;}
function sourceName(field){const locator=field.locator||{};return String(locator.kind==='object_path'?locator.path?.at(-1):locator.where?.equals||field.sourcePath||'').toLowerCase().replace(/[^a-z0-9]+/g,'_');}
function autoSuggest(fields){return fields.map((field)=>{if(!field.selectable)return{...field,suggestedTarget:null};const name=sourceName(field);let best=null;let score=0;for(const target of TARGET_FIELDS){for(const alias of target.aliases||[]){const normalized=alias.toLowerCase();const candidate=name===normalized?100:name.endsWith(`_${normalized}`)?80:name.includes(normalized)?55:0;if(candidate>score){best=target.id;score=candidate;}}}return{...field,suggestedTarget:score>=55?best:null,suggestionScore:score};});}
function validateMappingRules(rules,fields){
  if(!Array.isArray(rules))throw new IntegrationAdapterError('ADAPTER_RULES_REQUIRED','กรุณาจับคู่ข้อมูล',400);
  const available=new Map(fields.filter((field)=>field.selectable).map((field)=>[field.locatorKey,field.locator]));const usedTargets=new Set();const normalized=[];
  for(const rule of rules){const target=TARGET_BY_ID.get(String(rule?.targetField||''));if(!target)throw new IntegrationAdapterError('ADAPTER_TARGET_INVALID','พบข้อมูล PHIMOR ที่ไม่รองรับ',400);if(usedTargets.has(target.id))throw new IntegrationAdapterError('ADAPTER_DUPLICATE_TARGET','ข้อมูล PHIMOR หนึ่งช่องจับคู่ได้ครั้งเดียว',400);usedTargets.add(target.id);
    const keys=Array.isArray(rule.locatorKeys)?rule.locatorKeys:[rule.locatorKey];const locators=keys.filter(Boolean).map((key)=>{const locator=available.get(String(key));if(!locator)throw new IntegrationAdapterError('ADAPTER_LOCATOR_INVALID','ข้อมูลต้นทางที่เลือกไม่พร้อมใช้งาน',400);return locator;});if(!locators.length)continue;
    normalized.push({targetField:target.id,transform:locators.length>1?'join_text':target.type,locators});
  }
  const mapped=new Set(normalized.map((rule)=>rule.targetField));for(const target of TARGET_FIELDS.filter((field)=>field.required)){if(!mapped.has(target.id))throw new IntegrationAdapterError('ADAPTER_REQUIRED_TARGET_MISSING',`กรุณาจับคู่ ${target.label}`,422);}
  if(!TARGET_FIELDS.filter((field)=>field.finalizerIdentity).some((target)=>mapped.has(target.id)))throw new IntegrationAdapterError('ADAPTER_FINALIZER_REQUIRED','กรุณาจับคู่รหัสหรือชื่อผู้ยืนยัน',422);
  return normalized;
}
function transformPayload({integrationClientId,targetEventType=TARGET_EVENT_TYPE,rules,payload}){
  if(targetEventType!==TARGET_EVENT_TYPE)throw new IntegrationAdapterError('ADAPTER_EVENT_TYPE_UNSUPPORTED','ยังไม่รองรับประเภทข้อมูลนี้',400);
  const values=new Map();const units=new Map();const rawValues=new Map();
  for(const rule of rules){const target=TARGET_BY_ID.get(rule.targetField);if(!target)throw new IntegrationAdapterError('ADAPTER_TARGET_INVALID','พบ mapping ที่ไม่รองรับ',422);const extracted=rule.locators.map((locator)=>extractLocator(payload,locator));if(extracted.some((item)=>item.value===undefined))throw new IntegrationAdapterError('ADAPTER_SOURCE_CHANGED',`ไม่พบข้อมูลสำหรับ ${target.label}`,422);const raw=rule.transform==='join_text'?extracted.map((item)=>String(item.value??'').trim()).filter(Boolean).join(' '):extracted[0].value;const value=normalizeTargetValue(target,raw);if(value!==null){values.set(target.id,value);rawValues.set(target.id,raw);}if(extracted[0]?.unit!==undefined&&extracted[0]?.unit!==null)units.set(target.id,String(extracted[0].unit).trim());}
  for(const target of TARGET_FIELDS.filter((field)=>field.required)){if(!values.has(target.id))throw new IntegrationAdapterError('ADAPTER_SOURCE_CHANGED',`ไม่พบข้อมูลสำหรับ ${target.label}`,422);}
  if(!TARGET_FIELDS.filter((field)=>field.finalizerIdentity).some((target)=>values.has(target.id)))throw new IntegrationAdapterError('ADAPTER_SOURCE_CHANGED','ไม่พบข้อมูลผู้ยืนยัน',422);
  const observations=[];for(const target of TARGET_FIELDS.filter((field)=>field.measurementType)){if(!values.has(target.id))continue;const explicit=units.get(target.id);const matchedUnit=explicit?target.acceptedUnits.find((unit)=>unit.toLowerCase()===explicit.toLowerCase()):null;if(explicit&&!matchedUnit)throw new IntegrationAdapterError('ADAPTER_UNIT_UNSUPPORTED',`หน่วยของ ${target.label} ไม่รองรับ`,422);const inferredUnit=inferKnownUnit(target,rawValues.get(target.id));if(!explicit&&!inferredUnit&&hasUnknownUnitSuffix(rawValues.get(target.id)))throw new IntegrationAdapterError('ADAPTER_UNIT_UNSUPPORTED',`หน่วยของ ${target.label} ไม่รองรับ`,422);const sourceUnit=matchedUnit||inferredUnit||target.unit;observations.push({measurementType:target.measurementType,numericValue:values.get(target.id),sourceValueText:String(rawValues.get(target.id)),sourceUnit});}
  if(observations.length)normalizeObservations(observations);
  const externalRecordId=values.get('data.externalRecordId');const finalizedAt=values.get('data.finalizedAt');
  const eventId=values.get('eventId')||`ADP-${crypto.createHash('sha256').update(`${integrationClientId}|${targetEventType}|${externalRecordId}`).digest('hex').slice(0,40)}`;
  const finalizedBy={};if(values.has('data.finalizedBy.externalStaffId'))finalizedBy.externalStaffId=values.get('data.finalizedBy.externalStaffId');if(values.has('data.finalizedBy.displayName'))finalizedBy.displayName=values.get('data.finalizedBy.displayName');
  let recordedBy=null;if(values.has('data.recordedBy.externalStaffId')||values.has('data.recordedBy.displayName')){recordedBy={};if(values.has('data.recordedBy.externalStaffId'))recordedBy.externalStaffId=values.get('data.recordedBy.externalStaffId');if(values.has('data.recordedBy.displayName'))recordedBy.displayName=values.get('data.recordedBy.displayName');}
  const careItems=values.has('data.generalReport')?[{itemType:'symptom_note',valueType:'text',value:values.get('data.generalReport')}]:[];
  const canonical={schemaVersion:'1.0',eventId,eventType:targetEventType,occurredAt:finalizedAt,subject:{externalCenterId:values.get('subject.externalCenterId'),externalResidentId:values.get('subject.externalResidentId'),...(values.has('subject.displayName')?{displayName:values.get('subject.displayName')}:{})},data:{externalRecordId,careDate:values.get('data.careDate'),observations,careItems,...(recordedBy?{recordedBy}:{}),finalizedBy,recordedAt:values.get('data.recordedAt'),finalizedAt}};
  return normalizeEnvelope(canonical).envelope;
}

module.exports={TARGET_EVENT_TYPE,TARGET_FIELDS,MAX_SAMPLE_BYTES,MAX_FIELDS,MAX_DEPTH,MAX_ARRAY_ITEMS,
  IntegrationAdapterError,sanitizeSample,structuralShape,discoverFields,autoSuggest,keyForLocator,
  extractLocator,validateMappingRules,transformPayload,normalizeDate,normalizeDatetime,normalizeNumber,inferKnownUnit};
