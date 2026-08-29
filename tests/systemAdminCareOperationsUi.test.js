const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = require('../liff-app/system-admin/care-operations-ui');
const html = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'system-admin', 'index.html'), 'utf8');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'system-admin', 'care-operations-ui.js'), 'utf8');
const css = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'system-admin', 'care-operations-ui.css'), 'utf8');

test('System Admin LIFF contains the five Care Infrastructure operations sections', () => {
  for (const tab of ['overview','capabilities','integrations','pending','groups']) assert.match(html, new RegExp(`data-care-ops-tab="${tab}"`));
  assert.match(html, /ศูนย์และระบบเชื่อมต่อ/); assert.match(html, /care-operations-ui\.js/); assert.match(html, /care-operations-ui\.css/);
});

test('capability changes use the existing System Admin endpoint with an explicit boolean', () => {
  const descriptor = ui.buildCapabilityRequest('CTR A', 'vital_signs_v1', true);
  assert.equal(descriptor.path, '/api/admin/platform/centers/CTR%20A/capabilities/vital_signs_v1');
  assert.deepEqual(JSON.parse(descriptor.options.body), {enabled:true});
  assert.match(source, /confirmAction/); assert.match(source, /ข้อมูลย้อนหลังไม่ถูกลบ/);
  assert.match(source, /อัปเดต .* เป็น .* แล้ว/); assert.match(source, /typeof result\?\.capability\?\.enabled !== 'boolean'/);
});

test('pending mapping searches only within the authoritative mapped Center', () => {
  const descriptor = ui.buildResidentOptionsRequest('CTR-A', 'คุณยาย');
  assert.match(descriptor.path, /^\/api\/admin\/platform\/centers\/CTR-A\/resident-options\?/);
  assert.match(descriptor.path, /search=/); assert.match(descriptor.path, /limit=100/);
  assert.doesNotMatch(descriptor.path, /organizationId|externalResidentId/);
});

test('mapping action is exact and contains no fuzzy identity fields', () => {
  const descriptor = ui.buildMappingRequest({integrationClientId:'INT-A',externalCenterId:'EXT-C',externalResidentId:'EXT-R'}, 'RES-A');
  assert.equal(descriptor.path, '/api/admin/platform/pending-subjects/map');
  assert.deepEqual(JSON.parse(descriptor.options.body), {integrationClientId:'INT-A',externalCenterId:'EXT-C',externalResidentId:'EXT-R',residentId:'RES-A'});
  assert.doesNotMatch(descriptor.options.body, /phone|dob|score|fuzzy|line/i);
});

test('mapping requires explicit confirmation that shows both external and PHIMOR identities', () => {
  const message = ui.mappingConfirmationMessage(
    {externalResidentId:'RES-10025',displayName:'คุณสมใจ ใจดี',room:'A201'},
    {residentId:'RES-PHIMOR',displayName:'คุณสมใจ ใจดี',room:'A201'},
    {displayName:'ระบบตัวอย่าง'}, {name:'ศูนย์ตัวอย่าง'},
  );
  assert.match(message, /ข้อมูลจากระบบภายนอก/); assert.match(message, /RES-10025/);
  assert.match(message, /กำลังจะเชื่อมกับ/); assert.match(message, /ศูนย์ตัวอย่าง/);
  assert.match(source, /ยืนยันเชื่อมผู้พัก/); assert.match(source, /await confirmAction/);
  assert.doesNotMatch(message, /phone|dob|clinical/i);
});

test('group status labels expose verified/missing/mismatch/not-provided without send-anyway bypass', () => {
  assert.deepEqual(Object.keys(ui.GROUP_LABELS).sort(), ['group_binding_mismatch','group_binding_missing','no_expected_group','verified_match']);
  assert.equal(ui.GROUP_LABELS.verified_match[0], 'VERIFIED'); assert.equal(ui.GROUP_LABELS.group_binding_missing[0], 'MISSING');
  assert.equal(ui.GROUP_LABELS.group_binding_mismatch[0], 'MISMATCH'); assert.equal(ui.GROUP_LABELS.no_expected_group[0], 'NOT_PROVIDED');
  assert.equal(ui.GROUP_LABELS.verified_match[1], 'กลุ่ม LINE ตรงกัน');
  assert.equal(ui.GROUP_LABELS.group_binding_missing[1], 'ยังไม่พบกลุ่ม LINE ที่พี่หมอยืนยันแล้ว');
  assert.equal(ui.GROUP_LABELS.group_binding_mismatch[1], 'กลุ่ม LINE ไม่ตรงกัน');
  assert.equal(ui.GROUP_LABELS.no_expected_group[1], 'ระบบต้นทางไม่ได้ส่ง Group ID สำหรับตรวจสอบ');
  assert.equal(ui.truncateGroupId('C12345678901234567890'), 'C12345…7890');
  assert.doesNotMatch(`${html}\n${source}`, /send anyway|ส่งต่อไปเลย|ข้ามการตรวจ/i);
});

test('operations UI shows safe pending/rejected/retry states without rendering raw event payloads', () => {
  assert.equal(ui.EVENT_STATUS_LABELS.pending_subject_mapping[0], 'รอเชื่อมผู้พัก');
  assert.equal(ui.EVENT_STATUS_LABELS.rejected[0], 'ปฏิเสธ');
  assert.equal(ui.EVENT_STATUS_LABELS.dead[0], 'ประมวลผลไม่สำเร็จ');
  assert.equal(ui.REJECTION_REASON_LABELS.CENTER_MAPPING_NOT_FOUND, 'ไม่พบการเชื่อมสาขา');
  assert.equal(ui.REJECTION_REASON_LABELS.CAPABILITY_NOT_ENABLED, 'capability ยังไม่เปิด');
  assert.match(source, /lastErrorCode/);
  assert.doesNotMatch(source, /canonicalPayload|canonical_payload|requestBody|rawPayload/);
});

test('reconciliation calls the existing idempotent backend operation and never accepts a target group', () => {
  const descriptor = ui.buildReconcileRequest('IEVT-1');
  assert.equal(descriptor.path, '/api/admin/platform/integration-events/IEVT-1/reconcile-group');
  assert.deepEqual(JSON.parse(descriptor.options.body), {});
  assert.doesNotMatch(JSON.stringify(descriptor), /expectedLineGroupId|verifiedLineGroupId|destination/);
});

test('Integration UI manages commissioning while never redisplaying or persisting an existing credential secret', () => {
  assert.match(source, /Credential เดิมไม่สามารถเปิดดูซ้ำได้/); assert.match(source, /Credential ใหม่/);
  assert.match(source, /oneTimeSecret\.clear/); assert.match(source, /pagehide/);
  assert.doesNotMatch(source, /credential\.token|secret_hash|secret_salt|localStorage|sessionStorage|console\./);
  assert.doesNotMatch(html, /type="text"[^>]+credential|credentialSecret/i);
});

test('generic Integration commissioning UI exposes managed directory and controlled request contracts',()=>{
  assert.match(source,/\+ เพิ่มระบบเชื่อมต่อ/);assert.match(source,/จัดการระบบเชื่อมต่อ/);
  assert.match(source,/การเชื่อมรหัสศูนย์ภายนอก/);assert.match(source,/การเชื่อมรหัสผู้พักภายนอก/);
  const create=ui.buildCreateClientRequest({organizationId:'ORG-A',clientCode:'HHS Pilot',displayName:'HHS Pilot',sourceSystem:'HHS'});
  assert.deepEqual(JSON.parse(create.options.body),{clientCode:'hhs-pilot',displayName:'HHS Pilot',sourceSystem:'HHS',initialStatus:'suspended'});
  assert.deepEqual(ui.SUPPORTED_EVENT_TYPES,['care.daily_report.finalized','care.vitals.recorded']);
  assert.equal(ui.buildCenterScopeRequest('INT-A','CTR-A',true).options.method,'PUT');
  assert.equal(ui.buildCenterScopeRequest('INT-A','CTR-A',false).options.method,'DELETE');
  assert.equal(ui.buildEventScopeRequest('INT-A','care.daily_report.finalized',true).options.method,'PUT');
});

test('mapping inventory and credential actions are exact and contain no arbitrary routing target',()=>{
  const center=ui.buildCenterMappingRequest('INT-A','HHS_BRANCH_01','CTR-A');
  assert.equal(center.options.method,'PUT');assert.deepEqual(JSON.parse(center.options.body),{centerId:'CTR-A'});
  const resident=ui.buildSubjectMappingRequest('INT-A','HHS_BRANCH_01','HHS_RESIDENT_01','RES-A');
  assert.deepEqual(JSON.parse(resident.options.body),{residentId:'RES-A'});
  assert.doesNotMatch(JSON.stringify([center,resident]),/groupId|lineId|phone|fuzzy|clinical/i);
  assert.equal(ui.buildCredentialRequest('INT-A','rotate','KEY-A').path,'/api/admin/platform/integration-clients/INT-A/credentials/KEY-A/rotate');
});

test('operations UI is mobile-card based and does not become a clinical browser', () => {
  assert.match(css, /min-height:44px/); assert.match(css, /focus-visible/); assert.match(css, /@media\(max-width:600px\)/); assert.match(css, /overflow-wrap:anywhere/);
  assert.doesNotMatch(`${html}\n${source}`, /Lab history|medication history|consultation transcript|raw Vital|full Daily Care/i);
});
