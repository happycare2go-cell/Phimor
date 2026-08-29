// Authoritative Edge/Chromium mobile journey without installing a browser
// framework. Uses the browser's DevTools protocol and fictional local data.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('../backend/node_modules/ws');

const root = path.resolve(__dirname, '..');
const edge = process.env.PHIMOR_CHROMIUM_EXECUTABLE
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const LIFF_MOCK = `<script>window.liff={init:async()=>{},isLoggedIn:()=>true,login:()=>{},logout:()=>{},getIDToken:()=> 'SIMULATED_ID_TOKEN',getProfile:async()=>({userId:'U_SIMULATED',displayName:'ผู้ใช้จำลอง'}),isInClient:()=>true,closeWindow:()=>{},openWindow:()=>{}};</script>`;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function json(res, value, status = 200) {
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'Authorization, Content-Type',
    'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(value));
}

function contentType(file) {
  return ({ '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml' })[path.extname(file)] || 'application/octet-stream';
}

async function waitFor(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('BROWSER_JOURNEY_TIMEOUT');
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    this.ws.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'BROWSER_EVALUATION_FAILED');
    return result.result.value;
  }
  async navigate(url, readyExpression) {
    await this.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:true });
    await this.send('Page.navigate', { url });
    await waitFor(() => this.evaluate(`document.readyState==='complete' && Boolean(${readyExpression})`), 15000);
  }
  close() { this.ws.close(); }
}

(async () => {
  if (!fs.existsSync(edge)) throw new Error('CHROMIUM_EXECUTABLE_NOT_FOUND');
  let apiPort;
  let fixturePort;
  let centerLinkCreates = 0;
  let pending = true;
  let responseCount = 0;
  let responseBody = null;
  const profiles = [
    { profile:{ care_profile_id:'CP1', patient_name:'ป้าศรี', status:'independent' }, familyRole:'owner', familyGroup:{active:false,status:'unbound'}, canUseAi:false, upcomingAppointments:[] },
    { profile:{ care_profile_id:'CP2', patient_name:'คุณพ่อ', status:'independent' }, familyRole:'owner', familyGroup:{active:false,status:'unbound'}, canUseAi:false, upcomingAppointments:[] },
    { profile:{ care_profile_id:'CP3', patient_name:'คุณตา', status:'independent' }, familyRole:'caregiver', familyGroup:{active:false,status:'unbound'}, canUseAi:false, upcomingAppointments:[] },
  ];

  const apiServer = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return json(res, {});
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, `http://127.0.0.1:${apiPort}`);
    if (url.pathname === '/config/liff') return json(res, { publicBackendUrl:`http://127.0.0.1:${fixturePort || apiPort}`, familyLiffId:'SIM_FAMILY', centerAdminLiffId:'SIM_CENTER' });
    if (url.pathname === '/api/center/me') return json(res, { centers:[{ center_id:'CTR1', name:'ศูนย์ตัวอย่าง', myRole:'owner', status:'active', subscription:{allowed:true,remainingDays:30} }] });
    if (url.pathname === '/api/residents') return json(res, { residents:[] });
    if (url.pathname === '/api/center/appointments') return json(res, { appointments:[] });
    if (url.pathname === '/api/center/care-profile-link-requests' && req.method === 'POST') {
      centerLinkCreates += 1;
      return json(res, { linkUrl:'https://liff.line.me/SIM_FAMILY?centerLink=fictional-review-token', expiresAt:'2026-09-05T12:00:00.000Z' }, 201);
    }
    if (url.pathname === '/api/consent/check') return json(res, { hasConsent:true });
    if (url.pathname === '/api/init-dashboard') return json(res, { profiles });
    if (url.pathname === '/api/access-requests' && req.method === 'GET') return json(res, { requests:pending ? [{
      requestId:'AR1', requestKind:'anonymous_existing_profile_link', status:'pending', centerName:'ศูนย์ตัวอย่าง',
      centerAddress:'กรุงเทพฯ', centerPhone:'02-000-0000', expiresAt:'2026-09-05T12:00:00.000Z',
      eligibleProfiles:[{careProfileId:'CP1',patientName:'ป้าศรี'},{careProfileId:'CP2',patientName:'คุณพ่อ'}],
    }] : [] });
    if (url.pathname === '/api/access-requests/AR1/respond' && req.method === 'POST') {
      responseCount += 1;
      responseBody = JSON.parse(body || '{}');
      pending = false;
      return json(res, { ok:true, status:'approved', careProfileId:responseBody.careProfileId, residentId:'R1' });
    }
    if (url.pathname === '/api/transport/family/pending') return json(res, { pending:[] });
    if (/^\/api\/care-profile\/CP\d\/caregivers$/.test(url.pathname)) return json(res, { members:[] });
    if (url.pathname === '/api/plus/entitlement') return json(res, { status:'basic', plus:false });
    return json(res, {});
  });
  apiPort = await listen(apiServer);

  const fixtureServer = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${fixturePort}`).pathname);
    if (pathname === '/config/liff' || pathname.startsWith('/api/')) {
      const upstream = http.request({ hostname:'127.0.0.1', port:apiPort, path:req.url, method:req.method, headers:req.headers }, (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end('proxy failed'); });
      req.pipe(upstream);
      return;
    }
    const requested = pathname.replace(/^\/+/, '');
    const file = path.resolve(root, requested || 'liff-app/family/index.html');
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    let data = fs.readFileSync(file);
    if (file.endsWith('.html')) {
      data = Buffer.from(data.toString('utf8')
        .replace(/<script[^>]+static\.line-scdn\.net\/liff\/edge\/2\/sdk\.js[^>]*><\/script>/, LIFF_MOCK)
        .replace('<script src="../environment.js"></script>', `<script>window.PHIMOR_PUBLIC_BACKEND_URL='http://127.0.0.1:${fixturePort}';</script>`));
    }
    res.writeHead(200, { 'Content-Type':contentType(file), 'Cache-Control':'no-store' });
    res.end(data);
  });
  fixturePort = await listen(fixtureServer);

  const debugServer = http.createServer();
  const debugPort = await listen(debugServer);
  await new Promise((resolve) => debugServer.close(resolve));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'phimor-linking-browser-'));
  const child = spawn(edge, [
    '--headless=old', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`,
    '--disable-gpu', '--disable-software-rasterizer', '--no-sandbox', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio:'ignore', windowsHide:true });
  let cdp;
  try {
    const target = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal:AbortSignal.timeout(500) });
        const items = await response.json();
        return items.find((item) => item.type === 'page');
      } catch { return null; }
    }, 15000);
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();

    await cdp.navigate(`http://127.0.0.1:${fixturePort}/liff-app/center-admin/index.html`, `document.body`);
    try {
      await waitFor(() => cdp.evaluate(`document.querySelector('#centerNameLabel') && document.querySelector('#centerNameLabel').textContent.includes('ศูนย์ตัวอย่าง')`), 10000);
    } catch (error) {
      error.message += ` ${JSON.stringify(await cdp.evaluate(`({url:location.href,label:document.querySelector('#centerNameLabel')?.textContent,toast:document.querySelector('#toast')?.textContent,body:document.body?.innerText?.slice(0,300)})`))}`;
      throw error;
    }
    const centerChoices = await cdp.evaluate(`[...document.querySelectorAll('.onboarding-choice')].map(button=>button.textContent.trim())`);
    assert.equal(centerChoices.length, 2);
    assert.match(centerChoices[0], /เชื่อม Care Profile ที่มีอยู่แล้ว/);
    assert.match(centerChoices[1], /สร้าง Care Profile ใหม่/);
    await cdp.evaluate(`document.querySelector('.onboarding-choice').click()`);
    assert.equal(await cdp.evaluate(`!document.querySelector('#existingProfileLinkPanel').hidden && document.querySelector('#newCareProfilePanel').hidden`), true);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('#existingProfileLinkPanel input,#existingProfileLinkPanel textarea').length`), 0);
    await cdp.evaluate(`document.querySelector('#createExistingProfileLinkButton').click()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('#existingProfileLinkResult').textContent.includes('7 วัน')`));
    assert.equal(centerLinkCreates, 1);
    const centerMobile = await cdp.evaluate(`(()=>{const choice=document.querySelector('.onboarding-choice'),toast=document.querySelector('#toast'),modal=document.querySelector('.modal-bg');return{overflow:document.documentElement.scrollWidth<=document.documentElement.clientWidth,height:choice.getBoundingClientRect().height,toastPointer:getComputedStyle(toast).pointerEvents,toastZ:Number(getComputedStyle(toast).zIndex),modalZ:Number(getComputedStyle(modal).zIndex)}})()`);
    assert.equal(centerMobile.overflow, true); assert.ok(centerMobile.height >= 44);
    assert.equal(centerMobile.toastPointer, 'none'); assert.ok(centerMobile.modalZ > centerMobile.toastZ);

    await cdp.navigate(`http://127.0.0.1:${fixturePort}/liff-app/family/index.html`, `document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display==='block'`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-family-destination="access"]')!==null`));
    await cdp.evaluate(`document.querySelector('[data-family-destination="access"]').click()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-access-request="AR1"]')!==null`));
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.access-profile-option').length`), 2);
    assert.equal(await cdp.evaluate(`document.querySelector('#accessRequestList').textContent.includes('คุณตา')`), false);
    await cdp.evaluate(`[...document.querySelectorAll('[data-access-request="AR1"] button')].find(button=>button.textContent.includes('กลับ')).click()`);
    assert.equal(responseCount, 0);
    assert.equal(await cdp.evaluate(`document.querySelector('#view-home').classList.contains('active')`), true);
    await cdp.evaluate(`document.querySelector('[data-family-destination="access"]').click();document.querySelector('input[value="CP2"]').checked=true`);
    await cdp.evaluate(`[...document.querySelectorAll('[data-access-request="AR1"] button')].find(button=>button.textContent.includes('ยืนยันเชื่อม')).scrollIntoView({block:'center'})`);
    const familyMobile = await cdp.evaluate(`(()=>{const button=[...document.querySelectorAll('[data-access-request="AR1"] button')].find(item=>item.textContent.includes('ยืนยันเชื่อม')),box=button.getBoundingClientRect(),toast=document.querySelector('#toast'),modal=document.querySelector('#confirmActionModal');return{height:box.height,hit:document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)===button,overflow:document.documentElement.scrollWidth<=document.documentElement.clientWidth,toastPointer:getComputedStyle(toast).pointerEvents,toastZ:Number(getComputedStyle(toast).zIndex),modalZ:Number(getComputedStyle(modal).zIndex)}})()`);
    assert.ok(familyMobile.height >= 44); assert.equal(familyMobile.hit, true); assert.equal(familyMobile.overflow, true);
    assert.equal(familyMobile.toastPointer, 'none'); assert.ok(familyMobile.modalZ > familyMobile.toastZ);
    await cdp.evaluate(`[...document.querySelectorAll('[data-access-request="AR1"] button')].find(button=>button.textContent.includes('ยืนยันเชื่อม')).click()`);
    await waitFor(() => responseCount === 1 && cdp.evaluate(`document.querySelector('[data-access-request="AR1"]')===null`));
    assert.deepEqual(responseBody, { approved:true, careProfileId:'CP2' });
    assert.deepEqual(await cdp.evaluate(`({local:Object.keys(localStorage),session:Object.keys(sessionStorage),query:location.search})`), { local:[], session:[], query:'' });
    console.log('PASS centerFamilyLinkingJourney 390x844');
  } finally {
    cdp?.close();
    child.kill();
    apiServer.closeAllConnections?.();
    fixtureServer.closeAllConnections?.();
    await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => fixtureServer.close(resolve));
    try { fs.rmSync(userData, { recursive:true, force:true }); } catch {}
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
