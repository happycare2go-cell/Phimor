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

function localHtml(name) {
  return fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', name, 'index.html'), 'utf8')
    .replace(/<script[^>]+static\.line-scdn\.net\/liff\/edge\/2\/sdk\.js[^>]*><\/script>/, LIFF_MOCK)
    .replace('<script src="../environment.js"></script>', `<script>window.PHIMOR_PUBLIC_BACKEND_URL=${JSON.stringify(SIMULATED_BACKEND_URL)};</script>`)
    .replace('<script src="../runtime-config.js"></script>', `<script>${RUNTIME_CONFIG_SOURCE}</script>`);
}

async function mockBackend(page, handler) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (!request.url().startsWith(SIMULATED_BACKEND_URL)) return route.abort();
    const result = await handler(new URL(request.url()), request);
    return route.fulfill({ status: result?.status || 200, contentType: 'application/json', body: JSON.stringify(result?.body ?? result ?? {}) });
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
  assert.match(await page.locator('#profileLabel').textContent(), /ยังไม่มีข้อมูล/);
  await page.locator('.tab[data-view="health"]').click();
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
  await page.locator('.tab[data-view="health"]').click();
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

async function centerPendingJourney(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mockBackend(page, async (url) => {
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
  for (const [name, run] of Object.entries({ familyConsentJourney, familyHealthProfileSwitchJourney, centerPendingJourney, centerPendingFailureIsVisible, registerJourney, adminSubscriptionJourney, pharmacistConsoleJourney })) {
    try { await run(browser); results.push(`PASS ${name}`); }
    catch (error) { results.push(`FAIL ${name}: ${error.stack || error}`); process.exitCode=1; }
  }
  await browser.close();
  console.log(results.join('\n'));
})().catch((error) => { console.error(error); process.exit(1); });
