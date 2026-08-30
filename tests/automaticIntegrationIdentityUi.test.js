process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ui=require('../liff-app/system-admin/care-operations-ui');
const source=fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','care-operations-ui.js'),'utf8');
const html=fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','index.html'),'utf8');

test('System Admin exposes exact policy controls and safe controlled request',()=>{assert.equal(ui.IDENTITY_POLICY_LABELS.identityResolutionMode.exact_name_learning,'จับคู่ชื่อเต็มแบบตรงกันและเรียนรู้รหัสภายนอก');const request=ui.buildIdentityPolicyRequest('INT/A',{identityResolutionMode:'exact_name_learning',unresolvedEventPolicy:'ignore',familyGroupRequirement:'required_before_ingest'});assert.match(request.path,/INT%2FA\/identity-resolution-policy$/);assert.deepEqual(JSON.parse(request.options.body),{identityResolutionMode:'exact_name_learning',unresolvedEventPolicy:'ignore',familyGroupRequirement:'required_before_ingest'});assert.match(source,/ไม่ใช้ห้อง โทรศัพท์ การจับคู่คล้าย หรือ AI/);assert.match(source,/ข้อมูลที่ตีตกแล้วไม่สามารถกู้คืนจาก PHIMOR/);assert.match(source,/ระบบต้นทางส่งใหม่หลังแก้ไข/);});

test('learned mapping inventory distinguishes automatic and manual origins',()=>{assert.match(source,/การจับคู่ที่ระบบเรียนรู้แล้ว/);assert.match(source,/learned_automatically/);assert.match(source,/เรียนรู้อัตโนมัติ/);assert.match(source,/ผู้ดูแลกำหนด/);assert.match(source,/ขั้นสูง \/ แก้ไขข้อยกเว้น/);});

test('ambiguity review is non-clinical, status-manageable and available as one tab',()=>{assert.match(html,/data-care-ops-tab="alerts">รายการที่ต้องตรวจสอบ/);assert.match(source,/พบชื่อ–นามสกุลซ้ำ ไม่สามารถจับคู่อัตโนมัติได้/);assert.match(source,/ระบบยังไม่ได้บันทึกข้อมูลหรือส่งแจ้งเตือน/);assert.match(source,/Event รายการนี้ถูกตีตกแล้ว/);assert.match(ui.buildAlertStatusRequest('ALERT/1','resolved').path,/ALERT%2F1\/status$/);for(const prohibited of ['observations','care_items','symptom_note','line_group_id'])assert.doesNotMatch(source.slice(source.indexOf('function renderIdentityAlerts'),source.indexOf('function renderOverview')),new RegExp(prohibited,'i'));});

test('mobile operations controls retain 44px targets, containment and no browser persistence',()=>{assert.match(html,/min-height:44px/);assert.match(html,/overflow-wrap:anywhere/);assert.match(source,/safeArray\(item\.candidateCenterNames,20\)/);assert.doesNotMatch(source,/localStorage|sessionStorage|console\./);});

test('identity policy and alert APIs stay behind the existing System Admin router mount',()=>{const server=fs.readFileSync(path.resolve(__dirname,'..','backend','server.js'),'utf8');const admin=fs.readFileSync(path.resolve(__dirname,'..','backend','routes','admin.js'),'utf8');const routes=fs.readFileSync(path.resolve(__dirname,'..','backend','routes','platformAdmin.js'),'utf8');assert.match(server,/app\.use\('\/api\/admin', adminRouter\)/);assert.match(admin,/router\.use\(requireAdminKey\)/);assert.match(admin,/router\.use\('\/platform', createPlatformAdminRouter\(\)\)/);assert.match(routes,/identity-resolution-policy/);assert.match(routes,/integration-identity-alerts/);assert.doesNotMatch(routes,/observations|careItems|canonical_payload/);});
