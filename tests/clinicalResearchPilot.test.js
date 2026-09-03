const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const {
  CLINICAL_RESEARCH_MODES, parsePilotUsers, loadClinicalResearchPilotConfig,
  clinicalResearchAccess, publicClinicalResearchCapability,
}=require('../backend/config/clinicalResearchPilot');
const {
  validateDeidentifiedPilotSummary,
}=require('../backend/services/clinicalResearchPrivacy');
const {
  createConsultationResearchAccessService,
}=require('../backend/services/consultationResearchAccessService');
const {
  createClinicalResearchOperationsService,
}=require('../backend/services/clinicalResearchOperationsService');

test('research mode defaults and malformed values fail closed behind the emergency flag',()=>{
  for(const env of [
    {},
    {PHARMACIST_AI_RESEARCH_ENABLED:'true'},
    {PHARMACIST_AI_RESEARCH_ENABLED:'true',PHARMACIST_AI_RESEARCH_MODE:'unexpected'},
    {PHARMACIST_AI_RESEARCH_ENABLED:'false',PHARMACIST_AI_RESEARCH_MODE:'controlled_live'},
  ])assert.equal(loadClinicalResearchPilotConfig(env).mode,CLINICAL_RESEARCH_MODES.DISABLED);
  assert.equal(loadClinicalResearchPilotConfig({
    PHARMACIST_AI_RESEARCH_ENABLED:'true',PHARMACIST_AI_RESEARCH_MODE:'deidentified_pilot',
  }).mode,CLINICAL_RESEARCH_MODES.DEIDENTIFIED_PILOT);
  assert.equal(loadClinicalResearchPilotConfig({
    PHARMACIST_AI_RESEARCH_ENABLED:'true',PHARMACIST_AI_RESEARCH_MODE:'controlled_live',
  }).mode,CLINICAL_RESEARCH_MODES.CONTROLLED_LIVE);
});

test('pilot allowlist is bounded, exact and never projected to the browser',()=>{
  assert.deepEqual(parsePilotUsers('U-ONE, U-TWO,U-ONE'),['U-ONE','U-TWO']);
  const config=loadClinicalResearchPilotConfig({
    PHARMACIST_AI_RESEARCH_ENABLED:'true',PHARMACIST_AI_RESEARCH_MODE:'deidentified_pilot',
    PHARMACIST_AI_RESEARCH_PILOT_USERS:'U-ONE,U-TWO',
  });
  assert.equal(clinicalResearchAccess(config,'U-ONE').allowed,true);
  assert.equal(clinicalResearchAccess(config,'U-OTHER').status,'not_allowed');
  const publicValue=publicClinicalResearchCapability(config,'U-ONE');
  assert.equal(publicValue.mode,'deidentified_pilot');
  assert.equal(publicValue.requiresDeidentifiedInput,true);
  assert.doesNotMatch(JSON.stringify(publicValue),/U-ONE|U-TWO|pilotUsers|provider/i);
  const empty=loadClinicalResearchPilotConfig({
    PHARMACIST_AI_RESEARCH_ENABLED:'true',PHARMACIST_AI_RESEARCH_MODE:'controlled_live',
  });
  assert.equal(clinicalResearchAccess(empty,'U-ONE').allowed,false);
});

test('deidentified summary accepts clinical concepts but rejects direct identifiers',()=>{
  assert.equal(validateDeidentifiedPilotSummary('ผู้ใหญ่ใช้ amoxicillin 500 mg และมีผื่นหลังใช้ยา ต้องการตรวจเอกสารอ้างอิง').ok,true);
  for(const value of [
    'ชื่อผู้ป่วย: สมชาย ใจดี ใช้ amoxicillin และมีผื่นหลังใช้ยา',
    'ติดต่อ 081-234-5678 ผู้ใหญ่ใช้ยาแล้วมีอาการผิดปกติ',
    'Care Profile CP-PRIVATE ผู้ใหญ่ใช้ยาแล้วมีอาการผิดปกติ',
    'วันเกิด: 1 มกราคม 2500 ผู้ใหญ่ใช้ยาแล้วมีอาการผิดปกติ',
    'เลขบัตรประชาชน 1-2345-67890-12-3 ผู้ใหญ่ใช้ยาแล้วมีอาการ',
  ])assert.equal(validateDeidentifiedPilotSummary(value).errorCode,'DEIDENTIFIED_SUMMARY_PRIVACY_REJECTED');
});

test('deidentified access checks only pharmacist assignment and case state',async()=>{
  const calls=[];
  const requireAccess=createConsultationResearchAccessService({
    pharmacistAccounts:{async requireActive(lineUserId){calls.push(['pharmacist',lineUserId]);return {pharmacistId:'PH-1'};}},
    repository:{async findCaseForRead(caseId){calls.push(['case',caseId]);return {
      case_id:caseId,assigned_pharmacist_id:'PH-1',state:'active',order_status:'paid',
      provisioning_status:'provisioned',expires_at:'2099-01-01T00:00:00Z',database_now:'2026-09-03T00:00:00Z',
    };}},
  });
  const result=await requireAccess({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM'});
  assert.equal(result.pharmacistId,'PH-1');assert.equal(result.state,'active');
  assert.deepEqual(calls,[['pharmacist','U-PHARM'],['case','CASE-1']]);
  assert.doesNotMatch(JSON.stringify(result),/careProfile|patient|medication|lab/i);
});

test('System Admin operations projection contains mode and aggregates only',async()=>{
  let sql,values;
  const service=createClinicalResearchOperationsService({
    env:{PHARMACIST_AI_RESEARCH_ENABLED:'true',PHARMACIST_AI_RESEARCH_MODE:'deidentified_pilot'},
    queryFn:async(statement,params)=>{sql=statement;values=params;return {rows:[{
      requests:'4',successful:'3',failed:'1',web_searches:'5',approximate_tokens:'1234',
      prompt:'PRIVATE',patient_name:'PRIVATE',
    }]};},
  });
  const result=await service.getStatus();
  assert.equal(result.mode,'deidentified_pilot');
  assert.deepEqual(result.metrics,{requests:4,successful:3,failed:1,webSearches:5,approximateTokens:1234});
  assert.deepEqual(values,[7]);
  assert.match(sql,/purpose = 'pharmacist_clinical_research'/);
  assert.doesNotMatch(sql,/prompt|care_profile_id|consultation_case_id|requester_line_id/i);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|prompt|patient|provider|pilotUsers/i);
});

test('System Admin UI renders only safe Clinical Research aggregate controls',()=>{
  const html=fs.readFileSync(path.join(__dirname,'..','liff-app','system-admin','index.html'),'utf8');
  assert.match(html,/\/api\/admin\/operations\/clinical-research/);
  assert.match(html,/พี่หมอ Clinical Research|ทดลองแบบไม่ระบุตัวตน|ค้นเว็บ|โทเคนประมาณ/);
  assert.match(html,/ปิด Clinical Research ผ่านการตั้งค่าฝั่งเซิร์ฟเวอร์/);
  assert.doesNotMatch(html,/PHARMACIST_AI_RESEARCH_PILOT_USERS|OPENAI_API_KEY/);
});
