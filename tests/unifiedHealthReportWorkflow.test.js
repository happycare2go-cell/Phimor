process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {validateNativeHealthReportBody}=require('../backend/routes/dailyCare');
const {validateNativeHealthReportContent}=require('../backend/services/dailyCareService');
const {normalizeObservations}=require('../backend/domain/vitalSigns');
const centerUi=require('../liff-app/center-admin/care-recording-ui');

const root=path.resolve(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');
const centerHtml=read('liff-app/center-admin/index.html');
const centerUiSource=read('liff-app/center-admin/care-recording-ui.js');
const centerCss=read('liff-app/center-admin/care-recording-ui.css');
const shellCss=read('liff-app/shared/app-shell.css');
const familyHtml=read('liff-app/family/index.html');
const familyUiSource=read('liff-app/family/care-history-ui.js');
const vitalRouteSource=read('backend/routes/vitalSigns.js');
const integrationSource=read('backend/services/integrationEventService.js');

const note={itemType:'symptom_note',valueType:'text',textValue:' พักผ่อนได้ '};
const pulse={measurementType:'pulse',numericValue:72,sourceUnit:'/min'};

test('new native body accepts note-only, Vital-only, or both and rejects an empty report',()=>{
  assert.equal(validateNativeHealthReportBody({occurredAt:'2026-08-30T01:00:00Z',items:[note]}).items.length,1);
  assert.equal(validateNativeHealthReportBody({occurredAt:'2026-08-30T01:00:00Z',items:[],vitalSigns:{observations:[pulse]}}).vitalSigns.observations.length,1);
  assert.doesNotThrow(()=>validateNativeHealthReportBody({occurredAt:'2026-08-30T01:00:00Z',items:[note],vitalSigns:{observations:[pulse]}}));
  assert.throws(()=>validateNativeHealthReportBody({occurredAt:'2026-08-30T01:00:00Z',items:[]}),{code:'HEALTH_REPORT_CONTENT_REQUIRED'});
  assert.throws(()=>validateNativeHealthReportBody(null),{code:'INVALID_HEALTH_REPORT_BODY'});
});

test('new native body rejects arbitrary subject identity and legacy structured fields',()=>{
  assert.throws(()=>validateNativeHealthReportBody({occurredAt:'2026-08-30T01:00:00Z',careProfileId:'CP-ATTACK',items:[note]}),{code:'UNKNOWN_HEALTH_REPORT_FIELD'});
  assert.throws(()=>validateNativeHealthReportBody({occurredAt:'2026-08-30T01:00:00Z',items:[{itemType:'nutrition',valueType:'text',textValue:'x'}]}),{code:'UNSUPPORTED_NATIVE_HEALTH_REPORT_ITEM'});
  assert.throws(()=>validateNativeHealthReportBody({occurredAt:'2026-08-30T01:00:00Z',items:[],vitalSigns:{observations:[{measurementType:'weight',numericValue:50,sourceUnit:'kg'}]}}),{code:'UNSUPPORTED_NATIVE_HEALTH_REPORT_VITAL'});
  assert.throws(()=>validateNativeHealthReportBody({occurredAt:'2026-08-30T01:00:00Z',items:[{...note,html:'<b>hidden</b>'}]}),{code:'UNKNOWN_HEALTH_REPORT_ITEM_FIELD'});
  assert.throws(()=>validateNativeHealthReportBody({occurredAt:'2026-08-30T01:00:00Z',items:[],vitalSigns:{observations:[{...pulse,diagnosis:'normal'}]}}),{code:'UNSUPPORTED_NATIVE_HEALTH_REPORT_VITAL'});
});

test('service-level defense mirrors the simplified Health Report contract',()=>{
  assert.deepEqual(validateNativeHealthReportContent([note],null).vitalSigns,null);
  assert.equal(validateNativeHealthReportContent([],{observations:[pulse]}).items.length,0);
  assert.throws(()=>validateNativeHealthReportContent([],null),{code:'HEALTH_REPORT_CONTENT_REQUIRED'});
  assert.throws(()=>validateNativeHealthReportContent([{itemType:'sleep_rest'}],null),{code:'UNSUPPORTED_NATIVE_HEALTH_REPORT_ITEM'});
});

test('canonical Vital normalization retains strict numeric and unit validation',()=>{
  assert.equal(normalizeObservations([pulse])[0].canonicalUnit,'/min');
  assert.throws(()=>normalizeObservations([{measurementType:'temperature',numericValue:'not-a-number',sourceUnit:'Cel'}]),{code:'INVALID_NUMERIC_VALUE'});
  assert.throws(()=>normalizeObservations([{measurementType:'blood_pressure_systolic',numericValue:120,sourceUnit:'%'}]),{code:'UNSUPPORTED_UNIT'});
  assert.throws(()=>normalizeObservations([{measurementType:'spo2',numericValue:98,sourceUnit:'bpm'}]),{code:'UNSUPPORTED_UNIT'});
});

test('Center primary navigation exposes one Health Report recording action',()=>{
  assert.equal((centerHtml.match(/id="recordHealthAction"/g)||[]).length,1);
  assert.doesNotMatch(centerHtml,/id="recordVitalAction"|id="recordDailyAction"/);
  assert.match(centerHtml,/<strong>รายงานสุขภาพ<\/strong>/);
  assert.match(centerHtml,/ยืนยันและส่งให้ครอบครัว|รายงานสุขภาพรอตรวจ \/ ส่งกลับ/);
});

test('new Health Report form has five optional Vitals, one note, and no visible structured care fields',()=>{
  const start=centerUiSource.indexOf('<form id="centerDailyForm"');
  const end=centerUiSource.indexOf('</form>',start);
  const form=centerUiSource.slice(start,end);
  for(const field of ['dailyTemperature','dailySystolic','dailyDiastolic','dailyPulse','dailySpo2','symptomNote'])assert.match(form,new RegExp(`name="${field}"`));
  assert.match(form,/data-legacy-daily-fields hidden/);
  assert.match(form,/เลือกผู้พัก \/ Care Profile/);
  assert.match(form,/อาการ \/ รายงานทั่วไปเพิ่มเติม/);
});

test('UI builder trims one free-text note and keeps omitted observations omitted',()=>{
  assert.deepEqual(centerUi.buildHealthReportItems({symptomNote:'  พูดคุยตามปกติ  '}),[{itemType:'symptom_note',valueType:'text',textValue:'พูดคุยตามปกติ',sourceValueText:'พูดคุยตามปกติ'}]);
  assert.deepEqual(centerUi.buildHealthReportItems({symptomNote:'   '}),[]);
  const built=centerUi.buildOptionalDailyVitals({occurredAt:'2026-08-30T10:00',dailyPulse:'72'});
  assert.deepEqual(built.observations.map((item)=>item.measurementType),['pulse']);
});

test('legacy Vital route is an explicit review-gate transition and external integration path is untouched',()=>{
  assert.match(vitalRouteSource,/NATIVE_HEALTH_REPORT_REQUIRED/);
  assert.match(vitalRouteSource,/res\.status\(409\)/);
  assert.match(integrationSource,/care\.vitals\.recorded/);
  assert.match(integrationSource,/care\.daily_report\.finalized/);
});

test('legacy deep links converge on the unified recording destination',()=>{
  assert.match(centerHtml,/care:'record',vital:'record',vitals:'record',daily:'record','daily-care':'record','health-report':'record'/);
  assert.match(centerHtml,/function openRecordingForm\(\)\{[^}]*centerDailyForm/);
});

test('mobile shell gives the actual Center content and nested care surface nav clearance',()=>{
  assert.match(shellCss,/--phimor-mobile-nav-clearance:\s*calc\(var\(--phimor-mobile-nav-height\).*\+ 24px\)/);
  assert.match(shellCss,/\.phimor-shell\s*\{[^}]*min-height:\s*100dvh/s);
  assert.match(centerHtml,/\.center-shell-content\{[^}]*padding:[^}]*var\(--phimor-mobile-nav-clearance\)[^}]*scroll-padding-bottom:var\(--phimor-mobile-nav-clearance\)/s);
  assert.match(centerCss,/\.center-care\{[^}]*scroll-padding-bottom:var\(--phimor-mobile-nav-clearance/s);
});

test('modal and touch controls retain independent safe-area and 44px clearance',()=>{
  assert.match(centerHtml,/\.modal\{[^}]*safe-area-inset-bottom[^}]*scroll-padding-bottom/s);
  assert.match(centerCss,/center-care__submit[^}]*min-height:46px/);
  assert.match(centerCss,/center-care__review-actions \.btn[^}]*min-height:46px/);
  assert.match(centerCss,/center-care input,\.center-care select,\.center-care textarea\{min-width:0\}/);
});

test('Family presentation leads with one Health Report and filters its linked Vital from the overview duplicate',()=>{
  assert.match(familyHtml,/รายงานสุขภาพล่าสุด/);
  assert.match(familyHtml,/ประวัติสัญญาณชีพเดิม/);
  assert.match(familyUiSource,/state\.vitals\.find\(\(item\) => !item\.linkedDailyReportId\)/);
  assert.match(familyUiSource,/อาการ \/ รายงานทั่วไป/);
  assert.match(familyUiSource,/sourceLabel\(report\.sourceType\)/);
});

test('ordinary presentation does not expose internal identity or external integration identifiers',()=>{
  const presentation=`${centerUiSource}\n${familyUiSource}`;
  assert.doesNotMatch(presentation,/externalStaffId|integrationClientId|lineGroupId/);
  assert.doesNotMatch(familyHtml,/Care Profile ID|Resident ID|Integration Client ID|Group ID/);
});

test('no schema migration 0017 is introduced for the unified workflow',()=>{
  const migrationNames=fs.readdirSync(path.join(root,'backend','migrations')).filter((name)=>/^\d{4}_.+\.js$/.test(name)).sort();
  assert.equal(migrationNames.at(-1),'0016_add_center_family_linking_integrity.js');
  assert.equal(migrationNames.some((name)=>name.startsWith('0017_')),false);
});
