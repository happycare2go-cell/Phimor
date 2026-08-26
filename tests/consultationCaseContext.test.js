const { test } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const {
  createConsultationCaseContextService, safeLinePictureUrl,
} = require('../backend/services/consultationCaseContextService');

const NOW = '2026-08-26T10:00:00.000Z';
const PROFILE = {
  care_profile_id:'CP-1', patient_name:'คุณยายทดสอบ', gender:'female', blood_type:'O+',
  height_cm:155, weight_kg:52, chronic_conditions:['เบาหวาน'], drug_allergies:'Penicillin',
  food_allergies:'', mobility_limitations:'ใช้ไม้เท้า', emergency_contact_name:'SECRET CONTACT',
  emergency_contact_phone:'0811111111', family_phone:'0822222222', owner_line_id:'U-FAMILY',
  _updatedAt:'2026-08-26T09:00:00.000Z', status:'active',
};
const CASE = {
  case_id:'CASE-1', order_id:'ORDER-1', care_profile_id:'CP-1',
  customer_line_user_id:'U-FAMILY', assigned_pharmacist_id:'PH-1',
  state:'active', waiting_on:'pharmacist', order_status:'paid', provisioning_status:'provisioned',
  accepted_at:'2026-08-26T09:00:00.000Z', expires_at:'2026-08-27T09:00:00.000Z',
  database_now:NOW,
};

function harness(overrides = {}) {
  const calls = { authorize:0, line:0, medications:0, appointments:0 };
  const dependencies = {
    repository:{async findCaseForRead(){return CASE;}},
    pharmacistAccounts:{async requireActive(){return {pharmacistId:'PH-1',status:'active',licenseVerifiedAt:NOW};}},
    async authorize(input){calls.authorize+=1;assert.equal(input.lineUserId,'U-FAMILY');assert.equal(input.permission,'view');return {careProfile:PROFILE};},
    careProfiles:{async findOne(predicate){return predicate(PROFILE)?PROFILE:null;}},
    async loadMedicationSnapshot(){calls.medications+=1;return {currentSnapshot:{snapshotId:'MEDS-1',recordedAt:NOW},medications:[{name:'Metformin',dose:'500 mg',instruction:'หลังอาหาร',condition:'เบาหวาน'}]};},
    appointments:{async findWhere(predicate){calls.appointments+=1;return [{appointment_id:'APT-1',care_profile_id:'CP-1',hospital:'รพ.ทดสอบ',datetime:'2026-08-30T10:00:00.000Z',reason_for_visit:'ติดตามยา',status:'active',emergency_phone:'0833333333'}].filter(predicate);}},
    async getLineProfile(){calls.line+=1;return {userId:'U-FAMILY',displayName:'ญาติผู้ดูแล',pictureUrl:'https://profile.line-scdn.net/test/avatar'};},
    now:()=>new Date(NOW),
    ...overrides,
  };
  return { calls, service:createConsultationCaseContextService(dependencies) };
}

test('assigned pharmacist receives separated LINE contact and minimized Care Profile context',async()=>{
  const h=harness();const result=await h.service.getCaseContext({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM'});
  assert.equal(result.contact.displayName,'ญาติผู้ดูแล');
  assert.equal(result.careProfile.patientName,'คุณยายทดสอบ');
  assert.equal(result.currentMedications[0].name,'Metformin');
  assert.equal(result.upcomingAppointments[0].hospital,'รพ.ทดสอบ');
  assert.equal(h.calls.authorize,1);
});

test('case context excludes LINE IDs contacts Health History and raw profile fields',async()=>{
  const result=await harness().service.getCaseContext({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM'});
  const serialized=JSON.stringify(result);
  for(const secret of ['U-FAMILY','0811111111','0822222222','0833333333','SECRET CONTACT','owner_line_id','healthHistory','emergency_contact']) assert.equal(serialized.includes(secret),false,secret);
});

test('revoked customer access blocks LINE and clinical reads',async()=>{
  const error=Object.assign(new Error('revoked'),{code:'MEMBERSHIP_REVOKED',status:403});
  const h=harness({async authorize(){throw error;}});
  await assert.rejects(()=>h.service.getCaseContext({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM'}),{code:'MEMBERSHIP_REVOKED'});
  assert.deepEqual({line:h.calls.line,medications:h.calls.medications,appointments:h.calls.appointments},{line:0,medications:0,appointments:0});
});

test('unassigned or closed case cannot read participant context',async()=>{
  let authorizationReads=0;
  const unassigned=harness({pharmacistAccounts:{async requireActive(){return {pharmacistId:'PH-OTHER'};}},async authorize(){authorizationReads+=1;}});
  await assert.rejects(()=>unassigned.service.getCaseContext({caseId:'CASE-1',pharmacistLineUserId:'U-OTHER'}),{code:'CONSULTATION_ACCESS_DENIED'});
  assert.equal(authorizationReads,0);
  const closed=harness({repository:{async findCaseForRead(){return {...CASE,database_now:CASE.expires_at};}}});
  await assert.rejects(()=>closed.service.getCaseContext({caseId:'CASE-1',pharmacistLineUserId:'U-PHARM'}),{code:'CONSULTATION_EXPIRED'});
});

test('LINE picture projection accepts only credential-free LINE CDN HTTPS URLs',()=>{
  assert.equal(safeLinePictureUrl('https://profile.line-scdn.net/a/b'),'https://profile.line-scdn.net/a/b');
  for(const unsafe of ['http://profile.line-scdn.net/a','https://evil.example/a','https://user:pass@profile.line-scdn.net/a','javascript:alert(1)']) assert.equal(safeLinePictureUrl(unsafe),null);
});
