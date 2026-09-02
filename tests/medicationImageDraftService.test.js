const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MedicationImageDraftError, createMedicationImageDraftService,
} = require('../backend/services/medicationImageDraftService');
const { AI_ERROR_CODES, AIProviderError } = require('../backend/providers/aiErrors');

const decoded = { ok:true, buffer:Buffer.from('image'), mimeType:'image/jpeg' };

test('one source image can produce multiple canonical medication drafts', async () => {
  const service=createMedicationImageDraftService({
    decode:()=>decoded,
    operationalLogger:()=>{},
    interpret:async()=>({medications:[
      {name:'Amlodipine',strength:'10 mg',dose:'1',unit:'เม็ด',frequency:'1 ครั้ง',timing:'ก่อนนอน',instruction:'รับประทานครั้งละ 1 เม็ด ก่อนนอน',amount:'30',route:'รับประทาน',condition:'',uncertainFields:[]},
      {name:'Metformin',dose:'1',unit:'เม็ด',uncertainFields:['timing','unknownField']},
    ]}),
  });
  const result=await service.extractImage({imageBase64:'ignored'});
  assert.equal(result.items.length,2);
  assert.equal(result.items[0].amount,'30');
  assert.equal(result.items[1].strength,'');
  assert.deepEqual(result.review[1],{extractedIndex:1,state:'review',uncertainFields:['timing']});
  assert.equal(result.status,'read');
});

test('draft projection strips provider extras and never invents missing facts', async () => {
  const service=createMedicationImageDraftService({decode:()=>decoded,interpret:async()=>({medications:[
    {name:'Drug A',providerPayload:'secret',diagnosis:'invented'},
  ]}),operationalLogger:()=>{}});
  const result=await service.extractImage({imageBase64:'ignored'});
  assert.deepEqual(Object.keys(result.items[0]).sort(),
    ['amount','condition','dose','frequency','instruction','name','route','strength','timing','unit'].sort());
  assert.doesNotMatch(JSON.stringify(result),/secret|invented|providerPayload|diagnosis/);
});

test('decode failure retains its own safe input error and never invokes provider', async () => {
  let invoked=false;const events=[];
  const service=createMedicationImageDraftService({
    decode:()=>({ok:false,error:'unsupported_image',status:415,message:'รองรับเฉพาะรูปภาพ'}),
    interpret:async()=>{invoked=true},operationalLogger:(event)=>events.push(event),
  });
  await assert.rejects(service.extractImage({imageBase64:'private-image'}),(error)=>{
    assert.ok(error instanceof MedicationImageDraftError);
    assert.equal(error.code,'unsupported_image');
    assert.equal(error.status,415);
    return true;
  });
  assert.equal(invoked,false);
  assert.deepEqual(events,[{event:'medication_image_extraction',stage:'image_rejected',safeErrorCode:'unsupported_image'}]);
});

test('temporary provider failure is extraction unavailable, not image unreadable', async () => {
  const events=[];
  const service=createMedicationImageDraftService({decode:()=>decoded,interpret:async()=>{
    throw new AIProviderError(AI_ERROR_CODES.AI_TIMEOUT,'raw provider secret',{retryable:true});
  },operationalLogger:(event)=>events.push(event)});
  await assert.rejects(service.extractImage({imageBase64:'ignored'}),(error)=>{
    assert.ok(error instanceof MedicationImageDraftError);
    assert.equal(error.code,'MEDICATION_EXTRACTION_UNAVAILABLE');
    assert.equal(error.diagnosticCode,AI_ERROR_CODES.AI_TIMEOUT);
    assert.equal(error.status,503);
    assert.notEqual(error.code,'MEDICATION_IMAGE_UNREADABLE');
    assert.doesNotMatch(error.message,/provider|secret/);
    return true;
  });
  assert.deepEqual(events.map((event)=>event.stage),['image_decoded','provider_invoked','provider_failed']);
  assert.doesNotMatch(JSON.stringify(events),/secret|ignored|label text/i);
});

test('invalid AI response is safely classified separately from provider availability', async () => {
  const events=[];
  const service=createMedicationImageDraftService({decode:()=>decoded,
    interpret:async()=>({medications:'invalid',rawProviderResponse:'private label text'}),
    operationalLogger:(event)=>events.push(event)});
  await assert.rejects(service.extractImage({imageBase64:'ignored'}),(error)=>{
    assert.equal(error.code,'MEDICATION_EXTRACTION_UNAVAILABLE');
    assert.equal(error.diagnosticCode,AI_ERROR_CODES.AI_INVALID_RESPONSE);
    return true;
  });
  assert.deepEqual(events.map((event)=>event.stage),
    ['image_decoded','provider_invoked','provider_succeeded','response_validation_failed']);
  assert.doesNotMatch(JSON.stringify(events),/private label|rawProviderResponse|ignored/);
});

test('valid empty response is no-medication-detected rather than provider failure', async () => {
  const events=[];
  const service=createMedicationImageDraftService({decode:()=>decoded,interpret:async()=>({medications:[]}),operationalLogger:(event)=>events.push(event)});
  assert.deepEqual(await service.extractImage({imageBase64:'ignored'}),{items:[],review:[],status:'no_medication_detected'});
  assert.deepEqual(events.at(-1),{event:'medication_image_extraction',stage:'response_validated',medicationCandidateCount:0});
});

test('safe extraction observability reports count but no image or medication content', async () => {
  const events=[];
  const service=createMedicationImageDraftService({decode:()=>({ok:true,buffer:Buffer.from('private image bytes'),mimeType:'image/jpeg'}),
    interpret:async()=>({medications:[{name:'private medication name'}]}),operationalLogger:(event)=>events.push(event)});
  const result=await service.extractImage({imageBase64:'private base64'});
  assert.equal(result.items.length,1);
  assert.deepEqual(events.map((event)=>event.stage),['image_decoded','provider_invoked','provider_succeeded','response_validated']);
  assert.equal(events.at(-1).medicationCandidateCount,1);
  assert.doesNotMatch(JSON.stringify(events),/private|base64|medication name|bytes/);
});
