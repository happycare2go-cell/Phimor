const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const editor = require('../liff-app/shared/medication-editor');
const family = fs.readFileSync(path.join(root,'liff-app/family/index.html'),'utf8');
const center = fs.readFileSync(path.join(root,'liff-app/center-admin/index.html'),'utf8');
const css = fs.readFileSync(path.join(root,'liff-app/shared/medication-editor.css'),'utf8');
const operation = fs.readFileSync(path.join(root,'liff-app/family/medication-operation.js'),'utf8');

test('shared editor keeps the canonical model but presents clear human field semantics', () => {
  assert.equal(editor.MAX_ROWS, 30);
  assert.equal(editor.MAX_IMAGES, 4);
  assert.deepEqual(new Set(editor.FIELDS.map(([field])=>field)), new Set(
    ['name','strength','dose','instruction','amount','unit','frequency','timing','route','condition']));
  assert.equal(editor.FIELD_LABELS.strength,'ความแรงของยา');
  assert.equal(editor.FIELD_LABELS.dose,'ครั้งละ');
  assert.equal(editor.FIELD_LABELS.amount,'จำนวนที่ได้รับทั้งหมด');
  assert.equal(editor.FIELD_LABELS.condition,'หมายเหตุเพิ่มเติม');
});

test('dose summary does not combine per-administration unit with complete dispensed amount', () => {
  const item={name:'ยาน้ำ',dose:'5',unit:'มล.',amount:'1 ขวด',frequency:'1 ครั้ง',timing:'ก่อนนอน'};
  assert.equal(editor.doseLine(item),'ครั้งละ 5 มล.');
  assert.doesNotMatch(editor.doseLine(item),/1 ขวด/);
  assert.equal(editor.scheduleLine(item),'วันละ 1 ครั้ง · ก่อนนอน');
  assert.match(editor.renderCards.toString(),/จำนวนที่ได้รับทั้งหมด/);
  assert.doesNotMatch(editor.renderCards.toString(),/item\.amount\}.*item\.unit/s);
});

test('legacy directions stored in dose remain readable without duplicate prefix or silent rewrite', () => {
  const legacy={name:'ยาความดัน',dose:'รับประทานครั้งละ 1 เม็ด วันละ 1 ครั้ง ก่อนนอน',instruction:'',amount:null,unit:null};
  assert.equal(editor.isLegacyDoseInstruction(legacy),true);
  assert.equal(editor.doseLine(legacy),'');
  assert.equal(editor.instructionLine(legacy),legacy.dose);
  const editable=editor.clean(legacy);
  assert.equal(editable.dose,legacy.dose);
  assert.equal(editable.instruction,'');
  assert.doesNotMatch(`ครั้งละ ${editor.doseLine(legacy)}`,/ครั้งละ\s+รับประทานครั้งละ/);
  assert.match(editor.renderRows.toString(),/คำสั่งใช้ยาตามฉลาก \(ข้อมูลเดิม\)/);
  assert.match(editor.renderRows.toString(),/คงรูปแบบเดิมไว้จนกว่าคุณจะแก้ไขเอง/);
});

test('image proposal assembly preserves current medication and applies only explicit human choice', () => {
  const proposal = {current:{medications:[{medicationId:'M-1',name:'Metformin',strength:'500 mg'},{medicationId:'M-2',name:'Aspirin',strength:'81 mg'}]},
    proposals:[{classification:'CHANGED_STRENGTH',currentIndex:1,extractedIndex:0,current:{name:'Aspirin',strength:'81 mg'},extracted:{name:'Aspirin',strength:'325 mg'},ambiguous:false}]};
  const keep = editor.proposedCompleteSet(proposal,{0:'current'});
  const replace = editor.proposedCompleteSet(proposal,{0:'new'});
  assert.equal(keep[1].strength,'81 mg');
  assert.equal(replace[0].name,'Metformin');
  assert.equal(replace[1].strength,'325 mg');
  assert.equal(replace[1].medicationId,'M-2');
});

test('one image can produce multiple drafts and multiple images combine with partial success', () => {
  const result=editor.combineImageExtractions([
    {ok:true,extracted:[{name:'A'},{name:'B'}],extractionReview:[{extractedIndex:0,state:'read',uncertainFields:[]},{extractedIndex:1,state:'review',uncertainFields:['dose']}]},
    {ok:false},
    {ok:true,extracted:[{name:'C'}],extractionReview:[{extractedIndex:0,state:'read',uncertainFields:[]}]},
  ]);
  assert.deepEqual(result.extracted.map((item)=>item.name),['A','B','C']);
  assert.equal(result.failedImages,1);
  assert.equal(result.readableImages,2);
  assert.equal(result.reviewByIndex[1].state,'review');
  assert.deepEqual(result.reviewByIndex[1].uncertainFields,['dose']);
});

test('image batching is bounded and ignores an unbounded fifth image', () => {
  const result=editor.combineImageExtractions(Array.from({length:5},(_,index)=>({ok:true,extracted:[{name:`ยา ${index+1}`}]})));
  assert.equal(result.totalImages,4);
  assert.equal(result.extracted.length,4);
});

test('Family and Center are read-first and never render an automatic blank row', () => {
  assert.doesNotMatch(editor.renderRows.toString(), /items\.length\s*\?[^:]+:\s*\[\{\}\]/);
  for (const source of [family,center]) {
    assert.match(source,/MedicationCards/);
    assert.match(source,/ถ่ายรูป \/ อัปโหลดฉลากยา/);
    assert.match(source,/กรอกยาเอง/);
    assert.match(source,/multiple/);
    assert.match(source,/medications\/draft-proposal/);
    assert.match(source,/baseSnapshotId/);
    assert.match(source,/DUPLICATE_MEDICATION_IDENTITY/);
    assert.match(source,/MEDICATION_SNAPSHOT_STALE/);
  }
  assert.match(editor.renderCards.toString(),/ยังไม่มีรายการยาปัจจุบัน/);
  assert.match(editor.renderCards.toString(),/เพิ่มยาโดยถ่ายรูปฉลากยา หรือกรอกข้อมูลเอง/);
});

test('extraction remains a draft and current-set save does not persist source image bytes', () => {
  for (const source of [family,center]) {
    assert.match(source,/ข้อมูลนี้อ่านมาจากรูปและยังไม่ได้บันทึก/);
    assert.match(source,/ยืนยันและบันทึก/);
    assert.match(source,/draft-proposal/);
    assert.doesNotMatch(source,/sourceImageBase64/);
    assert.doesNotMatch(source,/imageBase64:centerMedication/);
  }
});

test('uncertainty, partial failures and duplicate comparison use safe human review copy', () => {
  assert.match(editor.renderProposalReview.toString(),/ควรตรวจ/);
  assert.match(editor.renderProposalReview.toString(),/ระบบอ่านข้อมูลส่วนนี้ได้ไม่ชัด/);
  assert.match(editor.renderProposalReview.toString(),/พบรายการที่อาจเป็นยาเดียวกัน/);
  assert.match(editor.renderProposalReview.toString(),/คงข้อมูลปัจจุบัน/);
  assert.match(editor.renderProposalReview.toString(),/ใช้ข้อมูลจากฉลากใหม่/);
  for(const source of [family,center]){
    assert.match(source,/มี \$\{batch\.failedImages\} รูปที่อ่านไม่ชัด/);
    assert.match(source,/อ่านข้อมูลจากรูปนี้ไม่ได้/);
  }
});

test('Family permission and Center relationship protections remain authoritative', () => {
  assert.match(family,/manage_medications/);
  assert.match(family,/familyPermissions/);
  assert.match(family,/const canManage=canManageFamilyMedication\(\)/);
  assert.match(family,/familyMedicationPrimaryActions'\)\.hidden=!canManage/);
  assert.match(center,/residentId:centerMedicationState\.residentId,careProfileId:centerMedicationState\.careProfileId,centerId:centerMedicationState\.centerId,generation:centerMedicationState\.generation,baseSnapshotId:centerMedicationState\.baseSnapshotId/);
  assert.match(center,/operation\.centerId===CENTER_ID&&operation\.generation===CENTER_CONTEXT_GENERATION/);
  assert.match(center,/centerSelector/);
});

test('profile operation has no browser persistence and captures immutable snapshot context', () => {
  assert.match(operation,/Object\.freeze/);
  assert.match(operation,/baseSnapshotId:baseSnapshotId\s*\|\|\s*null/);
  assert.doesNotMatch(operation,/localStorage|sessionStorage/);
  assert.doesNotMatch(family,/localStorage|sessionStorage/);
  assert.doesNotMatch(center,/localStorage|sessionStorage/);
});

test('mobile and accessibility contracts include 44px targets, safe area, focus and no horizontal scroll', () => {
  assert.match(css,/min-width:44px;min-height:44px/);
  assert.match(css,/focus-visible/);
  assert.match(css,/aria-invalid/);
  assert.match(css,/safe-area-inset-bottom/);
  assert.match(css,/overflow-wrap:anywhere/);
  assert.doesNotMatch(css,/overflow-x:(?:auto|scroll)/);
  assert.match(family,/aria-live="polite"/);
  assert.match(family,/role="dialog" aria-modal="true"/);
  assert.match(center,/role="dialog" aria-modal="true"/);
  assert.match(editor.renderRows.toString(),/confirmRemove/);
});
