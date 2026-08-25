const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

process.env.NODE_ENV='test';

const { AIProviderError,AI_ERROR_CODES }=require('../backend/providers/aiErrors');
const {
  validatePharmacistAssistantResponse,hasForbiddenOutputKey,
}=require('../backend/providers/pharmacistAssistant');
const {
  createConsultationContextBuilder,minimizeConversation,MAX_CONVERSATION_CHARACTERS,
}=require('../backend/services/consultationContextBuilder');
const { createPharmacistAssistantService }=require('../backend/services/pharmacistAssistantService');

const NOW='2026-08-25T10:00:00.000Z';
const CASE={
  case_id:'CASE-1',care_profile_id:'CP-1',assigned_pharmacist_id:'PH-1',
  state:'active',initial_question:'ยาครั้งนี้เปลี่ยนอะไร และมีนัดเมื่อไร',
  order_status:'paid',provisioning_status:'provisioned',
  accepted_at:'2026-08-25T00:00:00.000Z',expires_at:'2026-08-26T00:00:00.000Z',database_now:NOW,
};
const PROFILE={
  care_profile_id:'CP-1',patient_name:'ชื่อไม่ควรส่ง',drug_allergies:'Penicillin',
  chronic_conditions:['เบาหวาน'],family_phone:'0811111111',emergency_contact_phone:'0822222222',
  owner_line_id:'U-FAMILY',health_history:[{weight:60}],_updatedAt:'2026-08-24T00:00:00.000Z',
};
const SNAPSHOTS=[
  {snapshot_id:'S-2',care_profile_id:'CP-1',recorded_at:'2026-08-24T00:00:00.000Z',items:[{name:'Drug A',dose:'2 เม็ด',instruction:'หลังอาหาร'}]},
  {snapshot_id:'S-1',care_profile_id:'CP-1',recorded_at:'2026-08-20T00:00:00.000Z',items:[{name:'Drug A',dose:'1 เม็ด',instruction:'หลังอาหาร'}]},
];

function contextDependencies(overrides={}) {
  return {
    repository:{
      async findCaseForRead(){return CASE;},
      async listRecentMessages(){return [
        {message_id:'M-1',message_sequence:1,sender_type:'customer',sender_id:'U-FAMILY',body:'อยากทราบข้อมูลยา',created_at:NOW},
        {message_id:'M-2',message_sequence:2,sender_type:'pharmacist',sender_id:'PH-1',body:'ขอตรวจสอบข้อมูล',created_at:NOW},
      ];},
    },
    pharmacistAccounts:{async requireActive(){return {pharmacistId:'PH-1',status:'active',licenseVerifiedAt:NOW};}},
    careProfiles:{async findOne(predicate){return predicate(PROFILE)?PROFILE:null;}},
    medicationSnapshots:{async findWhere(predicate){return SNAPSHOTS.filter(predicate);}},
    appointments:{async findWhere(predicate){return [{appointment_id:'A-1',care_profile_id:'CP-1',datetime:'2026-08-30T10:00:00.000Z',hospital:'Hospital',status:'active',phone:'0833333333'}].filter(predicate);}},
    async loadMedications(snapshot){return {medications:snapshot.items,medicationSource:'snapshot_embedded_items'};},
    ...overrides,
  };
}

function validAssistant() {
  const recorded={text:'มีประวัติแพ้ Penicillin',sourceCategory:'care_profile'};
  const guidance={text:'ตรวจสอบความครบถ้วนของข้อมูล',sourceCategory:'general_ai_knowledge'};
  return {
    caseSummary:'สรุปเคสสำหรับเภสัชกร',recordedFacts:[recorded],
    relevantMedicationContext:[{text:'Drug A 2 เม็ด',sourceCategory:'medication_snapshot'}],
    medicationChanges:[{text:'ขนาดที่บันทึกเปลี่ยน',sourceCategory:'medication_diff'}],
    missingInformation:[],questionsToAsk:[guidance],safetyConsiderations:[guidance],
    responseGuidance:[guidance],escalationConsiderations:[],
    disclaimer:'ข้อมูลนี้เป็นตัวช่วยสำหรับเภสัชกรและต้องตรวจสอบก่อนใช้งาน',
  };
}

test('assigned active verified pharmacist receives purpose-minimized attributed context',async()=>{
  const context=await createConsultationContextBuilder(contextDependencies())({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM',now:NOW});
  assert.equal(context.case.caseId,'CASE-1');
  assert.equal(context.currentMedications[0].source.category,'medication_snapshot');
  assert.equal(context.medicationChanges.source.category,'medication_diff');
  assert.equal(context.recordedFacts[0].source.category,'care_profile');
  assert.equal(context.appointments[0].source.category,'appointment');
  assert.equal(context.conversation.messages[0].source.category,'consultation_message');
});

test('context excludes LINE identities contacts Health History documents images and audit data',async()=>{
  const context=await createConsultationContextBuilder(contextDependencies())({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM',now:NOW});
  const serialized=JSON.stringify(context);
  for(const secret of ['U-FAMILY','U-PHARM','0811111111','0822222222','0833333333','health_history','owner_line_id','Base64','auditLog','patient_name']) {
    assert.equal(serialized.includes(secret),false,secret);
  }
});

test('medication diff and appointments are loaded only when conversation is relevant',async()=>{
  const deps=contextDependencies({repository:{
    async findCaseForRead(){return {...CASE,initial_question:'ช่วยสรุปสิ่งที่คุยกัน'};},
    async listRecentMessages(){return [];},
  }});
  const context=await createConsultationContextBuilder(deps)({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM',now:NOW});
  assert.equal(context.medicationChanges,null); assert.deepEqual(context.appointments,[]);
  assert.equal(context.currentMedications.length,0);
});

test('unassigned pharmacist is denied before clinical stores are read',async()=>{
  let reads=0;
  const deps=contextDependencies({
    pharmacistAccounts:{async requireActive(){return {pharmacistId:'PH-OTHER'};}},
    careProfiles:{async findOne(){reads+=1;return PROFILE;}},
  });
  await assert.rejects(createConsultationContextBuilder(deps)({caseId:'CASE-1',pharmacistLineUserId:'U-X'}),{code:'CONSULTATION_ACCESS_DENIED'});
  assert.equal(reads,0);
});

test('suspended or unverified pharmacist failure stops before case context',async()=>{
  let caseReads=0;
  const error=Object.assign(new Error('denied'),{code:'PHARMACIST_INACTIVE',status:403});
  const deps=contextDependencies({
    pharmacistAccounts:{async requireActive(){throw error;}},
    repository:{async findCaseForRead(){caseReads+=1;return CASE;}},
  });
  await assert.rejects(createConsultationContextBuilder(deps)({caseId:'CASE-1',pharmacistLineUserId:'U-X'}),{code:'PHARMACIST_INACTIVE'});
  assert.equal(caseReads,0);
});

test('closed or exactly expired case cannot generate new context',async()=>{
  for(const row of [{...CASE,state:'closed'},{...CASE,database_now:CASE.expires_at}]) {
    const deps=contextDependencies({repository:{async findCaseForRead(){return row;},async listRecentMessages(){return [];}}});
    await assert.rejects(createConsultationContextBuilder(deps)({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM'}),{code:'CONSULTATION_EXPIRED'});
  }
});

test('unpaid or unprovisioned case and unavailable Care Profile fail closed',async()=>{
  const unpaid=contextDependencies({repository:{async findCaseForRead(){return {...CASE,order_status:'payment_pending'};},async listRecentMessages(){return [];}}});
  await assert.rejects(createConsultationContextBuilder(unpaid)({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM'}));
  const missing=contextDependencies({careProfiles:{async findOne(){return null;}}});
  await assert.rejects(createConsultationContextBuilder(missing)({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM'}),{code:'CARE_PROFILE_NOT_FOUND'});
});

test('conversation uses latest role-labelled messages under a strict character budget',()=>{
  const rows=Array.from({length:20},(_,index)=>({message_id:`M-${index}`,message_sequence:index+1,sender_type:index%2?'pharmacist':'customer',body:'x'.repeat(1000),created_at:NOW}));
  const context=minimizeConversation('initial',rows,MAX_CONVERSATION_CHARACTERS);
  const length=context.messages.reduce((sum,item)=>sum+item.text.length,0)+String(context.initialQuestion?.value||'').length;
  assert.ok(length<=MAX_CONVERSATION_CHARACTERS); assert.equal(context.truncated,true);
  assert.ok(context.messages.every((item)=>['customer','pharmacist'].includes(item.role)));
  assert.equal(JSON.stringify(context).includes('sender_id'),false);
});

test('structured response separates recorded facts and general guidance with attribution',()=>{
  const value=validatePharmacistAssistantResponse(validAssistant());
  assert.equal(value.recordedFacts[0].sourceCategory,'care_profile');
  assert.equal(value.responseGuidance[0].sourceCategory,'general_ai_knowledge');
});

test('final patient answer and auto-send fields are rejected recursively',()=>{
  for(const key of ['finalAnswer','patientResponse','sendToCustomer']) {
    assert.equal(hasForbiddenOutputKey({nested:{[key]:'do not send'}}),true);
    assert.throws(()=>validatePharmacistAssistantResponse({...validAssistant(),[key]:'unsafe'}),{code:'AI_INVALID_RESPONSE'});
  }
});

test('assistant passes only minimized structured context and returns refresh timestamps',async()=>{
  let call; let audit;
  const service=createPharmacistAssistantService({
    config:{ai:{provider:'gemini',explanationModel:'test-model',timeoutMs:1000,maxRetries:0}},
    contextBuilder:async()=>({schemaVersion:'consultation-context-v1',contextTimestamp:NOW,case:{caseId:'CASE-1'},recordedFacts:[]}),
    provider:{async generateStructured(input){call=input;return validAssistant();}},
    recordAudit:async(input)=>{audit=input;return {recorded:true};},
  });
  const result=await service({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM'});
  assert.equal(result.status,'available'); assert.equal(result.contextTimestamp,NOW);
  assert.equal(call.task,'pharmacist_assistance'); assert.equal(call.context.includes('U-PHARM'),false);
  assert.equal(audit.requesterType,'pharmacist'); assert.equal(audit.consultationCaseId,'CASE-1');
  assert.equal(Object.hasOwn(audit,'rawPrompt'),false); assert.equal(Object.hasOwn(audit,'rawResponse'),false);
});

test('provider failures return safe unavailable and do not mutate or block manual chat',async()=>{
  for(const code of [AI_ERROR_CODES.AI_TIMEOUT,AI_ERROR_CODES.AI_RATE_LIMIT,AI_ERROR_CODES.AI_INVALID_RESPONSE,AI_ERROR_CODES.AI_UNAVAILABLE,AI_ERROR_CODES.AI_PROVIDER_ERROR]) {
    let writes=0;
    const service=createPharmacistAssistantService({
      config:{ai:{provider:'gemini',explanationModel:'test',timeoutMs:100,maxRetries:0}},
      contextBuilder:async()=>({schemaVersion:'v1',contextTimestamp:NOW}),
      provider:{async generateStructured(){throw new AIProviderError(code);}},
      recordAudit:async()=>({recorded:true}),healthWriter:()=>{writes+=1;},messageService:()=>{writes+=1;},
    });
    const result=await service({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM'});
    assert.deepEqual({status:result.status,errorCode:result.errorCode},{status:'unavailable',errorCode:code});
    assert.equal(JSON.stringify(result).includes('stack'),false); assert.equal(writes,0);
  }
});

test('invalid provider structure maps to AI_INVALID_RESPONSE and audit stores metadata only',async()=>{
  let audit;
  const service=createPharmacistAssistantService({
    config:{ai:{provider:'gemini',explanationModel:'test',timeoutMs:100,maxRetries:0}},
    contextBuilder:async()=>({schemaVersion:'v1',contextTimestamp:NOW,secretClinicalContext:'not audited'}),
    provider:{async generateStructured(){return {caseSummary:'missing arrays'};}},
    recordAudit:async(input)=>{audit=input;},
  });
  const result=await service({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM'});
  assert.equal(result.errorCode,'AI_INVALID_RESPONSE'); assert.equal(audit.errorCode,'AI_INVALID_RESPONSE');
  assert.equal(JSON.stringify(audit).includes('secretClinicalContext'),false);
});

test('AI audit sanitizer accepts consultation metadata and rejects raw health fields',()=>{
  const {sanitizeAIInteractionMetadata}=require('../backend/services/aiAuditService');
  const record=sanitizeAIInteractionMetadata({consultationCaseId:'CASE-1',requesterType:'pharmacist',rawPrompt:'secret',healthContext:{drug:'x'}});
  assert.equal(record.consultationCaseId,'CASE-1'); assert.equal(record.requesterType,'pharmacist');
  assert.equal(Object.hasOwn(record,'rawPrompt'),false); assert.equal(Object.hasOwn(record,'healthContext'),false);
});

test('assistant foundation has no Care Profile, Health History, appointment, medication, or chat write dependency',()=>{
  const files=['consultationContextBuilder.js','pharmacistAssistantService.js'];
  const source=files.map((file)=>fs.readFileSync(path.join(__dirname,'..','backend','services',file),'utf8')).join('\n');
  for(const forbidden of [
    'careProfileHealthHistoryService','updateCareProfileHealth','CareProfiles.update',
    'Appointments.update','Medications.update','MedicationSnapshots.insert','sendMessage(',
  ]) assert.equal(source.includes(forbidden),false,forbidden);
});
