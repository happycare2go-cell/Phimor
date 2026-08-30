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

test('shared editor exposes all canonical fields and thirty-row bound', () => {
  assert.equal(editor.MAX_ROWS, 30);
  assert.deepEqual(editor.FIELDS.map(([field])=>field),
    ['name','strength','dose','instruction','amount','unit','frequency','timing','route','condition']);
  assert.equal(editor.FIELDS.find(([field])=>field==='name')[2], 200);
  assert.equal(editor.FIELDS.find(([field])=>field==='instruction')[2], 500);
});

test('image proposal assembly preserves absent current medication and applies only selected factual patch', () => {
  const proposal = {current:{medications:[{medicationId:'M-1',name:'Metformin',strength:'500 mg'},{medicationId:'M-2',name:'Aspirin',strength:'81 mg'}]},
    proposals:[{classification:'CHANGED_STRENGTH',currentIndex:1,extractedIndex:0,current:{name:'Aspirin',strength:'81 mg'},extracted:{name:'Aspirin',strength:'325 mg'},ambiguous:false}]};
  const result = editor.proposedCompleteSet(proposal,{0:'new'});
  assert.equal(result.length,2);
  assert.equal(result[0].name,'Metformin');
  assert.equal(result[1].strength,'325 mg');
  assert.equal(result[1].medicationId,'M-2');
});

test('Family and Center load shared editor and authoritative current-set routes', () => {
  for (const source of [family,center]) {
    assert.match(source,/shared\/medication-editor\.js/);
    assert.match(source,/shared\/medication-editor\.css/);
    assert.match(source,/medications\/current/);
    assert.match(source,/baseSnapshotId/);
    assert.match(source,/DUPLICATE_MEDICATION_IDENTITY/);
    assert.match(source,/MEDICATION_SNAPSHOT_STALE/);
  }
});

test('Family permission controls hide mutation actions for read-only caregivers', () => {
  assert.match(family,/manage_medications/);
  assert.match(family,/familyPermissions/);
  assert.match(family,/familyMedicationAdd.*hidden=!canManageFamilyMedication/);
  assert.match(family,/familyMedicationSave.*hidden=!canManageFamilyMedication/);
});

test('Center state includes exact Center Resident Care Profile generation and disables Center switch in flight', () => {
  assert.match(center,/residentId,careProfileId:[^,]+,centerId,generation,baseSnapshotId/);
  assert.match(center,/operation\.generation!==CENTER_CONTEXT_GENERATION\|\|operation\.centerId!==CENTER_ID/);
  assert.match(center,/centerSelector'\)\.disabled=true/);
  assert.match(center,/centerSelector'\)\.disabled=false/);
});

test('profile operation contains no browser persistence and captures immutable base snapshot', () => {
  assert.match(operation,/Object\.freeze/);
  assert.match(operation,/baseSnapshotId:baseSnapshotId\s*\|\|\s*null/);
  assert.doesNotMatch(operation,/localStorage|sessionStorage/);
  assert.doesNotMatch(family,/localStorage|sessionStorage/);
  assert.doesNotMatch(center,/localStorage|sessionStorage/);
});

test('mobile and accessibility contracts provide touch targets focus row errors and no horizontal scroll', () => {
  assert.match(css,/min-height:44px/);
  assert.match(css,/focus-visible/);
  assert.match(css,/aria-invalid/);
  assert.match(css,/overflow-wrap:anywhere/);
  assert.doesNotMatch(css,/overflow-x:(?:auto|scroll)/);
  assert.match(family,/aria-live="polite"/);
  assert.match(family,/role="dialog" aria-modal="true"/);
  assert.match(center,/role="dialog" aria-modal="true"/);
  assert.match(editor.renderRows.toString(),/confirmRemove/);
  assert.match(family,/familyMedicationEditorOptions[\s\S]*confirmRemove/);
  assert.match(center,/centerMedicationEditorOptions[\s\S]*confirmRemove/);
});

test('UI makes image non-replacement and ambiguity blocking explicit', () => {
  assert.match(family,/ยาที่ไม่พบในรูปจะยังคงอยู่/);
  assert.match(center,/ยาที่ไม่อยู่ในรูปจะยังคงอยู่/);
  assert.match(family,/AMBIGUOUS/);
  assert.match(center,/AMBIGUOUS/);
  assert.match(family,/medicationReviewConfirm'\)\.disabled=ambiguous/);
  assert.match(center,/centerMedicationSubmit'\)\.disabled=ambiguous/);
});
