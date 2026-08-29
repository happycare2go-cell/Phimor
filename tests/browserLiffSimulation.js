// Real Chromium simulation for LIFF screens. LINE and backend are intercepted;
// no production data or real LINE account is used.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function browserExecutable(chromium) {
  const candidates = [
    process.env.PHIMOR_CHROMIUM_EXECUTABLE,
    process.platform === 'win32' && 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    process.platform === 'win32' && 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.platform === 'win32' && 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.platform === 'win32' && 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    chromium.executablePath(),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function playwright() {
  try { return require('playwright'); }
  catch (firstError) {
    const custom = process.env.PHIMOR_PLAYWRIGHT_MODULE;
    if (custom) return require(custom);
    throw new Error('Playwright is required. Run npm install --save-dev playwright && npx playwright install chromium');
  }
}

const LIFF_MOCK = `<script>window.liff={init:async()=>{},isLoggedIn:()=>true,login:()=>{},logout:()=>{},getIDToken:()=> 'SIMULATED_ID_TOKEN',getProfile:async()=>({userId:'U_SIMULATED',displayName:'ผู้ใช้จำลอง'}),isInClient:()=>true,closeWindow:()=>{},openWindow:()=>{}};</script>`;
const SIMULATED_BACKEND_URL = 'https://phimor-backend.onrender.com';
const RUNTIME_CONFIG_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'runtime-config.js'), 'utf8');
const CENTER_LAB_REVIEW_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'center-admin', 'lab-review-runtime.js'), 'utf8');
const CENTER_CARE_RECORDING_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'center-admin', 'care-recording-ui.js'), 'utf8');
const FAMILY_PLUS_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'plus-ui.js'), 'utf8');
const FAMILY_CONSULTATION_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'consultation-ui.js'), 'utf8');
const CONSULTATION_REALTIME_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'consultation-realtime-client.js'), 'utf8');
const FAMILY_DOCTOR_VISIT_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'doctor-visit-ui.js'), 'utf8');
const FAMILY_LAB_RESULTS_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'lab-results-ui.js'), 'utf8');
const FAMILY_CARE_HISTORY_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'care-history-ui.js'), 'utf8');
const FAMILY_HOME_V2_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'family-home-v2.js'), 'utf8');
const FAMILY_MEDICATION_OPERATION_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'medication-operation.js'), 'utf8');
const ADMIN_CARE_OPERATIONS_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'system-admin', 'care-operations-ui.js'), 'utf8');
const CLINICAL_ACTION_DIALOG_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'shared', 'clinical-action-dialog.js'), 'utf8');
const CLINICAL_ACTION_DIALOG_CSS = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'shared', 'clinical-action-dialog.css'), 'utf8');
const FAMILY_LAB_RESULTS_CSS = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'lab-results-ui.css'), 'utf8');
const CENTER_CARE_RECORDING_CSS = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'center-admin', 'care-recording-ui.css'), 'utf8');

function localHtml(name) {
  return fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', name, 'index.html'), 'utf8')
    .replace(/<script[^>]+static\.line-scdn\.net\/liff\/edge\/2\/sdk\.js[^>]*><\/script>/, LIFF_MOCK)
    .replace('<script src="../environment.js"></script>', `<script>window.PHIMOR_PUBLIC_BACKEND_URL=${JSON.stringify(SIMULATED_BACKEND_URL)};</script>`)
    .replace('<script src="../runtime-config.js"></script>', `<script>${RUNTIME_CONFIG_SOURCE}</script>`)
    .replace('<script src="./lab-review-runtime.js"></script>', `<script>${CENTER_LAB_REVIEW_SOURCE}</script>`)
    .replace('<script src="./care-recording-ui.js"></script>', `<script>${CENTER_CARE_RECORDING_SOURCE}</script>`)
    .replace('<script src="./plus-ui.js"></script>', `<script>${FAMILY_PLUS_SOURCE}</script>`)
    .replace('<script src="./consultation-ui.js"></script>', `<script>${FAMILY_CONSULTATION_SOURCE}</script>`)
    .replace('<script src="../consultation-realtime-client.js"></script>', `<script>${CONSULTATION_REALTIME_SOURCE}</script>`)
    .replace('<script src="./doctor-visit-ui.js"></script>', `<script>${FAMILY_DOCTOR_VISIT_SOURCE}</script>`)
    .replace('<script src="./lab-results-ui.js"></script>', `<script>${FAMILY_LAB_RESULTS_SOURCE}</script>`)
    .replace('<script src="./care-history-ui.js"></script>', `<script>${FAMILY_CARE_HISTORY_SOURCE}</script>`)
    .replace('<script src="./care-operations-ui.js"></script>', `<script>${ADMIN_CARE_OPERATIONS_SOURCE}</script>`)
    .replace('<script src="./family-home-v2.js"></script>', `<script>${FAMILY_HOME_V2_SOURCE}</script>`)
    .replace('<script src="./medication-operation.js"></script>', `<script>${FAMILY_MEDICATION_OPERATION_SOURCE}</script>`)
    .replace('<script src="../shared/clinical-action-dialog.js"></script>', `<script>${CLINICAL_ACTION_DIALOG_SOURCE}</script>`)
    .replace('<link rel="stylesheet" href="../shared/clinical-action-dialog.css">', `<style>${CLINICAL_ACTION_DIALOG_CSS}</style>`)
    .replace('<link rel="stylesheet" href="./lab-results-ui.css">', `<style>${FAMILY_LAB_RESULTS_CSS}</style>`)
    .replace('<link rel="stylesheet" href="./care-recording-ui.css">', `<style>${CENTER_CARE_RECORDING_CSS}</style>`);
}

async function mockBackend(page, handler) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (!request.url().startsWith(SIMULATED_BACKEND_URL)) return route.abort();
    const result = await handler(new URL(request.url()), request);
    const responseStatus = Number.isInteger(result?.status) ? result.status : 200;
    return route.fulfill({ status: responseStatus, contentType: 'application/json', body: JSON.stringify(result?.body ?? result ?? {}) });
  });
}

async function familyConsentJourney(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let consent = false;
  await mockBackend(page, async (url) => {
    if (url.pathname === '/config/liff') return { publicBackendUrl: SIMULATED_BACKEND_URL, familyLiffId: 'SIM_FAMILY' };
    if (url.pathname === '/api/consent/check') return { hasConsent: consent };
    if (url.pathname === '/api/consent') { consent = true; return { consent_id: 'C1', accepted: true }; }
    if (url.pathname === '/api/init-dashboard') return { profiles: [] };
    if (url.pathname === '/api/access-requests') return { requests: [] };
    if (url.pathname === '/api/transport/family/pending') return { pending: [] };
    return { status: 404, body: { message: `unmocked ${url.pathname}` } };
  });
  await page.setContent(localHtml('family'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#consentOverlay')).display !== 'none');
  await page.getByRole('button', { name: 'ยอมรับและเริ่มใช้งาน' }).click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#app')).display === 'block');
  assert.equal(await page.locator('#lineDisplayName').textContent(), 'ผู้ใช้จำลอง');
  await page.locator('[data-family-destination="health"]').first().click();
  assert.strictEqual(await page.locator('#healthNoProfileState').isVisible(), true);
  assert.strictEqual(await page.locator('#healthProfileContent').isHidden(), true);
  assert.match(await page.locator('#healthNoProfileState').textContent(), /ยังไม่ได้เลือก Care Profile/);
  await page.getByRole('button', { name: 'กลับหน้าหลักเพื่อสร้าง Care Profile' }).click();
  assert.strictEqual(await page.locator('#view-home').isVisible(), true);
  await page.close();
}

async function familyHealthProfileSwitchJourney(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const profiles = [
    {
      profile: { care_profile_id:'CP1', patient_name:'คุณยายทองดี', blood_type:'A+', gender:'female', height_cm:'155', weight_kg:'52', chronic_conditions:['เบาหวาน'], drug_allergies:'เพนิซิลลิน', food_allergies:'', mobility_limitations:'ใช้ไม้เท้า', emergency_contact_name:'สมใจ', emergency_contact_phone:'0811111111', family_phone:'0822222222' },
      familyRole:'owner', canUseAi:false, upcomingAppointments:[],
    },
    {
      profile: { care_profile_id:'CP2', patient_name:'คุณตาสมชาย', blood_type:'O+', gender:'male', height_cm:'168', weight_kg:'64', chronic_conditions:['ความดันโลหิตสูง'], drug_allergies:'', food_allergies:'กุ้ง', mobility_limitations:'', emergency_contact_name:'สมหญิง', emergency_contact_phone:'0833333333', family_phone:'0844444444' },
      familyRole:'caregiver', canUseAi:false, upcomingAppointments:[],
    },
  ];
  await mockBackend(page, async (url) => {
    if (url.pathname === '/config/liff') return { publicBackendUrl: SIMULATED_BACKEND_URL, familyLiffId: 'SIM_FAMILY' };
    if (url.pathname === '/api/consent/check') return { hasConsent:true };
    if (url.pathname === '/api/init-dashboard') return { profiles };
    if (url.pathname === '/api/access-requests') return { requests:[] };
    if (url.pathname === '/api/transport/family/pending') return { pending:[] };
    if (url.pathname === '/api/care-profile/CP1/caregivers') return { members:[] };
    if (url.pathname === '/api/plus/entitlement') return { status:'basic', plus:false };
    return { status:404, body:{message:`unmocked ${url.pathname}`} };
  });
  await page.setContent(localHtml('family'), { waitUntil:'domcontentloaded' });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#app')).display === 'block');
  await page.locator('[data-family-destination="health"]').first().click();
  assert.strictEqual(await page.locator('#healthProfileContent').isVisible(), true);
  assert.strictEqual(await page.locator('#healthProfileHeading').textContent(), 'ข้อมูลสุขภาพปัจจุบันของ คุณยายทองดี');
  assert.strictEqual(await page.locator('#bloodType').inputValue(), 'A+');
  assert.strictEqual(await page.locator('#drugAllergies').inputValue(), 'เพนิซิลลิน');
  await page.locator('#profileSelector').selectOption('CP2');
  await page.waitForFunction(() => document.querySelector('#healthProfileHeading').textContent.includes('คุณตาสมชาย'));
  assert.strictEqual(await page.locator('#healthProfileHeading').textContent(), 'ข้อมูลสุขภาพปัจจุบันของ คุณตาสมชาย');
  assert.strictEqual(await page.locator('#bloodType').inputValue(), 'O+');
  assert.strictEqual(await page.locator('#drugAllergies').inputValue(), '');
  assert.strictEqual(await page.locator('#foodAllergies').inputValue(), 'กุ้ง');
  assert.strictEqual(await page.locator('#chronicConditions input[value="ความดันโลหิตสูง"]').isChecked(), true);
  assert.strictEqual(await page.locator('#chronicConditions input[value="เบาหวาน"]').isChecked(), false);
  await page.close();
}

async function familyMultiProfileGroupJourney(browser) {
  const page = await browser.newPage({ viewport:{width:390,height:844} });
  const profiles = [
    {profile:{care_profile_id:'CP1',patient_name:'คุณพ่อ',created_at:'2026-08-01T00:00:00Z'},familyRole:'owner',familyGroup:{active:true,status:'active'},canUseAi:false,upcomingAppointments:[]},
    {profile:{care_profile_id:'CP2',patient_name:'คุณแม่',created_at:'2026-08-02T00:00:00Z'},familyRole:'owner',familyGroup:{active:false,status:'unbound'},canUseAi:false,upcomingAppointments:[]},
    {profile:{care_profile_id:'CP3',patient_name:'คุณตา',created_at:'2026-08-03T00:00:00Z'},familyRole:'caregiver',familyGroup:{active:false,status:'unbound'},canUseAi:false,upcomingAppointments:[]},
  ];
  await mockBackend(page, async (url, request) => {
    if (url.pathname === '/config/liff') return {publicBackendUrl:SIMULATED_BACKEND_URL,familyLiffId:'SIM_FAMILY'};
    if (url.pathname === '/api/consent/check') return {hasConsent:true};
    if (url.pathname === '/api/init-dashboard') return {profiles};
    if (url.pathname === '/api/access-requests') return {requests:[]};
    if (url.pathname === '/api/transport/family/pending') return {pending:[]};
    if (/^\/api\/care-profile\/CP\d\/caregivers$/.test(url.pathname)) return {members:[]};
    if (url.pathname === '/api/plus/entitlement') return {status:'basic',plus:false};
    if (url.pathname === '/api/care-profile/independent' && request.method() === 'POST') {
      const input=request.postDataJSON();
      const created={care_profile_id:'CP4',patient_name:input.patientName,status:'independent',created_at:'2026-08-04T00:00:00Z'};
      profiles.push({profile:created,familyRole:'owner',familyGroup:{active:false,status:'unbound'},canUseAi:false,upcomingAppointments:[]});
      return {status:201,body:created};
    }
    return {status:404,body:{message:`unmocked ${url.pathname}`}};
  });
  await page.setContent(localHtml('family'), {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#app')).display === 'block');
  await page.waitForFunction(() => document.querySelector('#familyBindingStatus').textContent === 'เชื่อมกลุ่มครอบครัวแล้ว');
  assert.equal(await page.locator('#familyBindingStatus').textContent(),'เชื่อมกลุ่มครอบครัวแล้ว');
  assert.equal(await page.locator('#familyBindingAction').evaluate((button) => button.hidden),true);

  await page.locator('#profileSelector').selectOption('CP2');
  await page.waitForFunction(() => document.querySelector('#profileSummary').textContent.includes('คุณแม่')
    && document.querySelector('#familyBindingStatus').textContent === 'ยังไม่ได้เชื่อมกลุ่มครอบครัว');
  assert.equal(await page.locator('#familyBindingStatus').textContent(),'ยังไม่ได้เชื่อมกลุ่มครอบครัว');
  assert.equal(await page.locator('#familyBindingAction').evaluate((button) => button.hidden),false);
  await page.locator('#profileSelector').selectOption('CP3');
  await page.waitForFunction(() => document.querySelector('#profileSummary').textContent.includes('คุณตา'));
  assert.equal(await page.locator('#familyBindingAction').evaluate((button) => button.hidden),true);

  await page.locator('#addCareProfileButton').click();
  await page.locator('#newProfileName').fill('คุณยาย');
  await page.locator('#createProfileButton').click();
  await page.waitForFunction(() => document.querySelector('#profileSelector').value === 'CP4');
  assert.match(await page.locator('#profileSummary').textContent(),/คุณยาย/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),true);
  await page.close();
}

async function familyConsultationJourney(browser) {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const profile={profile:{care_profile_id:'CP-CONSULT',patient_name:'คุณแม่จำลอง'},familyRole:'owner',canUseAi:false,upcomingAppointments:[]};
  await mockBackend(page,async(url,request)=>{
    if(url.pathname==='/config/liff')return {publicBackendUrl:SIMULATED_BACKEND_URL,familyLiffId:'SIM_FAMILY'};
    if(url.pathname==='/api/consent/check')return {hasConsent:true};
    if(url.pathname==='/api/init-dashboard')return {profiles:[profile]};
    if(url.pathname==='/api/access-requests')return {requests:[]};
    if(url.pathname==='/api/transport/family/pending')return {pending:[]};
    if(url.pathname==='/api/care-profile/CP-CONSULT/caregivers')return {members:[]};
    if(url.pathname==='/api/plus/entitlement')return {status:'basic',plus:false};
    if(url.pathname==='/api/consultations/eligibility')return {availability:'eligible',price:{amountMinor:10000,currency:'THB'},durationMinutes:1440,termsVersion:'consult-terms-v1',checkoutAvailable:true};
    if(url.pathname==='/api/consultations'&&request.method()==='GET')return {items:[]};
    if(url.pathname==='/api/consultations/safety'&&request.method()==='POST')return {action:'pharmacist_consultation_eligible',category:'medication_advice',reasonCode:null};
    if(url.pathname==='/api/consultations/checkout'&&request.method()==='POST')return {status:201,body:{status:'payment_pending',orderId:'ORDER-SIM',amountMinor:10000,currency:'THB',durationMinutes:1440,termsVersion:'consult-terms-v1',payment:{method:'promptpay',qrImageUrl:'https://cdn.omise.co/qr/simulated.png'}}};
    if(url.pathname==='/api/consultations/orders/ORDER-SIM/status')return {status:'payment_pending',orderId:'ORDER-SIM',amountMinor:10000,currency:'THB'};
    return {status:404,body:{message:`unmocked ${url.pathname}`}};
  });
  await page.setContent(localHtml('family'),{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!document.querySelector('#consultationPanel').hidden);
  await page.locator('[data-family-destination="consultation"]').first().click();
  await page.waitForFunction(()=>document.querySelector('#view-services').classList.contains('active'));
  assert.match(await page.locator('#consultationPatient').textContent(),/คุณแม่จำลอง/);
  await page.locator('#consultationEntry').click();
  await page.locator('#consultationQuestion').fill('ควรหยุดยานี้ไหม');
  await page.locator('#consultationCheckButton').click();
  await page.waitForFunction(()=>!document.querySelector('#consultationTerms').hidden);
  assert.match(await page.locator('#consultationTerms').textContent(),/100 บาท/);
  assert.strictEqual(await page.locator('#consultationContinueButton').isDisabled(),true);
  await page.locator('#consultationTermsCheck').check();
  await page.locator('#consultationContinueButton').click();
  await page.waitForFunction(()=>!document.querySelector('#consultationPayment').hidden);
  assert.match(await page.locator('#consultationPayment').textContent(),/สแกน QR.*100 บาท/);
  assert.strictEqual(await page.locator('#consultationPaymentQr').isVisible(),true);
  assert.match(await page.locator('#consultationPaymentQr').getAttribute('src'),/^https:\/\//);
  await page.close();
}

async function familyLabResultsJourney(browser) {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const profile={profile:{care_profile_id:'CP-LAB',patient_name:'คุณแม่ผลตรวจ'},familyRole:'owner',canUseAi:false,upcomingAppointments:[]};
  const correctionDraft={reportId:'LABR-SIM-V2',status:'draft',hospitalName:'โรงพยาบาลจำลอง',laboratoryName:'ห้องตรวจตัวอย่าง',specimenCollectedAt:'2026-08-20T08:00:00Z',reportedAt:'2026-08-20T09:00:00Z',observations:[{observationId:'LABO-SIM-V2',analyteNameSource:'HbA1c',sourceValueText:'6.5',sourceUnit:'%',referenceRangeText:'4.0-6.0',abnormalFlagSource:'H',specimenSource:'Whole blood',methodSource:'HPLC'}]};
  let correctionConfirmed=false;
  await mockBackend(page,async(url,request)=>{
    if(url.pathname==='/config/liff')return {publicBackendUrl:SIMULATED_BACKEND_URL,familyLiffId:'SIM_FAMILY'};
    if(url.pathname==='/api/consent/check')return {hasConsent:true};
    if(url.pathname==='/api/init-dashboard')return {profiles:[profile]};
    if(url.pathname==='/api/access-requests')return {requests:[]};
    if(url.pathname==='/api/transport/family/pending')return {pending:[]};
    if(url.pathname==='/api/care-profile/CP-LAB/caregivers')return {members:[]};
    if(url.pathname==='/api/plus/entitlement')return {status:'basic',plus:false};
    if(url.pathname==='/api/care-profile/CP-LAB/lab-reports'&&request.method()==='GET')return {items:[{reportId:'LABR-SIM',status:'confirmed',hospitalName:'โรงพยาบาลจำลอง',specimenCollectedAt:'2026-08-20T08:00:00Z',mutationCapabilities:{canCreateCorrection:true,canVoid:true}}],nextCursor:null};
    if(url.pathname==='/api/care-profile/CP-LAB/lab-reports/LABR-SIM/corrections'&&request.method()==='POST')return correctionDraft;
    if(url.pathname==='/api/care-profile/CP-LAB/lab-reports/LABR-SIM-V2/draft'&&request.method()==='PATCH')return correctionDraft;
    if(url.pathname==='/api/care-profile/CP-LAB/lab-reports/LABR-SIM-V2/confirm'&&request.method()==='POST'){correctionConfirmed=true;return {...correctionDraft,status:'confirmed',versionNo:2,isCurrent:true};}
    if(url.pathname==='/api/care-profile/CP-LAB/lab-reports/LABR-SIM')return {reportId:'LABR-SIM',status:'confirmed',hospitalName:'โรงพยาบาลจำลอง',specimenCollectedAt:'2026-08-20T08:00:00Z',mutationCapabilities:{canCreateCorrection:true,canVoid:true},observations:[{observationId:'LABO-SIM',analyteNameSource:'HbA1c',sourceValueText:'6.5',sourceUnit:'%',referenceRangeText:'4.0-6.0',abnormalFlagSource:'H',specimenSource:'Whole blood',methodSource:'HPLC',comparisonKey:'hba1c'}]};
    if(url.pathname==='/api/care-profile/CP-LAB/lab-trends')return {status:'available',sourceDisplayName:'HbA1c',direction:'increased',rangesDiffer:false,observations:[{specimenCollectedAt:'2026-01-20T08:00:00Z',sourceValueText:'6.1',sourceUnit:'%',referenceRangeText:'4.0-6.0'},{specimenCollectedAt:'2026-08-20T08:00:00Z',sourceValueText:'6.5',sourceUnit:'%',referenceRangeText:'4.0-6.0'}]};
    if(url.pathname==='/api/care-profile/CP-LAB/lab-explanations'&&request.method()==='POST')return {status:'answer',summary:'สรุปค่าที่ได้รับการยืนยัน',testExplanation:'การตรวจนี้ใช้ติดตามค่าตามรายงาน',confirmedFacts:[{observedAt:'2026-08-20T08:00:00Z',analyteNameSource:'HbA1c',sourceValueText:'6.5',sourceUnit:'%'}],trendExplanation:'ค่าตัวเลขเพิ่มขึ้นตามลำดับเวลา',rangeCaveat:null,questionsForClinician:['ควรติดตามเมื่อใด'],safetyNotice:'ควรพิจารณาร่วมกับข้อมูลอื่น',disclaimer:'ไม่ใช่การวินิจฉัย'};
    return {status:404,body:{message:`unmocked ${url.pathname}`}};
  });
  await page.setContent(localHtml('family'),{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!document.querySelector('#labResultsPanel').hidden);
  await page.locator('[data-family-destination="lab"]').first().click();
  await page.waitForFunction(()=>document.querySelector('#view-services').classList.contains('active'));
  assert.match(await page.locator('#labResultsPatient').textContent(),/คุณแม่ผลตรวจ/);
  await page.locator('#labResultsEntry').click();
  await page.waitForFunction(()=>document.querySelector('#labHistoryList').textContent.includes('โรงพยาบาลจำลอง'));
  await page.getByRole('button',{name:'ดูรายละเอียดผลตรวจ'}).click();
  await page.waitForFunction(()=>document.querySelector('#labReportDetail').textContent.includes('HbA1c'));
  assert.match(await page.locator('#labReportDetail').textContent(),/ตามรายงานต้นฉบับ: H/);
  await page.getByRole('button',{name:'ดูแนวโน้มอย่างปลอดภัย'}).click();
  await page.waitForFunction(()=>document.querySelector('#labTrendResult').textContent.includes('เพิ่มขึ้น'));
  assert.doesNotMatch(await page.locator('#labTrendResult').textContent(),/ดีขึ้น|แย่ลง/);
  await page.getByRole('button',{name:'ให้พี่หมอช่วยอธิบาย'}).click();
  await page.waitForFunction(()=>document.querySelector('#labExplanationResult').textContent.includes('สรุปค่าที่ได้รับการยืนยัน'));
  assert.match(await page.locator('#labExplanationResult').textContent(),/ไม่ใช่การวินิจฉัย/);
  await page.getByRole('button',{name:'สร้างฉบับแก้ไข'}).click();
  await page.waitForFunction(()=>document.querySelector('.clinical-action-dialog')?.hidden===false);
  const target=await page.locator('.clinical-action-dialog__actions button:last-child').evaluate((button)=>{const box=button.getBoundingClientRect();const hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);return{hit:hit===button,height:box.height,z:Number(getComputedStyle(document.querySelector('.clinical-action-dialog')).zIndex),toastPointer:getComputedStyle(document.querySelector('#toast')).pointerEvents};});
  assert.equal(target.hit,true);assert.ok(target.height>=44);assert.ok(target.z>99);assert.equal(target.toastPointer,'none');
  await page.locator('.clinical-action-dialog__reason').fill('แก้ไขค่าตามรายงานที่ตรวจทานแล้ว');
  await page.locator('.clinical-action-dialog__actions button:last-child').click();
  await page.waitForFunction(()=>document.querySelector('.lab-correction-editor'));
  assert.match(await page.locator('.lab-correction-editor').textContent(),/ตรวจฉบับแก้ไข/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
  await page.getByRole('button',{name:'ยืนยันฉบับแก้ไข'}).click();
  await page.waitForFunction(()=>document.querySelector('#labResultsLive').textContent.includes('ยืนยันผลตรวจฉบับแก้ไขแล้ว'));
  assert.equal(correctionConfirmed,true);
  await page.close();
}

async function centerFamilyLinkingJourney(browser) {
  const centerPage=await browser.newPage({viewport:{width:390,height:844}});
  let centerLinkCreates=0;
  await mockBackend(centerPage,async(url,request)=>{
    if(url.pathname==='/config/liff')return{publicBackendUrl:SIMULATED_BACKEND_URL,centerAdminLiffId:'SIM_CENTER'};
    if(url.pathname==='/api/center/me')return{centers:[{center_id:'CTR1',name:'ศูนย์ตัวอย่าง',myRole:'owner',status:'active',subscription:{allowed:true,remainingDays:30}}]};
    if(url.pathname==='/api/residents')return{residents:[]};
    if(url.pathname==='/api/center/appointments')return{appointments:[]};
    if(url.pathname==='/api/center/care-profile-link-requests'&&request.method()==='POST'){
      centerLinkCreates+=1;return{status:201,body:{linkUrl:'https://liff.line.me/SIM_FAMILY?centerLink=fictional-review-token',expiresAt:'2026-09-05T12:00:00.000Z'}};
    }
    return{status:404,body:{message:`unmocked ${url.pathname}`}};
  });
  await centerPage.setContent(localHtml('center-admin'),{waitUntil:'domcontentloaded'});
  await centerPage.waitForFunction(()=>document.querySelector('#centerNameLabel').textContent.includes('ศูนย์ตัวอย่าง'));
  const existingChoice=centerPage.getByRole('button',{name:/เชื่อม Care Profile ที่มีอยู่แล้ว/});
  const newChoice=centerPage.getByRole('button',{name:/สร้าง Care Profile ใหม่/}).first();
  assert.equal(await existingChoice.isVisible(),true);
  assert.equal(await newChoice.isVisible(),true);
  await existingChoice.click();
  assert.equal(await centerPage.locator('#existingProfileLinkPanel').isVisible(),true);
  assert.equal(await centerPage.locator('#newCareProfilePanel').isHidden(),true);
  assert.equal(await centerPage.locator('#existingProfileLinkPanel input').count(),0);
  await centerPage.getByRole('button',{name:'สร้างลิงก์เชื่อม Care Profile'}).click();
  await centerPage.waitForFunction(()=>document.querySelector('#existingProfileLinkResult').textContent.includes('7 วัน'));
  assert.equal(centerLinkCreates,1);
  const centerMobile=await centerPage.evaluate(()=>({
    overflow:document.documentElement.scrollWidth<=document.documentElement.clientWidth,
    choiceHeight:document.querySelector('.onboarding-choice').getBoundingClientRect().height,
    toastPointer:getComputedStyle(document.querySelector('#toast')).pointerEvents,
    toastZ:Number(getComputedStyle(document.querySelector('#toast')).zIndex),
    modalZ:Number(getComputedStyle(document.querySelector('.modal-bg')).zIndex),
  }));
  assert.equal(centerMobile.overflow,true);assert.ok(centerMobile.choiceHeight>=44);
  assert.equal(centerMobile.toastPointer,'none');assert.ok(centerMobile.modalZ>centerMobile.toastZ);
  await centerPage.close();

  const familyPage=await browser.newPage({viewport:{width:390,height:844}});
  const profiles=[
    {profile:{care_profile_id:'CP1',patient_name:'ป้าศรี',status:'independent'},familyRole:'owner',familyGroup:{active:false,status:'unbound'},canUseAi:false,upcomingAppointments:[]},
    {profile:{care_profile_id:'CP2',patient_name:'คุณพ่อ',status:'independent'},familyRole:'owner',familyGroup:{active:false,status:'unbound'},canUseAi:false,upcomingAppointments:[]},
    {profile:{care_profile_id:'CP3',patient_name:'คุณตา',status:'independent'},familyRole:'caregiver',familyGroup:{active:false,status:'unbound'},canUseAi:false,upcomingAppointments:[]},
  ];
  let pending=true;let responseCount=0;let responseBody=null;
  await mockBackend(familyPage,async(url,request)=>{
    if(url.pathname==='/config/liff')return{publicBackendUrl:SIMULATED_BACKEND_URL,familyLiffId:'SIM_FAMILY'};
    if(url.pathname==='/api/consent/check')return{hasConsent:true};
    if(url.pathname==='/api/init-dashboard')return{profiles};
    if(url.pathname==='/api/access-requests')return{requests:pending?[{requestId:'AR1',requestKind:'anonymous_existing_profile_link',status:'pending',centerName:'ศูนย์ตัวอย่าง',centerAddress:'กรุงเทพฯ',centerPhone:'02-000-0000',expiresAt:'2026-09-05T12:00:00.000Z',eligibleProfiles:[{careProfileId:'CP1',patientName:'ป้าศรี'},{careProfileId:'CP2',patientName:'คุณพ่อ'}]}]:[]};
    if(url.pathname==='/api/access-requests/AR1/respond'&&request.method()==='POST'){
      responseCount+=1;responseBody=request.postDataJSON();pending=false;return{ok:true,status:'approved',careProfileId:responseBody.careProfileId,residentId:'R1'};
    }
    if(url.pathname==='/api/transport/family/pending')return{pending:[]};
    if(/^\/api\/care-profile\/CP\d\/caregivers$/.test(url.pathname))return{members:[]};
    if(url.pathname==='/api/plus/entitlement')return{status:'basic',plus:false};
    return{status:404,body:{message:`unmocked ${url.pathname}`}};
  });
  await familyPage.setContent(localHtml('family'),{waitUntil:'domcontentloaded'});
  await familyPage.waitForFunction(()=>getComputedStyle(document.querySelector('#app')).display==='block');
  await familyPage.locator('[data-family-destination="access"]').first().click();
  await familyPage.waitForSelector('[data-access-request="AR1"]');
  assert.equal(await familyPage.locator('.access-profile-option').count(),2);
  assert.doesNotMatch(await familyPage.locator('#accessRequestList').textContent(),/คุณตา/);
  await familyPage.getByRole('button',{name:'กลับ / ปิด'}).click();
  assert.equal(responseCount,0,'close/back must not mutate the request');
  assert.equal(await familyPage.locator('#view-home').isVisible(),true);
  await familyPage.locator('[data-family-destination="access"]').first().click();
  await familyPage.locator('input[value="CP2"]').check();
  const confirm=familyPage.getByRole('button',{name:'ยืนยันเชื่อม'});
  await confirm.scrollIntoViewIfNeeded();
  const familyMobile=await confirm.evaluate((button)=>({
    height:button.getBoundingClientRect().height,
    hit:document.elementFromPoint(button.getBoundingClientRect().left+button.getBoundingClientRect().width/2,button.getBoundingClientRect().top+button.getBoundingClientRect().height/2)===button,
    overflow:document.documentElement.scrollWidth<=document.documentElement.clientWidth,
    toastPointer:getComputedStyle(document.querySelector('#toast')).pointerEvents,
    toastZ:Number(getComputedStyle(document.querySelector('#toast')).zIndex),
    modalZ:Number(getComputedStyle(document.querySelector('#confirmActionModal')).zIndex),
  }));
  assert.ok(familyMobile.height>=44);assert.equal(familyMobile.hit,true);assert.equal(familyMobile.overflow,true);
  assert.equal(familyMobile.toastPointer,'none');assert.ok(familyMobile.modalZ>familyMobile.toastZ);
  await confirm.click();
  await familyPage.waitForFunction(()=>!document.querySelector('[data-access-request="AR1"]'));
  assert.equal(responseCount,1);assert.deepEqual(responseBody,{approved:true,careProfileId:'CP2'});
  assert.deepEqual(await familyPage.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage),query:location.search})),{local:[],session:[],query:''});
  await familyPage.close();
}

async function centerPendingJourney(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mockBackend(page, async (url) => {
    if (url.pathname === '/config/liff') return { publicBackendUrl:SIMULATED_BACKEND_URL, centerAdminLiffId:'SIM_CENTER' };
    if (url.pathname === '/api/center/me') return { centers: [{ center_id:'CTR1', name:'ศูนย์จำลอง', myRole:'owner', status:'active', subscription:{allowed:true,remainingDays:30} }] };
    if (url.pathname === '/api/residents') return { residents: [] };
    if (url.pathname === '/api/center/appointments') return { appointments: [] };
    if (url.pathname === '/api/transport/pending') return { pending: [] };
    return { status: 404, body: { message: `unmocked ${url.pathname}` } };
  });
  await page.setContent(localHtml('center-admin'), { waitUntil: 'domcontentloaded' });
  await page.locator('.tab[data-view="transport"]').click();
  await page.waitForSelector('#transportList .empty');
  assert.strictEqual((await page.locator('#transportList').textContent()).trim(), 'ไม่มีรายการรอดำเนินการ');
  assert.ok(!(await page.locator('#toast').textContent()).includes('ผิดพลาด'));
  await page.close();
}

async function centerPendingFailureIsVisible(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mockBackend(page, async (url) => {
    if (url.pathname === '/config/liff') return { publicBackendUrl:SIMULATED_BACKEND_URL, centerAdminLiffId:'SIM_CENTER' };
    if (url.pathname === '/api/center/me') return { centers: [{ center_id:'CTR1', name:'ศูนย์จำลอง', myRole:'owner', status:'active', subscription:{allowed:true,remainingDays:30} }] };
    if (url.pathname === '/api/residents') return { residents: [] };
    if (url.pathname === '/api/center/appointments') return { appointments: [] };
    if (url.pathname === '/api/transport/pending') return { status:500, body:{ message:'ระบบเดินทางจำลองขัดข้อง' } };
    return { status:404, body:{ message:`unmocked ${url.pathname}` } };
  });
  await page.setContent(localHtml('center-admin'), { waitUntil:'domcontentloaded' });
  await page.locator('.tab[data-view="transport"]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('ระบบเดินทางจำลองขัดข้อง'));
  assert.match(await page.locator('#toast').textContent(), /ระบบเดินทางจำลองขัดข้อง/);
  await page.close();
}

async function registerJourney(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mockBackend(page, async (url) => {
    if (url.pathname === '/config/liff') return { registerLiffId: 'SIM_REGISTER' };
    if (url.pathname === '/api/external/register-center') return { success:true, centerId:'CTR1' };
    return { status:404, body:{ message:`unmocked ${url.pathname}` } };
  });
  await page.setContent(localHtml('register'), { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'ยืนยันเปิดศูนย์' }).click();
  assert.match(await page.locator('#status').textContent(), /กรุณากรอก/);
  await page.locator('#centerName').fill('ศูนย์จำลอง');
  await page.locator('#address').fill('กรุงเทพฯ');
  await page.locator('#contactPhone').fill('0812345678');
  await page.getByRole('button', { name: 'ยืนยันเปิดศูนย์' }).click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('ลงทะเบียนศูนย์แล้ว'));
  await page.close();
}

async function adminSubscriptionJourney(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let saved = false;
  const center = { centerId:'CTR1',name:'ศูนย์จำลอง',ownerLineId:'U_OWNER',status:'active',address:'กรุงเทพฯ',activeResidentCount:1,subscriptionStartAt:null,subscriptionEndAt:null,packageType:null,subscription:{allowed:false,code:'subscription_unconfigured'} };
  await mockBackend(page, async (url, request) => {
    if (url.pathname === '/config/liff') return { systemAdminLiffId:'SIM_ADMIN' };
    if (url.pathname === '/api/admin/centers' && request.method()==='GET') return { centers:[center] };
    if (url.pathname === '/api/admin/centers/CTR1/subscription') { saved=true; center.subscriptionStartAt='2030-01-01';center.subscriptionEndAt='2030-12-31';center.packageType='annual';center.subscription={allowed:true,remainingDays:365}; return { ok:true }; }
    return { status:404, body:{message:`unmocked ${url.pathname}`} };
  });
  await page.setContent(localHtml('system-admin'), { waitUntil:'domcontentloaded' });
  await page.waitForSelector('#app:not([hidden])');
  await page.getByRole('button', { name:'ปรับสิทธิ' }).click();
  await page.locator('#subscriptionStart').fill('2030-12-31');
  await page.locator('#subscriptionEnd').fill('2030-01-01');
  await page.locator('#subscriptionSaveButton').click();
  assert.match(await page.locator('#subscriptionError').textContent(), /ต้องอยู่หลัง/);
  await page.locator('#subscriptionStart').fill('2030-01-01');
  await page.locator('#subscriptionEnd').fill('2030-12-31');
  await page.locator('#subscriptionSaveButton').click();
  await page.waitForFunction(() => !document.querySelector('#subscriptionDialog').open);
  assert.strictEqual(saved, true);
  await page.close();
}

async function clinicalCorrectionVoidJourney(browser) {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--navy:#17315d;--teal:#237b78;--gray:#667085}*{box-sizing:border-box}body{margin:0;padding:12px;font-family:Arial,sans-serif}.btn{min-height:44px;border-radius:10px;padding:10px 12px}</style><style>${CLINICAL_ACTION_DIALOG_CSS}</style><style>${CENTER_CARE_RECORDING_CSS}</style><div id="centerCareRoot"></div><div id="toast" style="position:fixed;z-index:99;pointer-events:none"></div><script>${CLINICAL_ACTION_DIALOG_SOURCE}</script><script>${CENTER_CARE_RECORDING_SOURCE}</script>`);
  await page.evaluate(()=>{
    const nativeVital={vitalSetId:'VS-NATIVE',status:'recorded',careRecipientName:'คุณยายตัวอย่าง',occurredAt:'2026-08-27T07:30:00+07:00',sourceType:'center_native',observations:[{measurementType:'temperature',sourceValueText:'36.7',sourceUnit:'Cel'}],mutationCapabilities:{canVoid:true}};
    const externalVital={vitalSetId:'VS-EXTERNAL',status:'recorded',careRecipientName:'คุณตาตัวอย่าง',occurredAt:'2026-08-27T08:00:00+07:00',sourceType:'external_integration',observations:[{measurementType:'pulse',sourceValueText:'72',sourceUnit:'/min'}],mutationCapabilities:{canVoid:false}};
    const lab={reportId:'LAB-NATIVE',status:'confirmed',isCurrent:true,hospitalName:'โรงพยาบาลตัวอย่าง',specimenCollectedAt:'2026-08-26T09:00:00+07:00',mutationCapabilities:{canCreateCorrection:true,canVoid:true}};
    const daily={dailyReportId:'DAILY-NATIVE',status:'finalized',isCurrent:true,careRecipientName:'คุณยายตัวอย่าง',careDate:'2026-08-27',shift:{code:'day',sourceLabel:'กลางวัน'},sourceType:'center_native',mutationCapabilities:{canCreateCorrection:true,canVoid:true}};
    const api=async(path)=>{
      if(path.includes('/lab-reports'))return{items:[lab],nextCursor:null};
      if(path.includes('/vital-signs/history'))return{items:[nativeVital,externalVital],nextCursor:null};
      if(path.includes('status=finalized'))return{items:[daily]};
      if(path.includes('/daily-care/review'))return{items:[]};
      return{};
    };
    const view=window.PhimorCenterCareUI.mount({root:document.querySelector('#centerCareRoot'),api,notify:()=>{},onVisibility:()=>{}});
    view.setContext({centerId:'CTR-1',role:'manager',residents:[{resident_id:'RES-1',care_profile_id:'CP-1',full_name:'คุณยายตัวอย่าง',room:'A101'}],capabilities:{vital_signs_v1:true,daily_care_v1:true}});
    const labResident=document.querySelector('#centerLabResident');labResident.value='RES-1';labResident.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(()=>document.querySelector('#centerLabHistory')?.textContent.includes('โรงพยาบาลตัวอย่าง')&&document.querySelector('#centerVitalHistory')?.textContent.includes('คุณยายตัวอย่าง')&&document.querySelector('#centerDailyHistory')?.textContent.includes('ฉบับปัจจุบัน'));
  assert.equal(await page.locator('[data-clinical-action="void-vital"]').count(),1);
  assert.match(await page.locator('#centerVitalHistory').textContent(),/ข้อมูลจากระบบศูนย์/);
  assert.equal(await page.locator('[data-clinical-action="correct-lab"]').count(),1);
  assert.equal(await page.locator('[data-clinical-action="correct-daily"]').count(),1);
  const targetButton=page.locator('[data-clinical-action="void-vital"]');
  assert.ok((await targetButton.boundingBox()).height>=44);
  await targetButton.click();
  await page.waitForFunction(()=>document.querySelector('.clinical-action-dialog')?.hidden===false);
  const targeting=await page.locator('.clinical-action-dialog__actions button:last-child').evaluate((button)=>{const box=button.getBoundingClientRect();return{hit:document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)===button,height:box.height,textarea:document.querySelector('.clinical-action-dialog__reason').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth<=document.documentElement.clientWidth};});
  assert.deepEqual(targeting,{hit:true,height:46,textarea:112,overflow:true});
  await page.locator('.clinical-action-dialog__actions button:first-child').click();
  await page.close();
}

async function familyCareHistoryJourney(browser) {
  const page = await browser.newPage({ viewport:{width:390,height:844} });
  const profile = { profile:{care_profile_id:'CP-CARE',patient_name:'คุณแม่ตัวอย่าง'},familyRole:'owner',canUseAi:false,upcomingAppointments:[] };
  await mockBackend(page, async (url) => {
    if (url.pathname === '/config/liff') return {publicBackendUrl:SIMULATED_BACKEND_URL,familyLiffId:'SIM_FAMILY'};
    if (url.pathname === '/api/consent/check') return {hasConsent:true};
    if (url.pathname === '/api/init-dashboard') return {profiles:[profile]};
    if (url.pathname === '/api/access-requests') return {requests:[]};
    if (url.pathname === '/api/transport/family/pending') return {pending:[]};
    if (url.pathname === '/api/care-profile/CP-CARE/caregivers') return {members:[]};
    if (url.pathname === '/api/plus/entitlement') return {status:'basic',plus:false};
    if (url.pathname === '/api/care-profile/CP-CARE/vital-signs') return {items:[{vitalSetId:'VS-1',status:'recorded',occurredAt:'2026-08-27T07:30:00+07:00',recordedAt:'2026-08-27T07:31:00+07:00',centerName:'ศูนย์ตัวอย่าง',sourceType:'external_integration',observations:[{measurementType:'blood_glucose',numericValue:108,sourceValueText:'108',sourceUnit:'mg/dL',context:'before_meal'},{measurementType:'weight',numericValue:55.2,sourceValueText:'55.2',sourceUnit:'kg'}]}],nextCursor:null};
    if (url.pathname === '/api/care-profile/CP-CARE/daily-care') return {items:[{dailyReportId:'DC-1',status:'finalized',occurredAt:'2026-08-27T19:00:00+07:00',careDate:'2026-08-27',shift:{code:'day',sourceLabel:'Day'},finalizedAt:'2026-08-27T20:00:00+07:00',centerName:'ศูนย์ตัวอย่าง',sourceType:'external_integration',recorderDisplayName:'ผู้ดูแลตัวอย่าง',items:[{itemType:'nutrition',valueType:'text',textValue:'รับประทานอาหารได้ครึ่งจาน'}],vitalSigns:[]}],nextCursor:null};
    return {status:404,body:{message:`unmocked ${url.pathname}`}};
  });
  await page.setContent(localHtml('family'), {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#app')).display === 'block');
  await page.locator('[data-family-destination="health"]').first().click();
  await page.waitForFunction(() => document.querySelector('#familyLatestVital').textContent.includes('108'));
  assert.match(await page.locator('#familyLatestVital').textContent(), /น้ำตาลในเลือด/);
  assert.match(await page.locator('#familyLatestVital').textContent(), /ก่อนอาหาร/);
  assert.match(await page.locator('#familyLatestVital').textContent(), /55.2 kg/);
  await page.locator('#familyDailyHistoryButton').click();
  assert.match(await page.locator('#familyCareHistoryList').textContent(), /รับประทานอาหารได้ครึ่งจาน/);
  await page.getByRole('button',{name:'ดูรายละเอียด'}).first().click();
  assert.match(await page.locator('#familyCareHistoryList').textContent(), /ผู้บันทึก: ผู้ดูแลตัวอย่าง/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.close();
}

async function familyTransportChoiceJourney(browser) {
  const page = await browser.newPage({ viewport:{width:390,height:844} });
  const profile = { profile:{care_profile_id:'CP-TRANSPORT',patient_name:'คุณยายอิสระ'},familyRole:'owner',canUseAi:false,upcomingAppointments:[] };
  let unresolved = true; let attempts = 0;
  await mockBackend(page, async (url, request) => {
    if (url.pathname === '/config/liff') return {publicBackendUrl:SIMULATED_BACKEND_URL,familyLiffId:'SIM_FAMILY'};
    if (url.pathname === '/api/consent/check') return {hasConsent:true};
    if (url.pathname === '/api/init-dashboard') return {profiles:[profile]};
    if (url.pathname === '/api/access-requests') return {requests:[]};
    if (url.pathname === '/api/care-profile/CP-TRANSPORT/caregivers') return {members:[]};
    if (url.pathname === '/api/plus/entitlement') return {status:'basic',plus:false};
    if (url.pathname === '/api/plus/offer') return {priceMinor:5900,durationDays:30,autoRenew:false};
    if (url.pathname === '/api/plus/orders/current') return {status:'none'};
    if (url.pathname === '/api/consultations/eligibility') return {availability:'unavailable'};
    if (url.pathname === '/api/transport/family/pending') return {pending:unresolved?[{plan_id:'TP-INDEPENDENT',care_profile_id:'CP-TRANSPORT',center_id:null,appointment:{hospital:'โรงพยาบาลตัวอย่าง',datetime:'2026-09-02T09:00:00+07:00'}}]:[]};
    if (url.pathname === '/api/transport/TP-INDEPENDENT/family-choice' && request.method() === 'POST') {
      attempts += 1;
      if (attempts === 1) return {status:503,body:{message:'internal provider detail must not surface'}};
      unresolved = false; return {body:{ok:true,status:'family_handled'}};
    }
    return {status:404,body:{message:`unmocked ${url.pathname}`}};
  });
  await page.setContent(localHtml('family'), {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#app')).display === 'block');
  await page.waitForFunction(() => document.querySelector('#pendingTransportList').textContent.includes('ยังไม่ได้เชื่อมศูนย์'));
  assert.match(await page.locator('#pendingTransportList').textContent(), /ยังไม่ได้เชื่อมศูนย์/);
  await page.getByRole('button',{name:'ไปเอง'}).click();
  await page.waitForFunction(() => document.querySelector('#confirmActionModal').classList.contains('show'));
  const targeting = await page.locator('#confirmActionButton').evaluate((button) => {
    const box=button.getBoundingClientRect();const hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);
    return {hitId:hit?.id,toastPointerEvents:getComputedStyle(document.querySelector('#toast')).pointerEvents,modalZ:Number(getComputedStyle(document.querySelector('#confirmActionModal')).zIndex),toastZ:Number(getComputedStyle(document.querySelector('#toast')).zIndex)};
  });
  assert.deepEqual(targeting,{hitId:'confirmActionButton',toastPointerEvents:'none',modalZ:100,toastZ:99});
  await page.getByRole('button',{name:'ยืนยันตัวเลือก'}).click();
  await page.waitForFunction(() => document.querySelector('#confirmActionMessage').textContent.includes('บันทึกวิธีเดินทางไม่สำเร็จ'));
  assert.equal(attempts,1);
  assert.equal(await page.locator('#confirmActionButton').isEnabled(),true);
  assert.equal(await page.locator('#confirmActionCancelButton').isEnabled(),true);
  assert.doesNotMatch(await page.locator('#confirmActionModal').textContent(),/internal provider detail/);
  await page.getByRole('button',{name:'ยืนยันตัวเลือก'}).click();
  await page.waitForFunction(() => !document.querySelector('#confirmActionModal').classList.contains('show'));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#transportDecisionCard')).display === 'none');
  assert.equal(attempts,2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),true);
  await page.close();
}

async function adminCareOperationsJourney(browser) {
  const page = await browser.newPage({ viewport:{width:390,height:844} }); let mapped = 0; let reconciled = 0;
  await page.on('dialog', (dialog) => dialog.accept());
  await mockBackend(page, async (url, request) => {
    if (url.pathname === '/config/liff') return {systemAdminLiffId:'SIM_ADMIN'};
    if (url.pathname === '/api/admin/centers') return {centers:[]};
    if (url.pathname === '/api/admin/platform/organizations') return {organizations:[{organizationId:'ORG-A',displayName:'องค์กรตัวอย่าง',organizationType:'external_care_center',status:'active'}]};
    if (url.pathname === '/api/admin/platform/organizations/ORG-A/centers') return {centers:[{centerId:'CTR-A',name:'ศูนย์ตัวอย่าง',status:'active'}]};
    if (url.pathname === '/api/admin/platform/centers/CTR-A/capabilities') return {capabilities:[{centerId:'CTR-A',capabilityKey:'vital_signs_v1',enabled:true},{centerId:'CTR-A',capabilityKey:'daily_care_v1',enabled:false}]};
    if (url.pathname === '/api/admin/platform/organizations/ORG-A/integration-clients') return {integrationClients:[{integrationClientId:'INT-A',displayName:'Vendor ตัวอย่าง',status:'active'}]};
    if (url.pathname === '/api/admin/platform/integration-clients/INT-A') return {integrationClient:{integrationClientId:'INT-A',displayName:'Vendor ตัวอย่าง',status:'active',sourceSystem:'vendor_demo',centers:[{center_id:'CTR-A'}],eventScopes:['care.daily_report.finalized'],credentials:[{status:'active',lastUsedAt:'2026-08-27T08:00:00Z'}]}};
    if (url.pathname === '/api/admin/platform/pending-subjects') return mapped ? {items:[]} : {items:[{integrationClientId:'INT-A',organizationId:'ORG-A',centerId:'CTR-A',externalCenterId:'EXT-C',externalResidentId:'EXT-R',displayName:'คุณยายตัวอย่าง',room:'A201',eventCount:2,firstReceivedAt:'2026-08-27T07:00:00Z'}]};
    if (url.pathname === '/api/admin/platform/integration-events/status') return {items:[{integrationEventId:'IEVT-1',integrationClientId:'INT-A',organizationId:'ORG-A',centerId:'CTR-A',externalResidentId:'EXT-R',expectedLineGroupId:'C123…7890',verifiedLineGroupId:'C999…0000',groupReconciliationStatus:reconciled?'verified_match':'group_binding_mismatch'}]};
    if (url.pathname === '/api/admin/platform/centers/CTR-A/resident-options') return {residents:[{residentId:'RES-A',displayName:'คุณยายตัวอย่าง',room:'A201',careProfileLinked:true}]};
    if (url.pathname === '/api/admin/platform/pending-subjects/map' && request.method() === 'POST') { mapped += 1; return {mapping:{status:'mapped'},reprocessed:{processed:2}}; }
    if (url.pathname === '/api/admin/platform/integration-events/IEVT-1/reconcile-group') { reconciled += 1; return {groupReconciliationStatus:'verified_match',notificationIntentStatus:'queued'}; }
    return {status:404,body:{message:`unmocked ${url.pathname}`}};
  });
  await page.setContent(localHtml('system-admin'), {waitUntil:'domcontentloaded'}); await page.waitForSelector('#app:not([hidden])');
  assert.match(await page.locator('#careOperationsContent').textContent(), /สัญญาณชีพ/);
  await page.getByRole('button',{name:'ผู้พักรอเชื่อม'}).click(); await page.getByRole('button',{name:'เชื่อมผู้พัก'}).click();
  await page.locator('select[aria-label="เลือกผู้พักที่ต้องการเชื่อม"]').selectOption('RES-A'); await page.getByRole('button',{name:'ยืนยันเชื่อมผู้พัก'}).click();
  await page.waitForFunction(() => document.querySelector('#careOperationsContent').textContent.includes('ไม่มีผู้พักรอเชื่อม')); assert.equal(mapped,1);
  await page.getByRole('button',{name:'กลุ่ม LINE'}).click(); assert.match(await page.locator('#careOperationsContent').textContent(), /MISMATCH/);
  await page.getByRole('button',{name:'ตรวจสอบอีกครั้ง'}).click(); await page.waitForFunction(() => document.querySelector('#careOperationsContent').textContent.includes('VERIFIED')); assert.equal(reconciled,1);
  assert.doesNotMatch(await page.locator('#careOperationsPanel').textContent(), /send anyway|ส่งต่อไปเลย/i); await page.close();
}

async function pharmacistConsoleJourney(browser) {
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await mockBackend(page,async(url,request)=>{
    if(url.pathname==='/config/liff')return {publicBackendUrl:SIMULATED_BACKEND_URL,pharmacistLiffId:'SIM_PHARMACIST'};
    if(url.pathname==='/api/pharmacist/consultations/queue')return {items:[{caseId:'CASE-Q',queuedAt:'2026-08-25T00:00:00Z',topicCategory:'medication_advice',triageCategory:'pharmacist_consultation_eligible',waitingSeconds:300}],hasMore:false,nextCursor:null};
    if(url.pathname==='/api/pharmacist/consultations/active')return {items:[{caseId:'CASE-1',state:'active',waitingOn:'pharmacist',remainingSeconds:3600,effectiveClosed:false}]};
    if(url.pathname==='/api/pharmacist/consultations/CASE-Q/accept'&&request.method()==='POST')return {caseId:'CASE-Q',state:'active',waitingOn:'pharmacist',acceptedAt:'2026-08-25T00:00:00Z',expiresAt:'2026-08-26T00:00:00Z',remainingSeconds:3600,effectiveClosed:false};
    if(url.pathname==='/api/pharmacist/consultations/CASE-Q')return {caseId:'CASE-Q',state:'active',waitingOn:'pharmacist',acceptedAt:'2026-08-25T00:00:00Z',expiresAt:'2026-08-26T00:00:00Z',remainingSeconds:3600,effectiveClosed:false};
    if(url.pathname==='/api/pharmacist/consultations/CASE-Q/messages')return {items:[],nextSequence:0,hasMore:false};
    return {status:404,body:{message:`unmocked ${url.pathname}`}};
  });
  await page.setContent(localHtml('pharmacist'),{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!document.querySelector('#consoleApp').hidden);
  assert.strictEqual(await page.locator('.case-column').isVisible(),true);
  assert.strictEqual(await page.locator('.chat-column').isVisible(),true);
  assert.strictEqual(await page.locator('.assistant-column').isVisible(),true);
  await page.getByRole('button',{name:'รับเคส'}).click();
  await page.waitForFunction(()=>document.querySelector('#caseHeader').textContent.includes('CASE-Q'));
  assert.match(await page.locator('#caseHeader').textContent(),/เหลือเวลา/);
  assert.strictEqual(await page.locator('#messageComposer').isEnabled(),true);
  assert.match(await page.locator('.ai-boundary').textContent(),/เภสัชกรเป็นผู้ตัดสินใจ/);
  await page.close();
}

(async () => {
  const { chromium } = playwright();
  const executablePath = browserExecutable(chromium);
  if (!executablePath) throw new Error('ไม่พบ Chrome/Edge สำหรับ browser simulation กรุณาติดตั้ง browser หรือกำหนด PHIMOR_CHROMIUM_EXECUTABLE');
  const browser = await chromium.launch({ headless:true, executablePath });
  const results=[];
  const requestedJourney=process.env.PHIMOR_BROWSER_JOURNEY||null;
  const journeys={ familyConsentJourney, familyHealthProfileSwitchJourney, familyMultiProfileGroupJourney, centerFamilyLinkingJourney, familyConsultationJourney, familyLabResultsJourney, familyCareHistoryJourney, familyTransportChoiceJourney, centerPendingJourney, clinicalCorrectionVoidJourney, centerPendingFailureIsVisible, registerJourney, adminSubscriptionJourney, adminCareOperationsJourney, pharmacistConsoleJourney };
  for (const [name, run] of Object.entries(journeys).filter(([name])=>!requestedJourney||name===requestedJourney)) {
    try { await run(browser); results.push(`PASS ${name}`); }
    catch (error) { results.push(`FAIL ${name}: ${error.stack || error}`); process.exitCode=1; }
  }
  await browser.close();
  console.log(results.join('\n'));
})().catch((error) => { console.error(error); process.exit(1); });
