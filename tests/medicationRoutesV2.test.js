const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
process.env.NODE_ENV='test';
process.env.ALLOW_INSECURE_LINE_HEADER='true';
process.env.PDF_DOWNLOAD_SECRET=process.env.PDF_DOWNLOAD_SECRET||'test-pdf-secret';

const db=require('../backend/db');
const aiProvider=require('../backend/providers/aiProvider');
const {AI_ERROR_CODES,AIProviderError}=require('../backend/providers/aiErrors');
const VALID_JPEG_BASE64=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0xff,0xd9]).toString('base64');
let server,baseUrl;

before(async()=>{const app=require('../backend/server');server=http.createServer(app);await new Promise((resolve)=>server.listen(0,resolve));baseUrl=`http://127.0.0.1:${server.address().port}`});
after(async()=>new Promise((resolve)=>server.close(resolve)));
beforeEach(()=>{db.resetAll();aiProvider.clearMockQueue()});

async function request(path,{method='GET',body=null,user='U-OWNER'}={}){
  const response=await fetch(`${baseUrl}${path}`,{method,headers:{'Content-Type':'application/json','X-Line-User-Id':user},body:body===null?undefined:JSON.stringify(body)});
  return{response,body:response.headers.get('content-type')?.includes('json')?await response.json():null};
}

async function family(){return db.CareProfiles.insert({care_profile_id:'CP-1',owner_line_id:'U-OWNER',patient_name:'บุคคลตัวอย่าง',status:'independent'})}
async function center(){
  await db.Centers.insert({center_id:'C-1',name:'ศูนย์ตัวอย่าง',status:'active',subscription_required:false});
  await db.CenterStaff.insert({staff_id:'S-OWNER',center_id:'C-1',line_user_id:'U-CENTER',role:'owner',status:'active'});
  await db.CenterStaff.insert({staff_id:'S-STAFF',center_id:'C-1',line_user_id:'U-STAFF',role:'staff',status:'active'});
  await db.CareProfiles.insert({care_profile_id:'CP-1',patient_name:'บุคคลตัวอย่าง',status:'linked',center_id:'C-1'});
  await db.Residents.insert({resident_id:'R-1',center_id:'C-1',care_profile_id:'CP-1',status:'active'});
}

test('Family current-set route writes reads and stale-conflicts authoritatively',async()=>{
  await family();
  let result=await request('/api/care-profile/CP-1/medications/current',{method:'PUT',body:{baseSnapshotId:null,items:[{name:'Aspirin',strength:'81 mg'}]}});
  assert.equal(result.response.status,201);const first=result.body.currentSnapshot.snapshotId;
  result=await request('/api/care-profile/CP-1/medications/current');
  assert.equal(result.body.medications[0].strength,'81 mg');
  const second=await request('/api/care-profile/CP-1/medications/current',{method:'PUT',body:{baseSnapshotId:first,items:[{name:'Aspirin',strength:'325 mg'}]}});
  assert.equal(second.response.status,201);
  const stale=await request('/api/care-profile/CP-1/medications/current',{method:'PUT',body:{baseSnapshotId:first,items:[{name:'Aspirin',strength:'500 mg'}]}});
  assert.equal(stale.response.status,409);assert.equal(stale.body.errorCode,'MEDICATION_SNAPSHOT_STALE');
});

test('Family route round-trips structured schedule and rejects contradictory direct payload',async()=>{
  await family();
  const item={name:'Amlodipine',strength:'10 mg',indication:'ความดันโลหิตสูง',dose:'1',unit:'เม็ด',
    frequency:'2 ครั้ง',useCondition:'after_meal',dayPeriods:['evening','morning'],notes:'ติดตามตามแผน'};
  let result=await request('/api/care-profile/CP-1/medications/current',{method:'PUT',body:{items:[item]}});
  assert.equal(result.response.status,201);
  assert.deepEqual(result.body.medications[0].dayPeriods,['morning','evening']);
  assert.equal(result.body.medications[0].useCondition,'after_meal');
  const snapshot=result.body.currentSnapshot.snapshotId;
  result=await request('/api/care-profile/CP-1/medications/current',{method:'PUT',body:{baseSnapshotId:snapshot,
    items:[{...item,frequency:'3 ครั้ง'}]}});
  assert.equal(result.response.status,422);
  assert.equal(result.body.errorCode,'MEDICATION_SCHEDULE_CONFLICT');
  assert.equal((await db.MedicationSnapshots.findAll()).length,1);
});

test('Family duplicate error identifies rows without returning medication clinical values',async()=>{
  await family();
  const result=await request('/api/care-profile/CP-1/medications/current',{method:'PUT',body:{items:[{name:'Aspirin',strength:'81 mg'},{name:' aspirin ',strength:'325 mg'}]}});
  assert.equal(result.response.status,422);assert.equal(result.body.errorCode,'DUPLICATE_MEDICATION_IDENTITY');
  assert.deepEqual(result.body.conflicts[0].rows,[0,1]);
  assert.doesNotMatch(JSON.stringify(result.body),/81 mg|325 mg/);
});

test('legacy single-medication route is safely deprecated and creates no row',async()=>{
  await family();
  const result=await request('/api/medications',{method:'POST',body:{careProfileId:'CP-1',name:'Aspirin',dose:'1'}});
  assert.equal(result.response.status,409);assert.equal(result.body.errorCode,'CURRENT_MEDICATION_SET_REQUIRED');
  assert.equal((await db.Medications.findAll()).length,0);
});

test('caregiver needs explicit manage_medications permission while current read remains allowed',async()=>{
  await family();
  await db.CareProfileMembers.insert({member_id:'M-1',care_profile_id:'CP-1',line_user_id:'U-CARE',role:'caregiver',status:'active',permissions:['view']});
  assert.equal((await request('/api/care-profile/CP-1/medications/current',{user:'U-CARE'})).response.status,200);
  assert.equal((await request('/api/care-profile/CP-1/medications/current',{method:'PUT',user:'U-CARE',body:{items:[{name:'A'}]}})).response.status,403);
  await db.CareProfileMembers.update((item)=>item.member_id==='M-1',{permissions:['view','manage_medications']});
  assert.equal((await request('/api/care-profile/CP-1/medications/current',{method:'PUT',user:'U-CARE',body:{items:[{name:'A'}]}})).response.status,201);
});

test('safe history and legacy compatibility history route never return raw identity or image',async()=>{
  await family();
  await request('/api/care-profile/CP-1/medications/current',{method:'PUT',body:{items:[{name:'A'}],source:'image_ai',imageBase64:'private-image'}});
  for(const path of ['/api/care-profile/CP-1/medications/history','/api/care-profile/CP-1/medication-snapshots']){
    const result=await request(path);assert.equal(result.response.status,200);
    assert.doesNotMatch(JSON.stringify(result.body),/private-image|source_image_base64|recorded_by|U-OWNER/);
  }
});

test('Center Owner writes through Resident route while Staff is read-only',async()=>{
  await center();const path='/api/residents/R-1/medications/current?centerId=C-1';
  const ownerResult=await request(path,{method:'PUT',user:'U-CENTER',body:{items:[{name:'Aspirin'}]}});
  assert.equal(ownerResult.response.status,201);
  const staffRead=await request(path,{user:'U-STAFF'});assert.equal(staffRead.response.status,200);
  assert.equal(staffRead.body.careProfileId,'CP-1');
  assert.equal((await request(path,{method:'PUT',user:'U-STAFF',body:{items:[{name:'Forged'}]}})).response.status,403);
});

test('Center cannot forge another Center or discharged Resident medication context',async()=>{
  await center();
  assert.equal((await request('/api/residents/R-1/medications/current?centerId=C-OTHER',{method:'PUT',user:'U-CENTER',body:{items:[{name:'Forged'}]}})).response.status,403);
  await db.Residents.update((item)=>item.resident_id==='R-1',{status:'discharged'});
  assert.equal((await request('/api/residents/R-1/medications/current?centerId=C-1',{method:'PUT',user:'U-CENTER',body:{items:[{name:'After discharge'}]}})).response.status,404);
  assert.equal((await db.MedicationSnapshots.findAll()).length,0);
});

test('one Family image may produce multiple review drafts without saving clinical state',async()=>{
  await family();
  aiProvider.queueMockResponse({medications:[
    {name:'Amlodipine',strength:'10 mg',dose:'1',unit:'เม็ด',uncertainFields:[]},
    {name:'Metformin',dose:'1',unit:'เม็ด',timing:'ก่อนนอน',uncertainFields:['timing'],providerSecret:'hidden'},
  ]});
  const result=await request('/api/care-profile/CP-1/medications/image-proposal',{method:'POST',body:{imageBase64:VALID_JPEG_BASE64,imageMimeType:'image/jpeg'}});
  assert.equal(result.response.status,202);
  assert.equal(result.body.status,'draft_requires_confirmation');
  assert.deepEqual(result.body.extracted.map((item)=>item.name),['Amlodipine','Metformin']);
  assert.deepEqual(result.body.extractionReview[1],{extractedIndex:1,state:'review',uncertainFields:['timing']});
  assert.doesNotMatch(JSON.stringify(result.body),/hidden|providerSecret|aW1hZ2U/);
  assert.equal((await db.MedicationSnapshots.findAll()).length,0);
  assert.equal((await db.Medications.findAll()).length,0);
});

test('Family image provider failure returns safe extraction-unavailable response without raw details',async()=>{
  await family();
  aiProvider.setProviderForTests({generateStructured:async()=>{throw new AIProviderError(AI_ERROR_CODES.AI_RATE_LIMIT,'private provider response')}});
  const result=await request('/api/care-profile/CP-1/medications/image-proposal',{method:'POST',body:{imageBase64:VALID_JPEG_BASE64,imageMimeType:'image/jpeg'}});
  assert.equal(result.response.status,503);
  assert.equal(result.body.error,'MEDICATION_EXTRACTION_UNAVAILABLE');
  assert.match(result.body.message,/ระบบอ่านฉลากยาชั่วคราวไม่ได้/);
  assert.doesNotMatch(JSON.stringify(result.body),/AI_RATE_LIMIT|private|aW1hZ2U/);
  assert.equal((await db.MedicationSnapshots.findAll()).length,0);
});

test('invalid AI response and valid empty extraction remain distinct safe outcomes',async()=>{
  await family();
  aiProvider.setProviderForTests({generateStructured:async()=>({medications:'invalid',raw:'private provider response'})});
  let result=await request('/api/care-profile/CP-1/medications/image-proposal',{method:'POST',body:{imageBase64:VALID_JPEG_BASE64,imageMimeType:'image/jpeg'}});
  assert.equal(result.response.status,503);
  assert.equal(result.body.error,'MEDICATION_EXTRACTION_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result.body),/private|raw|aW1hZ2U/);
  aiProvider.setProviderForTests({generateStructured:async()=>({medications:[]})});
  result=await request('/api/care-profile/CP-1/medications/image-proposal',{method:'POST',body:{imageBase64:VALID_JPEG_BASE64,imageMimeType:'image/jpeg'}});
  assert.equal(result.response.status,202);
  assert.equal(result.body.imageStatus,'no_medication_detected');
  assert.deepEqual(result.body.extracted,[]);
  assert.match(result.body.message,/ไม่พบรายการยาที่อ่านได้จากรูปนี้/);
  assert.equal((await db.MedicationSnapshots.findAll()).length,0);
});

test('combined image drafts are compared authoritatively and duplicate candidates require review',async()=>{
  await family();
  const result=await request('/api/care-profile/CP-1/medications/draft-proposal',{method:'POST',body:{items:[{name:'Aspirin',strength:'81 mg'},{name:' aspirin ',strength:'325 mg'}]}});
  assert.equal(result.response.status,202);
  assert.ok(result.body.proposals.some((item)=>item.ambiguous));
  assert.equal((await db.MedicationSnapshots.findAll()).length,0);
});

test('Center image and combined draft proposal retain Manager authorization and Staff denial',async()=>{
  await center();
  await db.CenterStaff.insert({staff_id:'S-MANAGER',center_id:'C-1',line_user_id:'U-MANAGER',role:'manager',status:'active'});
  aiProvider.queueMockResponse({medications:[{name:'Calcium',amount:'30',unit:'เม็ด',uncertainFields:[]}]});
  const manager=await request('/api/residents/R-1/medications/image-proposal?centerId=C-1',{method:'POST',user:'U-MANAGER',body:{imageBase64:VALID_JPEG_BASE64,imageMimeType:'image/jpeg'}});
  assert.equal(manager.response.status,202);
  assert.equal(manager.body.extracted[0].amount,'30');
  const staff=await request('/api/residents/R-1/medications/draft-proposal?centerId=C-1',{method:'POST',user:'U-STAFF',body:{items:[{name:'Forged'}]}});
  assert.equal(staff.response.status,403);
  assert.equal((await db.MedicationSnapshots.findAll()).length,0);
});
