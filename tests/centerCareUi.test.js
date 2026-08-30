process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../liff-app/center-admin/care-recording-ui');

const uiSource = fs.readFileSync(path.join(__dirname, '..', 'liff-app', 'center-admin', 'care-recording-ui.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'liff-app', 'center-admin', 'index.html'), 'utf8');

test('Center vital form creates controlled observation types including glucose context and weight without interpretation', () => {
  assert.deepEqual(ui.buildVitalObservations({ temperature:'36.8', systolic:'120', diastolic:'70', pulse:'64', spo2:'98', respiratoryRate:'16',bloodGlucose:'108',glucoseContext:'fasting',weight:'54.2' }), [
    { measurementType:'temperature', numericValue:36.8, sourceUnit:'Cel', sourceValueText:'36.8' },
    { measurementType:'blood_pressure_systolic', numericValue:120, sourceUnit:'mm[Hg]', sourceValueText:'120' },
    { measurementType:'blood_pressure_diastolic', numericValue:70, sourceUnit:'mm[Hg]', sourceValueText:'70' },
    { measurementType:'pulse', numericValue:64, sourceUnit:'/min', sourceValueText:'64' },
    { measurementType:'spo2', numericValue:98, sourceUnit:'%', sourceValueText:'98' },
    { measurementType:'respiratory_rate', numericValue:16, sourceUnit:'/min', sourceValueText:'16' },
    { measurementType:'blood_glucose', numericValue:108, sourceUnit:'mg/dL', sourceValueText:'108', context:'fasting' },
    { measurementType:'weight', numericValue:54.2, sourceUnit:'kg', sourceValueText:'54.2' },
  ]);
  assert.throws(() => ui.buildVitalObservations({}), /อย่างน้อย 1 รายการ/);
  assert.doesNotMatch(uiSource, /ดีขึ้น|แย่ลง|อันตราย|วินิจฉัยว่า/);
});

test('Center daily form preserves normalized shift plus source label, factual text, intake and bowel count', () => {
  assert.deepEqual(ui.buildShift({shift:'day'}),{code:'day',sourceLabel:'กลางวัน'});
  assert.deepEqual(ui.buildDailyItems({ shift:'day', fluid:'850', bowelCount:'1', nutrition:'รับประทานอาหารได้ครึ่งจาน', mood:'พูดคุยตามปกติ' }), [
    { itemType:'shift', valueType:'text', textValue:'กลางวัน', sourceValueText:'กลางวัน' },
    { itemType:'fluid_intake', valueType:'numeric', numericValue:850, sourceUnit:'mL', sourceValueText:'850' },
    { itemType:'bowel_movement', valueType:'numeric', numericValue:1, sourceUnit:'times', sourceValueText:'1' },
    { itemType:'nutrition', valueType:'text', textValue:'รับประทานอาหารได้ครึ่งจาน', sourceValueText:'รับประทานอาหารได้ครึ่งจาน' },
    { itemType:'mood_behavior', valueType:'text', textValue:'พูดคุยตามปกติ', sourceValueText:'พูดคุยตามปกติ' },
  ]);
  assert.throws(() => ui.buildDailyItems({}), /อย่างน้อย 1 รายการ/);
  assert.equal(ui.buildOptionalDailyVitals({ occurredAt:'2026-08-27T09:30:00+07:00' }), null);
  assert.deepEqual(ui.buildOptionalDailyVitals({ occurredAt:'2026-08-27T09:30:00+07:00', dailyPulse:'72' }).observations[0],
    { measurementType:'pulse', numericValue:72, sourceUnit:'/min', sourceValueText:'72' });
});

test('controller follows authoritative capabilities and canonical Center routes', async () => {
  const calls = [];
  const controller = ui.createController({ api:async (route, options) => { calls.push({ route, body:JSON.parse(options.body) }); return { item:{} }; } });
  controller.configure({ centerId:'CTR 1', residents:[{ resident_id:'RES/1', full_name:'ผู้พัก' }], capabilities:{ vital_signs_v1:true, daily_care_v1:false } });
  await controller.submitVital({ residentId:'RES/1', occurredAt:'2026-08-27T09:30:00+07:00', temperature:'37.1' });
  assert.equal(calls[0].route, '/api/center/CTR%201/residents/RES%2F1/vital-signs');
  assert.deepEqual(calls[0].body.observations[0], { measurementType:'temperature', numericValue:37.1, sourceUnit:'Cel', sourceValueText:'37.1' });
  await assert.rejects(() => controller.submitDaily({ residentId:'RES/1', occurredAt:'2026-08-27T09:30:00+07:00', nutrition:'ปกติ' }), /ยังไม่ได้เปิดใช้/);
});

test('daily submit carries shift, bowel count and optional linked vitals into submitted workflow', async () => {
  let call;
  const controller=ui.createController({api:async(route,options)=>{call={route,body:JSON.parse(options.body)};return{item:{}};}});
  controller.configure({centerId:'CTR-A',role:'staff',residents:[{resident_id:'RES-A',full_name:'A'}],capabilities:{daily_care_v1:true,vital_signs_v1:true}});
  await controller.submitDaily({residentId:'RES-A',occurredAt:'2026-08-27T09:30:00+07:00',shift:'day',bowelCount:'2',nutrition:'ทานได้',dailySpo2:'98'});
  assert.equal(call.route,'/api/center/CTR-A/residents/RES-A/daily-care');
  assert.deepEqual(call.body.items.map((item)=>item.itemType),['shift','bowel_movement','nutrition']);
  assert.deepEqual(call.body.shift,{code:'day',sourceLabel:'กลางวัน'});assert.equal(call.body.careDate,'2026-08-27');
  assert.equal(call.body.vitalSigns.observations[0].measurementType,'spo2');
});

test('Manager review controller loads, returns and finalizes through authoritative Center routes',async()=>{
  const calls=[];const controller=ui.createController({api:async(route,options={})=>{calls.push({route,options});return{items:[]};}});
  controller.configure({centerId:'CTR-A',role:'manager',residents:[],capabilities:{daily_care_v1:true}});
  await controller.listDailyWorkflow('submitted');await controller.returnDaily('DCR-1','แก้ไขข้อมูลอาหาร');await controller.finalizeDaily('DCR-2');
  assert.deepEqual(calls.map((call)=>call.route),['/api/center/CTR-A/daily-care/review?status=submitted','/api/center/CTR-A/daily-care/DCR-1/return','/api/center/CTR-A/daily-care/DCR-2/finalize']);
  const staff=ui.createController({api:async()=>({})});staff.configure({centerId:'CTR-A',role:'staff',residents:[],capabilities:{daily_care_v1:true}});
  assert.throws(()=>staff.finalizeDaily('DCR-1'),/เฉพาะเจ้าของหรือผู้จัดการ/);
});

test('Center correction controllers use existing scoped routes and enforce reason and role locally',async()=>{
  const calls=[];const controller=ui.createController({api:async(route,options={})=>{calls.push({route,options});return{items:[]};}});
  controller.configure({centerId:'CTR-A',role:'manager',residents:[{resident_id:'RES-A',care_profile_id:'CP-A',full_name:'A'}],capabilities:{daily_care_v1:true,vital_signs_v1:true}});
  await controller.listVitalHistory('RES-A');await controller.voidVital('VSET-1','ค่าผิด');
  await controller.createDailyCorrection('DCR-1','แก้ไข');await controller.voidDaily('DCR-2','ยกเลิก');
  await controller.listLabHistory('RES-A');await controller.createLabCorrection('RES-A','LABR-1','แก้ไข');await controller.voidLab('RES-A','LABR-2','ยกเลิก');
  assert.deepEqual(calls.map((call)=>call.route),[
    '/api/center/CTR-A/vital-signs/history?residentId=RES-A','/api/center/CTR-A/vital-signs/VSET-1/void',
    '/api/center/CTR-A/daily-care/DCR-1/corrections','/api/center/CTR-A/daily-care/DCR-2/void',
    '/api/care-profile/CP-A/lab-reports?includeHistory=true&limit=20&centerId=CTR-A',
    '/api/care-profile/CP-A/lab-reports/LABR-1/corrections?centerId=CTR-A',
    '/api/care-profile/CP-A/lab-reports/LABR-2/void?centerId=CTR-A',
  ]);
  const staff=ui.createController({api:async()=>({})});staff.configure({centerId:'CTR-A',role:'staff',residents:[{resident_id:'RES-A',care_profile_id:'CP-A'}],capabilities:{daily_care_v1:true,vital_signs_v1:true}});
  assert.throws(()=>staff.voidVital('VSET-1','x'),/เฉพาะเจ้าของหรือผู้จัดการ/);
  assert.throws(()=>staff.createDailyCorrection('DCR-1','x'),/เฉพาะเจ้าของหรือผู้จัดการ/);
  assert.throws(()=>staff.voidLab('RES-A','LABR-1','x'),/เฉพาะเจ้าของหรือผู้จัดการ/);
  assert.throws(()=>controller.voidVital('VSET-1','  '),/กรุณาระบุเหตุผล/);
});

test('Center correction response is discarded after Center switch and new Vital action never copies prior measurements',async()=>{
  let release;const controller=ui.createController({api:()=>new Promise((resolve)=>{release=resolve;})});
  controller.configure({centerId:'CTR-A',role:'manager',residents:[{resident_id:'RES-A',care_profile_id:'CP-A'}],capabilities:{vital_signs_v1:true,daily_care_v1:true}});
  const pending=controller.voidVital('VSET-1','ค่าผิด');
  controller.configure({centerId:'CTR-B',role:'manager',residents:[{resident_id:'RES-B',care_profile_id:'CP-B'}],capabilities:{vital_signs_v1:true,daily_care_v1:true}});
  release({item:{vitalSetId:'VSET-1',privateValue:'CENTER-A'}});
  assert.deepEqual(await pending,{stale:true});assert.equal(controller.snapshot().centerId,'CTR-B');
  assert.match(uiSource,/บันทึกค่าใหม่/);assert.match(uiSource,/vitalForm\.reset\(\)/);
  assert.doesNotMatch(uiSource,/prefillVital|copyVital|populateVital/);
});

test('finalization UX distinguishes queued notification from held or unavailable routing',()=>{
  assert.equal(ui.finalizationNotice({notification:{notificationStatus:'queued'}}),'ยืนยันรายงานแล้ว ระบบนำรายงานเข้าคิวแจ้งครอบครัว');
  assert.match(ui.finalizationNotice({notification:{notificationStatus:'recipient_missing'}}),/ยังไม่พบช่องทาง/);
  assert.match(ui.finalizationNotice({notification:{notificationStatus:'enqueue_failed'}}),/ยังไม่สำเร็จ/);
});

test('context switch invalidates an in-flight response and clears the previous resident', async () => {
  let release;
  const controller = ui.createController({ api:() => new Promise((resolve) => { release = resolve; }) });
  controller.configure({ centerId:'CTR-A', residents:[{resident_id:'RES-A',full_name:'A'}], capabilities:{vital_signs_v1:true} });
  const pending = controller.submitVital({residentId:'RES-A',occurredAt:'2026-08-27T09:30:00+07:00',pulse:'70'});
  controller.configure({ centerId:'CTR-B', residents:[{resident_id:'RES-B',full_name:'B'}], capabilities:{vital_signs_v1:true} });
  release({item:{}});
  assert.deepEqual(await pending, { stale:true });
  assert.equal(controller.snapshot().centerId, 'CTR-B');
  assert.deepEqual(controller.snapshot().residents.map((item) => item.residentId), ['RES-B']);
});

test('stale failure and double submit cannot overwrite the current Center state', async () => {
  let rejectRequest;
  const controller = ui.createController({ api:() => new Promise((_, reject) => { rejectRequest = reject; }) });
  controller.configure({ centerId:'CTR-A', residents:[{resident_id:'RES-A',full_name:'A'}], capabilities:{daily_care_v1:true} });
  const first = controller.submitDaily({residentId:'RES-A',occurredAt:'2026-08-27T09:30:00+07:00',nutrition:'รับประทานอาหาร'});
  await assert.rejects(() => controller.submitDaily({residentId:'RES-A',occurredAt:'2026-08-27T09:31:00+07:00',nutrition:'ซ้ำ'}), /กำลังบันทึก/);
  controller.configure({ centerId:'CTR-B', residents:[{resident_id:'RES-B',full_name:'B'}], capabilities:{daily_care_v1:true} });
  rejectRequest(new Error('old request failed'));
  assert.deepEqual(await first, { stale:true });
  assert.equal(controller.snapshot().centerId, 'CTR-B');
});

test('Center LIFF mounts capability-gated mobile forms without browser persistence', () => {
  assert.match(htmlSource, /data-shell-destination="record"/);
  assert.match(htmlSource, /data-shell-panel="record"/);
  assert.match(htmlSource, /api\/center\/\$\{encodeURIComponent\(requestedCenterId\)\}\/capabilities/);
  assert.match(htmlSource, /centerCareUi\.clear\(\)/);
  assert.match(htmlSource, /centerCareUi\.setMode\('record'\)/);
  assert.match(uiSource, /aria-live="polite"/);
  assert.match(uiSource, /รายงานรอตรวจ/);assert.match(uiSource,/ยืนยันและส่งครอบครัว/);
  assert.match(uiSource, /inputmode="decimal"/);
  assert.doesNotMatch(uiSource, /localStorage|sessionStorage|location\.(?:search|hash)/);
  assert.doesNotMatch(uiSource, /lineUserId|LINE_USER_ID|phone|emergency/i);
  assert.match(uiSource,/ข้อมูลจากระบบศูนย์/);assert.match(uiSource,/mutationCapabilities/);
});
