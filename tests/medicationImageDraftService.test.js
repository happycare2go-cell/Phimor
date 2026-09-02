const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MedicationImageDraftError, createMedicationImageDraftService,
} = require('../backend/services/medicationImageDraftService');

const decoded = { ok:true, buffer:Buffer.from('image'), mimeType:'image/jpeg' };

test('one source image can produce multiple canonical medication drafts', async () => {
  const service=createMedicationImageDraftService({
    decode:()=>decoded,
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
  ]})});
  const result=await service.extractImage({imageBase64:'ignored'});
  assert.deepEqual(Object.keys(result.items[0]).sort(),
    ['amount','condition','dose','frequency','instruction','name','route','strength','timing','unit'].sort());
  assert.doesNotMatch(JSON.stringify(result),/secret|invented|providerPayload|diagnosis/);
});

test('unreadable provider failure is converted to safe per-image failure', async () => {
  const service=createMedicationImageDraftService({decode:()=>decoded,interpret:async()=>{throw new Error('raw provider secret')}});
  await assert.rejects(service.extractImage({imageBase64:'ignored'}),(error)=>{
    assert.ok(error instanceof MedicationImageDraftError);
    assert.equal(error.code,'MEDICATION_IMAGE_UNREADABLE');
    assert.equal(error.status,422);
    assert.doesNotMatch(error.message,/provider|secret/);
    return true;
  });
});

test('empty extraction is an unreadable draft and never fabricates a medication', async () => {
  const service=createMedicationImageDraftService({decode:()=>decoded,interpret:async()=>({medications:[]})});
  assert.deepEqual(await service.extractImage({imageBase64:'ignored'}),{items:[],review:[],status:'unreadable'});
});
