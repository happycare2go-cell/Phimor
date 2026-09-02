process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createAdminExceptionService,normalizeQuery,projectRow,syntheticRows,LIST_SQL,COUNT_SQL,
  notificationKindLabel,notificationErrorLabel}=require('../backend/services/adminExceptionService');
const ui=require('../liff-app/system-admin/exception-queue-ui');

const html=fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','index.html'),'utf8');
const source=fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','exception-queue-ui.js'),'utf8');
const css=fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','exception-queue-ui.css'),'utf8');

function notificationRow({status='retrying',kind='family_daily_care_finalized',attempts=2,
  nextAttemptAt='2026-09-02T07:08:00Z',error='LINE_DELIVERY_FAILED'}={}) {
  const kindLabel=notificationKindLabel(kind);const retrying=status==='retrying';
  return {category:'retry_warning',status,title:`${kindLabel}${retrying?'ยังไม่สำเร็จ':'ส่งไม่สำเร็จ'}`,
    summary:retrying?`ส่งไม่สำเร็จ ${attempts} ครั้ง`:`ระบบลองส่งแล้ว ${attempts} ครั้ง แต่ยังไม่สำเร็จ`,center_name:null,
    safe_reference:'การแจ้งเตือน ••••0001',action_kind:'inspect_notification',occurred_at:'2026-09-02T07:00:00Z',
    details:{notificationKind:kind,notificationKindLabel:kindLabel,attempts,createdAt:'2026-09-02T06:00:00Z',
      statusUpdatedAt:'2026-09-02T07:00:00Z',nextAttemptAt:retrying?nextAttemptAt:null,sentAt:null,
      lastErrorCode:error,lastErrorMessage:notificationErrorLabel(error),recipientType:'family',
      maskedDestination:'C123…BCDE',resourceType:'daily_care',safeResourceReference:'รายการ ••••DCR1',
      providerAcceptance:null,providerRequestReference:null}};
}

test('exception query is bounded, supports safe server filters and rejects unrecognized values',()=>{
  assert.deepEqual(normalizeQuery({category:'groups',status:'open',search:'  ศูนย์  ',page:2,pageSize:500}),{category:'groups',status:'open',search:'ศูนย์',page:2,pageSize:50,offset:50});
  assert.equal(normalizeQuery({category:'clinical_payload',status:'sql'}).category,'all');
  assert.equal(normalizeQuery({category:'clinical_payload',status:'sql'}).status,'all');
  const request=ui.buildRequest({category:'retry_warning',status:'retrying',search:'รายงานสุขภาพ',page:3,pageSize:20});
  assert.match(request.path,/\/api\/admin\/exceptions\?/);assert.match(request.path,/category=retry_warning/);
  assert.match(request.path,/status=retrying/);assert.match(request.path,/page=3/);
  assert.match(COUNT_SQL,/\$1::text='all'/);assert.match(COUNT_SQL,/\$2::text='all'/);assert.match(COUNT_SQL,/LOWER\(\$3\)/);
});

test('notification exceptions are selected individually with indexed status filtering and no full-table JS load',()=>{
  assert.match(LIST_SQL,/FROM "notificationOutbox"/);
  assert.match(LIST_SQL,/data->>'status' IN \('retrying','dead_letter'\)/);
  assert.match(LIST_SQL,/LIMIT \$4 OFFSET \$5/);
  assert.match(LIST_SQL,/LEFT\(data->>'to',4\).*RIGHT\(data->>'to',4\)/s);
  assert.doesNotMatch(LIST_SQL,/data->>'messages'|SELECT data FROM "notificationOutbox"/);
  const notificationFilter=LIST_SQL.match(/FROM "notificationOutbox"\s+WHERE data->>'status' IN \([^)]+\)/)?.[0]||'';
  assert.doesNotMatch(notificationFilter,/sent|pending/);
});

test('one retrying and one dead-letter notification return real safe exception rows without aggregate duplication',async()=>{
  const rows=[notificationRow(),notificationRow({status:'dead',kind:'subscription_updated',attempts:5,nextAttemptAt:null,
    error:'LINE_RETRY_WINDOW_EXPIRED'})];const calls=[];
  const service=createAdminExceptionService({queryFn:async(sql,params)=>{calls.push({sql,params});
    return sql.includes('COUNT(*)')?{rows:[{total:2}]}:{rows};},schedulerHealth:()=>({jobs:{}})});
  const result=await service.listExceptions({category:'retry_warning',page:1,pageSize:20});
  assert.equal(result.pagination.total,2);assert.equal(result.items.length,2);assert.equal(calls.length,2);
  assert.deepEqual(result.items.map((item)=>item.status),['retrying','dead']);
  assert.deepEqual(result.items.map((item)=>item.action.kind),['inspect_notification','inspect_notification']);
  assert.equal(result.items[0].notification.attempts,2);assert.equal(result.items[0].notification.nextAttemptAt,'2026-09-02T07:08:00Z');
  assert.equal(result.items[1].notification.attempts,5);assert.equal(result.items[1].notification.nextAttemptAt,null);
  assert.doesNotMatch(JSON.stringify(result),/คิวแจ้งเตือน|สถานะคิวรวม|มีรายการหยุดรอตรวจ/);
});

test('notification projection masks LINE destination and excludes message body, tokens and raw recipient',()=>{
  const projected=projectRow(notificationRow());
  const serialized=JSON.stringify(projected);
  assert.equal(projected.notification.maskedDestination,'C123…BCDE');
  assert.doesNotMatch(serialized,/C1234567890ABCDE|message body|access token|credential|secret/i);
  const defensive=projectRow({...notificationRow(),details:{...notificationRow().details,
    maskedDestination:'C1234567890ABCDE',messageBody:'raw health payload',to:'C1234567890ABCDE'}});
  assert.equal(defensive.notification.maskedDestination,null);
  assert.doesNotMatch(JSON.stringify(defensive),/C1234567890ABCDE|raw health payload/);
});

test('unknown notification kind and error use safe human fallbacks while raw safe codes remain technical',()=>{
  assert.equal(notificationKindLabel('future_unknown_kind'),'การแจ้งเตือน');
  assert.equal(notificationErrorLabel('FUTURE_PROVIDER_ERROR'),'ส่งการแจ้งเตือนไม่สำเร็จ');
  const row=notificationRow({kind:'future_unknown_kind',error:'FUTURE_PROVIDER_ERROR'});
  row.details.notificationKindLabel='การแจ้งเตือน';row.details.lastErrorMessage='ส่งการแจ้งเตือนไม่สำเร็จ';
  const projected=projectRow(row);const card=ui.notificationCardModel(projected);
  assert.match(card.title,/การแจ้งเตือน/);assert.doesNotMatch(card.title,/future_unknown_kind|FUTURE_PROVIDER_ERROR/);
  const detail=ui.notificationDetailModel(projected);
  assert.match(JSON.stringify(detail.sections),/ส่งการแจ้งเตือนไม่สำเร็จ/);
  assert.match(JSON.stringify(detail.technical),/future_unknown_kind|FUTURE_PROVIDER_ERROR/);
});

test('persisted exception pagination remains bounded and scheduler warning remains synthetic only',async()=>{
  const calls=[];const service=createAdminExceptionService({queryFn:async(sql,params)=>{calls.push({sql,params});
    return sql.includes('COUNT(*)')?{rows:[{total:12}]}:{rows:[notificationRow()]};},
  schedulerHealth:()=>({jobs:{jobA:{status:'failed',safeErrorCode:'SAFE_FAILURE'}}})});
  const result=await service.listExceptions({page:2,pageSize:5,search:'แจ้งเตือน'});
  assert.deepEqual(calls[1].params,['all','all','แจ้งเตือน',5,5]);assert.equal(result.pagination.pageSize,5);
  assert.equal(result.pagination.total,12);assert.equal(result.items.length,1);
  const synthetic=syntheticRows({notificationHealth:{deadLetters:99},scheduler:{jobs:{jobA:{status:'failed',safeErrorCode:'SAFE_FAILURE',providerPayload:'secret'}}}});
  assert.equal(synthetic.length,1);assert.equal(synthetic[0].category,'scheduler_warning');
  assert.doesNotMatch(JSON.stringify(synthetic),/deadLetters|providerPayload|secret|คิวแจ้งเตือน/);
});

test('existing DSR, mapping, group and Integration exception projections remain compatible',async()=>{
  const rows=[
    ['dsr','pending','ขอสำเนาข้อมูล','ผู้ขอที่ยืนยันแล้ว','ศูนย์ A','คำขอ ••••0001','manage_dsr'],
    ['pending_mapping','pending','Vendor','ผู้พักรอเชื่อม','ศูนย์ A','งาน ••••0002','open_pending_mapping'],
    ['group_missing','open','Vendor','ยังไม่พบ Family GroupBinding','ศูนย์ A','งาน ••••0003','open_group_reconciliation'],
    ['group_mismatch','open','Vendor','กลุ่ม LINE ไม่ตรงกัน','ศูนย์ A','งาน ••••0004','open_group_reconciliation'],
    ['identity_ambiguity','open','Vendor','พบชื่อซ้ำ',null,'รายการ ••••0005','open_identity_review'],
    ['integration_failure','rejected','Vendor','การประมวลผลไม่สำเร็จ','ศูนย์ A','งาน ••••0006','inspect_reliability'],
  ].map(([category,status,title,summary,center_name,safe_reference,action_kind])=>({category,status,title,summary,
    center_name,safe_reference,action_kind,occurred_at:'2026-08-31T00:00:00Z',details:{}}));
  const service=createAdminExceptionService({queryFn:async(sql)=>sql.includes('COUNT(*)')?{rows:[{total:rows.length}]}:{rows},
    schedulerHealth:()=>({jobs:{}})});const result=await service.listExceptions();
  assert.equal(result.items.length,6);assert.ok(result.items.every((item)=>item.action?.label));
  assert.doesNotMatch(JSON.stringify(result),/canonical_payload|observations|care_items|line_user|group_id|Bearer|credential/i);
});

test('notification card and detail use human retry/dead states with no manual retry control',()=>{
  const retrying=projectRow(notificationRow());const card=ui.notificationCardModel(retrying,new Date('2026-09-02T06:30:00Z'));
  assert.equal(card.statusLabel,'กำลังลองส่งใหม่');assert.match(card.nextRetry,/จะลองอีกครั้ง/);
  assert.doesNotMatch(card.statusLabel,/retrying|dead_letter/i);
  const retryDetail=ui.notificationDetailModel(retrying);assert.match(JSON.stringify(retryDetail.sections),/ระบบยังลองส่งให้อัตโนมัติ ไม่ต้องสั่งส่งซ้ำ/);
  assert.match(JSON.stringify(retryDetail.sections),/C123…BCDE|2 ครั้ง|การส่งผ่าน LINE ไม่สำเร็จ/);
  const dead=projectRow(notificationRow({status:'dead',attempts:5,nextAttemptAt:null}));const deadCard=ui.notificationCardModel(dead);
  assert.equal(deadCard.statusLabel,'หยุดลองส่งแล้ว');assert.equal(deadCard.nextRetry,null);
  assert.match(JSON.stringify(ui.notificationDetailModel(dead).sections),/ระบบหยุดลองส่งอัตโนมัติแล้ว/);
  const detailText=JSON.stringify(ui.notificationDetailModel(dead).sections);
  assert.match(detailText,/อัปเดตสถานะล่าสุด/);assert.doesNotMatch(detailText,/ลองส่งล่าสุด|หยุดลองเมื่อ/);
  assert.match(JSON.stringify(ui.notificationDetailModel(retrying).sections),/จะลองอีกครั้ง/);
  assert.match(source,/exception-detail__technical/);assert.match(source,/details','exception-detail__technical/);
  assert.doesNotMatch(html+source,/>\s*(?:Retry|ลองส่งอีกครั้ง|ส่งซ้ำ)\s*</i);
});

test('System Admin queue has clear empty state and mobile-safe notification detail sheet',()=>{
  for(const label of ['คำขอข้อมูลส่วนบุคคล','ผู้พักรอเชื่อม','กลุ่ม LINE','ชื่อซ้ำ / จับคู่ไม่ได้','Integration ล้มเหลว','การส่งแจ้งเตือน','งานเบื้องหลัง'])assert.match(html,new RegExp(label));
  assert.doesNotMatch(html+source,/Retry \/ dead-letter/);
  assert.match(source,/ไม่มีรายการที่ต้องตรวจ/);assert.match(source,/ระบบยังไม่พบงานที่ต้องให้ผู้ดูแลดำเนินการ/);
  assert.match(html,/notificationExceptionDialog/);assert.match(html,/รายละเอียดการแจ้งเตือน/);
  assert.match(css,/min-height:44px/);assert.match(css,/@media\(max-width:600px\)/);assert.match(css,/max-height:90dvh/);
  assert.match(css,/env\(safe-area-inset-bottom\)/);assert.match(css,/overflow-wrap:anywhere/);
  assert.match(source,/requestSequence/);assert.match(source,/sequence!==state\.requestSequence/);
  assert.doesNotMatch(html+source,/localStorage|sessionStorage/);
});
