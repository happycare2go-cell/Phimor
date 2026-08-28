process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const dialog=require('../liff-app/shared/clinical-action-dialog');

const root=path.resolve(__dirname,'..');
const familyHtml=fs.readFileSync(path.join(root,'liff-app','family','index.html'),'utf8');
const centerHtml=fs.readFileSync(path.join(root,'liff-app','center-admin','index.html'),'utf8');
const adminHtml=fs.readFileSync(path.join(root,'liff-app','system-admin','index.html'),'utf8');
const css=fs.readFileSync(path.join(root,'liff-app','shared','clinical-action-dialog.css'),'utf8');

class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.attributes={};this.hidden=false;this.disabled=false;this.value='';this.textContent='';this.className='';}
  appendChild(child){this.children.push(child);return child;}
  append(...children){children.forEach((child)=>this.appendChild(child));}
  setAttribute(name,value){this.attributes[name]=String(value);}
  addEventListener(name,handler){this.listeners[name]=handler;}
  focus(){this.focused=true;}
}
function fakeDocument(){const body=new Element('body');return{body,activeElement:null,createElement:(tag)=>new Element(tag)};}

test('shared reason dialog rejects whitespace and prevents duplicate submit while busy',async()=>{
  const doc=fakeDocument();const instance=dialog.createDialog({doc});let calls=0;let release;
  const pending=instance.open({title:'ยกเลิกรายการ',confirmLabel:'ยืนยันยกเลิกรายการ',onConfirm:async()=>{calls+=1;return new Promise((resolve)=>{release=resolve;});}});
  instance.elements.reason.value='   ';await instance.elements.confirm.listeners.click();
  assert.equal(calls,0);assert.match(instance.elements.error.textContent,/กรุณาระบุเหตุผล/);
  instance.elements.reason.value='เหตุผลที่ตรวจสอบแล้ว';
  const first=instance.elements.confirm.listeners.click();const second=instance.elements.confirm.listeners.click();
  assert.equal(calls,1);release({ok:true});await Promise.all([first,second]);assert.deepEqual(await pending,{ok:true});
  assert.equal(instance.isOpen(),false);assert.equal(instance.elements.confirm.disabled,false);
});

test('shared dialog projects safe Thai errors without raw internals',()=>{
  assert.equal(dialog.safeError({errorCode:'ACCESS_DENIED'}),'คุณไม่มีสิทธิ์แก้ไขรายการนี้');
  assert.match(dialog.safeError({errorCode:'EXTERNAL_RECORD_LOCAL_MUTATION_DENIED'}),/ระบบที่เชื่อมต่อ/);
  assert.equal(dialog.safeError({errorCode:'SELECT_SECRET',message:'SQL line_user_id'}),'ดำเนินการไม่สำเร็จ กรุณาลองอีกครั้ง');
});

test('mobile correction dialog stays above non-interactive toast and has accessible touch targets',()=>{
  assert.match(css,/z-index:520/);assert.match(css,/min-height:46px/);assert.match(css,/safe-area-inset-bottom/);
  assert.match(css,/focus-visible/);assert.match(familyHtml,/\.toast\{[^}]*z-index:99;pointer-events:none/);
  assert.match(centerHtml,/\.toast\{[^}]*pointer-events:none;z-index:99/);
  assert.match(familyHtml,/shared\/clinical-action-dialog\.js/);assert.match(centerHtml,/shared\/clinical-action-dialog\.js/);
});

test('System Admin has no clinical correction or void controls',()=>{
  assert.doesNotMatch(adminHtml,/สร้างฉบับแก้ไข|ยกเลิกผลตรวจ|ยกเลิกสัญญาณชีพ|ยกเลิกรายงานการดูแล/);
});
