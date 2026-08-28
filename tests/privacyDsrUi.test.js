const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const familyUI = require('../liff-app/family/privacy-ui');
const adminUI = require('../liff-app/system-admin/privacy-operations-ui');
const familyHtml = fs.readFileSync(path.resolve(__dirname,'..','liff-app','family','index.html'),'utf8');
const familySource = fs.readFileSync(path.resolve(__dirname,'..','liff-app','family','privacy-ui.js'),'utf8');
const familyCss = fs.readFileSync(path.resolve(__dirname,'..','liff-app','family','privacy-ui.css'),'utf8');
const adminHtml = fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','index.html'),'utf8');
const adminSource = fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','privacy-operations-ui.js'),'utf8');
const centerHtml = fs.readFileSync(path.resolve(__dirname,'..','liff-app','center-admin','index.html'),'utf8');

function deferred(){let resolve;const promise=new Promise((done)=>{resolve=done;});return{promise,resolve};}

test('Family Privacy navigation, consent consequences, confirmation and re-consent are explicit', () => {
  assert.match(familyHtml, /data-family-destination="privacy"/); assert.match(familyHtml, /id="view-privacy"/);
  assert.match(familyHtml, /ถอนความยินยอม/); assert.match(familyHtml, /จัดการความเป็นส่วนตัว/);
  assert.match(familySource, /ข้อมูลเดิมไม่ได้ถูกลบอัตโนมัติ/); assert.match(familySource, /confirmAction\('ถอนความยินยอม'/);
  assert.match(familySource, /ให้ความยินยอมอีกครั้ง/); assert.match(familyHtml, /openPrivacyWithoutConsent/);
});

test('Family request types and status labels map only implemented backend enums to plain Thai', () => {
  assert.deepEqual(Object.keys(familyUI.TYPE_LABELS).sort(), ['correct','delete','export','restrict']);
  assert.deepEqual(Object.keys(familyUI.STATUS_LABELS).sort(), ['completed','in_progress','pending','rejected']);
  assert.equal(familyUI.TYPE_LABELS.export,'ขอสำเนาข้อมูล'); assert.equal(familyUI.STATUS_LABELS.pending[0],'รับคำขอแล้ว');
  assert.match(familyUI.STATUS_LABELS.completed[1],/ไม่หมายความ.*ลบ.*อัตโนมัติ/);
  assert.doesNotMatch(familyHtml,/\bDSR\b/);
});

test('profile switch clears Privacy state immediately and stale response cannot restore it', async () => {
  const consent=deferred(),requests=deferred();let call=0;
  const session=familyUI.createSession({request:()=>call++===0?consent.promise:requests.promise});
  session.setContext('CP-A');const pending=session.open();session.setContext('CP-B');
  assert.equal(session.snapshot().consent,null);assert.deepEqual(session.snapshot().requests,[]);
  consent.resolve({hasConsent:true,status:'active'});requests.resolve({requests:[{requestReference:'A',type:'export',status:'pending'}]});await pending;
  assert.equal(session.snapshot().contextId,'CP-B');assert.equal(session.snapshot().consent,null);assert.deepEqual(session.snapshot().requests,[]);
});

test('duplicate submit remains safe and browser stores no DSR or clinical state', async () => {
  const calls=[];const session=familyUI.createSession({request:async(pathValue)=>{calls.push(pathValue);if(pathValue==='/api/data-requests')return calls.length===1?{duplicate:true,request:{requestReference:'คำขอ ••••1'}}:{requests:[]};return{};}});
  const result=await session.submit({type:'export',note:'ข้อมูลขั้นต่ำ'});assert.equal(result.duplicate,true);assert.equal(session.snapshot().lastResult,'duplicate_request');
  assert.doesNotMatch(familySource,/localStorage|sessionStorage|history\.pushState|location\.(?:hash|search)/);
});

test('Family, Center and Admin UI sources use safe identity projections rather than rendering raw LINE IDs', () => {
  assert.match(familyHtml,/m\.displayIdentity/); assert.match(centerHtml,/s\.display_identity/); assert.match(adminHtml,/ownerIdentity/);
  assert.doesNotMatch(familyHtml,/ผู้ดูแลร่วม[^\n]*m\.line_user_id/); assert.doesNotMatch(centerHtml,/resident-name[^\n]*line_user_id/);
  assert.doesNotMatch(adminHtml,/owner_line_id|blood_type|chronic_conditions|drug_allergies|food_allergies/);
});

test('System Admin DSR UI is manual-status operations, not automated fulfillment', () => {
  assert.match(adminHtml,/คำขอเกี่ยวกับข้อมูลส่วนบุคคล/);assert.match(adminHtml,/ไม่ลบ ส่งออก แก้ไข หรือจำกัดข้อมูลอัตโนมัติ/);
  const descriptor=adminUI.buildStatusRequest('DSR 1',{status:'completed',publicNote:'ดำเนินการแล้ว',manualFulfillmentConfirmed:true});
  assert.equal(descriptor.path,'/api/admin/data-requests/DSR%201');assert.deepEqual(JSON.parse(descriptor.options.body),{status:'completed',publicNote:'ดำเนินการแล้ว',manualFulfillmentConfirmed:true});
  assert.doesNotMatch(adminSource,/clinical|blood|allerg|lineUserId|line_user_id/i);
});

test('Privacy UI is mobile accessible with large targets, focus and non-color status text', () => {
  assert.match(familyCss,/min-height:44px/);assert.match(familyCss,/focus-visible/);assert.match(familyCss,/@media\(max-width:390px\)/);assert.match(familyCss,/overflow-wrap:anywhere/);
  assert.match(familyHtml,/maxlength="500"/);assert.match(familyHtml,/aria-live="polite"/);assert.match(familyHtml,/role="status"/);
});
