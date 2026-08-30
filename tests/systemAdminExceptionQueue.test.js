process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createAdminExceptionService,normalizeQuery,syntheticRows}=require('../backend/services/adminExceptionService');
const ui=require('../liff-app/system-admin/exception-queue-ui');

const html=fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','index.html'),'utf8');
const source=fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','exception-queue-ui.js'),'utf8');
const css=fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','exception-queue-ui.css'),'utf8');

test('exception query is bounded, supports safe filters and rejects unrecognized values by normalization',()=>{
  assert.deepEqual(normalizeQuery({category:'groups',status:'open',search:'  ศูนย์  ',page:2,pageSize:500}),{category:'groups',status:'open',search:'ศูนย์',page:2,pageSize:50,offset:50});
  assert.equal(normalizeQuery({category:'clinical_payload',status:'sql'}).category,'all');
  assert.equal(normalizeQuery({category:'clinical_payload',status:'sql'}).status,'all');
  const request=ui.buildRequest({category:'pending_mapping',status:'pending',search:'ระบบ เอ',page:3,pageSize:20});
  assert.match(request.path,/\/api\/admin\/exceptions\?/);assert.match(request.path,/category=pending_mapping/);assert.match(request.path,/page=3/);
});

test('unified exception service projects every persisted category without clinical, LINE, group or payload fields',async()=>{
  const rows=[
    ['dsr','pending','ขอสำเนาข้อมูล','ผู้ขอที่ยืนยันแล้ว','ศูนย์ A','คำขอ ••••0001','manage_dsr'],
    ['pending_mapping','pending','Vendor','ผู้พักจากระบบภายนอก ••••1001 รอการจับคู่แบบตรงตัว','ศูนย์ A','งาน ••••0002','open_pending_mapping'],
    ['group_missing','open','Vendor','ยังไม่พบ Family GroupBinding ที่ยืนยันแล้ว','ศูนย์ A','งาน ••••0003','open_group_reconciliation'],
    ['group_mismatch','open','Vendor','กลุ่ม LINE ที่คาดไว้ไม่ตรงกับ GroupBinding ที่ยืนยันแล้ว','ศูนย์ A','งาน ••••0004','open_group_reconciliation'],
    ['identity_ambiguity','open','Vendor','พบชื่อที่ตรงกันมากกว่าหนึ่งรายการใน 2 ศูนย์ที่เป็นไปได้',null,'รายการ ••••0005','open_identity_review'],
    ['integration_failure','rejected','Vendor','รหัสข้อผิดพลาดที่ปลอดภัย: INVALID_FINALIZED_RECORD','ศูนย์ A','งาน ••••0006','inspect_reliability'],
    ['retry_warning','retrying','Vendor','รหัสข้อผิดพลาดที่ปลอดภัย: TEMPORARY_PROCESSING_UNAVAILABLE','ศูนย์ A','งาน ••••0007','inspect_reliability'],
  ].map(([category,status,title,summary,center_name,safe_reference,action_kind])=>({category,status,title,summary,center_name,safe_reference,action_kind,occurred_at:'2026-08-31T00:00:00Z'}));
  const calls=[];
  const service=createAdminExceptionService({
    queryFn:async(sql,params)=>{calls.push({sql,params});return sql.includes('COUNT(*)')?{rows:[{total:rows.length}]}:{rows};},
    notificationService:{async getHealth(){return{deadLetters:2}}},
    schedulerHealth:()=>({jobs:{notificationRetry:{status:'failed',safeErrorCode:'SCHEDULER_RUN_FAILED'}}}),
  });
  const result=await service.listExceptions({page:1,pageSize:20});
  assert.deepEqual(new Set(result.items.map((item)=>item.category)),new Set(['dsr','pending_mapping','group_missing','group_mismatch','identity_ambiguity','integration_failure','retry_warning','scheduler_warning']));
  assert.equal(result.pagination.total,9);assert.equal(calls.length,2);assert.ok(result.items.every((item)=>item.action?.label));
  assert.doesNotMatch(JSON.stringify(result),/canonical_payload|observations|care_items|line_user|group_id|G-SECRET|Bearer|credential/i);
});

test('notification and scheduler warning rows contain safe aggregate metadata only',()=>{
  const rows=syntheticRows({notificationHealth:{deadLetters:3},scheduler:{jobs:{jobA:{status:'failed',safeErrorCode:'SAFE_FAILURE',providerPayload:'secret'}}}});
  assert.equal(rows.length,2);assert.match(rows[0].summary,/3/);assert.match(rows[1].summary,/SAFE_FAILURE/);
  assert.doesNotMatch(JSON.stringify(rows),/providerPayload|secret/);
});

test('System Admin review is one lazy exception destination with safe supported actions and dashboard filters',()=>{
  for(const label of ['คำขอข้อมูลส่วนบุคคล','ผู้พักรอเชื่อม','กลุ่ม LINE','ชื่อซ้ำ / จับคู่ไม่ได้','Integration ล้มเหลว','Retry / dead-letter','Scheduler'])assert.match(html,new RegExp(label));
  for(const kind of ['manage_dsr','open_pending_mapping','open_group_reconciliation','open_identity_review','inspect_reliability'])assert.match(html+source,new RegExp(kind));
  assert.match(html,/data-exception-category/);assert.match(html,/pendingExceptionCategory/);
  assert.doesNotMatch(html+source,/send anyway|ส่งต่อไปเลย|raw payload|canonical_payload|localStorage|sessionStorage/i);
  assert.match(source,/requestSequence/);assert.match(source,/sequence!==state\.requestSequence/);
});

test('exception queue is mobile and desktop safe with 44px controls and non-color status text',()=>{
  assert.match(css,/min-height:44px/);assert.match(css,/@media\(max-width:600px\)/);assert.match(css,/@media\(min-width:900px\)/);
  assert.match(css,/overflow-wrap:anywhere/);assert.match(css,/var\(--phimor-mobile-nav-height/);
  assert.match(source,/STATUS_LABELS/);assert.match(source,/aria-pressed/);
});
