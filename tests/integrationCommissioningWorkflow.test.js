process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const db=require('../backend/db');
const {createPlatformService}=require('../backend/services/platformService');
const {createMemoryPlatformRepository}=require('./helpers/platformMemoryRepository');
const ui=require('../liff-app/system-admin/care-operations-ui');

const source=fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','care-operations-ui.js'),'utf8');
const css=fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','care-operations-ui.css'),'utf8');

function fixture(){db.resetAll();const repository=createMemoryPlatformRepository();let seq=0;return{repository,service:createPlatformService({repository,idFactory:(prefix)=>`${prefix}-${++seq}`,randomBytes:(size)=>Buffer.alloc(size,7),now:()=>new Date('2026-08-31T00:00:00.000Z')})}}

test('Integration directory is server bounded, searchable and contains only summary metadata',async()=>{
  const {service,repository}=fixture();
  const org=await service.createOrganization({organizationCode:'org-a',displayName:'องค์กรเอ',actorReference:'ADM'});
  for(let index=0;index<25;index+=1)await service.createIntegrationClient({organizationId:org.organizationId,clientCode:`client-${String(index).padStart(2,'0')}`,displayName:`Client ${String(index).padStart(2,'0')}`,sourceSystem:index%2?'HHS':'Other',initialStatus:'suspended',actorReference:'ADM'});
  const page=await service.listIntegrationClientDirectory({search:'HHS',status:'suspended',page:2,limit:5});
  assert.equal(page.items.length,5);assert.equal(page.pagination.total,12);assert.equal(page.pagination.totalPages,3);
  assert.ok(page.items.every((item)=>item.sourceSystem==='HHS'&&item.status==='suspended'));
  assert.doesNotMatch(JSON.stringify(page),/secret_hash|secret_salt|token|payload|line_user|clinical/i);
  assert.equal(repository.state.clients.length,25);
});

test('commissioning wizard exposes six explicit steps and backend readiness remains authoritative',()=>{
  for(const label of ['1. ข้อมูลระบบ','2. ศูนย์ที่อนุญาต','3. ประเภทข้อมูลที่อนุญาต','4. ข้อมูลรับรอง','5. การเชื่อมรหัส','6. ตรวจความพร้อม'])assert.match(source,new RegExp(label));
  assert.match(source,/INTEGRATION_CLIENT_NOT_READY|configurationComplete/);
  assert.match(source,/ฉันคัดลอกและเก็บ Credential ในระบบ Server ที่ปลอดภัยแล้ว/);
  assert.match(source,/Backend ตรวจ Organization, Center scope, Event scope, Credential, identity policy และ mapping readiness/);
  assert.match(source,/ระบบจับคู่ชื่อแบบตรงกันเท่านั้น ไม่ใช้ห้อง โทรศัพท์ fuzzy หรือ AI/);
});

test('wizard and directory remain mobile touch-safe with no browser persistence',()=>{
  assert.match(css,/care-ops__choice-row\{[^}]*min-height:48px/);
  assert.match(css,/care-ops__wizard-actions\{[^}]*position:sticky/);
  assert.match(css,/@media\(max-width:600px\).*care-ops__wizard-progress/s);
  assert.doesNotMatch(source,/localStorage|sessionStorage|credential.*URL|location\.hash/);
  const request=ui.buildIntegrationDirectoryRequest({search:'ชื่อระบบ',status:'active',page:3,limit:20});
  assert.match(request.path,/search=%E0%B8%8A%E0%B8%B7%E0%B9%88%E0%B8%AD%E0%B8%A3%E0%B8%B0%E0%B8%9A%E0%B8%9A/);
  assert.equal(request.options.method,'GET');
});

test('existing Integration detail, credential rotation and supported HHS event scopes remain present',()=>{
  assert.match(source,/จัดการระบบเชื่อมต่อ/);
  assert.match(source,/หมุน Credential/);
  assert.match(source,/เพิกถอน Credential/);
  assert.deepEqual(ui.SUPPORTED_EVENT_TYPES,['care.daily_report.finalized','care.vitals.recorded']);
  assert.doesNotMatch(source,/send anyway|ส่งต่อไปเลย|fuzzy score/i);
});
