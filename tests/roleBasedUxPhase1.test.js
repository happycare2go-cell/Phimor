process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const { projectCenterContext, ROLE_CAPABILITIES } = require('../backend/services/centerProjection');
const appShell = require('../liff-app/shared/app-shell');

const root = path.resolve(__dirname, '..');
const centerHtml = fs.readFileSync(path.join(root, 'liff-app', 'center-admin', 'index.html'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'liff-app', 'system-admin', 'index.html'), 'utf8');
const shellCss = fs.readFileSync(path.join(root, 'liff-app', 'shared', 'app-shell.css'), 'utf8');
const shellJs = fs.readFileSync(path.join(root, 'liff-app', 'shared', 'app-shell.js'), 'utf8');

let server;
let baseUrl;
test.before(async () => {
  const app = require('../backend/server');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => db.resetAll());

function request(pathname, { user = 'U_OWNER', method = 'GET', body } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'X-Line-User-Id':user, ...(body ? { 'Content-Type':'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('shared shell resolves only approved destinations and installs one listener pair', async () => {
  const attributes = new Map();
  const button = {
    dataset:{ shellDestination:'overview' }, disabled:false,
    setAttribute:(key, value) => attributes.set(key, value),
    removeAttribute:(key) => attributes.delete(key),
  };
  const panel = { dataset:{ shellPanel:'overview' }, hidden:true, querySelector:() => null };
  const listeners = [];
  const history = { replaceState(){}, pushState(){} };
  const view = { location:{ href:'https://example.test/?section=unknown' }, history, addEventListener:(type) => listeners.push(`view:${type}`), removeEventListener(){} };
  const doc = {
    defaultView:view,
    querySelectorAll:(selector) => selector === '[data-shell-destination]' ? [button] : [panel],
    addEventListener:(type) => listeners.push(`doc:${type}`), removeEventListener(){},
  };
  assert.equal(appShell.resolveDestination('legacy', { destinations:['overview','centers'], aliases:{legacy:'centers'}, fallback:'overview' }), 'centers');
  assert.equal(appShell.resolveDestination('unsafe', { destinations:['overview','centers'], fallback:'overview' }), 'overview');
  const router = appShell.createDestinationRouter({ doc, destinations:['overview'], initial:'overview' });
  await router.start();
  await router.navigate('overview');
  await router.navigate('overview');
  assert.deepEqual(listeners, ['doc:click', 'view:popstate']);
  assert.equal(attributes.get('aria-current'), 'page');
  assert.equal(panel.hidden, false);
  router.destroy();
});

test('shared shell implements mobile bottom navigation, desktop side navigation and accessible controls', () => {
  assert.match(shellCss, /grid-template-columns:\s*repeat\(5/);
  assert.match(shellCss, /env\(safe-area-inset-bottom/);
  assert.match(shellCss, /min-height:\s*52px/);
  assert.match(shellCss, /:focus-visible/);
  assert.match(shellCss, /@media \(min-width:\s*900px\)/);
  assert.match(shellCss, /grid-template-columns:\s*228px minmax\(0, 1fr\)/);
  assert.match(shellJs, /aria-current/);
  assert.doesNotMatch(shellJs, /localStorage|sessionStorage/);
});

test('System Admin has five semantic destinations and lazy-loads selected operations only', () => {
  for (const destination of ['overview','centers','integrations','review','more']) {
    assert.match(adminHtml, new RegExp(`data-shell-destination="${destination}"`));
    assert.match(adminHtml, new RegExp(`data-shell-panel="${destination}"`));
  }
  assert.match(adminHtml, /const ADMIN_DESTINATIONS=Object\.freeze\(\['overview','centers','integrations','review','more'\]\)/);
  assert.match(adminHtml, /controller\.load\(\{tabs:\['integrations'\]\}\)/);
  assert.match(adminHtml, /controller\.load\(\{tabs:\['pending','groups','alerts'\]\}\)/);
  assert.match(adminHtml, /controller\.load\(\{tabs:\['overview','capabilities'\]\}\)/);
  assert.doesNotMatch(adminHtml.slice(adminHtml.indexOf('async function enterAdmin'), adminHtml.indexOf('function logout')), /Promise\.all\(\[ensureCareOperationsUI/);
  assert.doesNotMatch(adminHtml, /blood_group|chronic_conditions|drug_allergies|raw payload/i);
});

test('Center has five semantic destinations, truthful role homes and legacy deep-link mapping', () => {
  for (const destination of ['home','residents','record','work','more']) {
    assert.match(centerHtml, new RegExp(`data-shell-destination="${destination}"`));
    assert.match(centerHtml, new RegExp(`data-shell-panel="${destination}"`));
  }
  assert.match(centerHtml, /ไม่มีการอ้างว่าเป็นงานที่มอบหมาย/);
  assert.match(centerHtml, /Staff.*ยังไม่มีข้อมูลมอบหมายงานรายบุคคล|ยังไม่มีข้อมูลมอบหมายงานรายบุคคล/);
  assert.match(centerHtml, /\{residents:'residents',transport:'work',care:'record',ratecard:'more',staff:'more'\}/);
  assert.match(centerHtml, /view === 'edit-card'/);
  assert.match(centerHtml, /CURRENT_ROLE==='staff'.*ส่งรูปเอกสาร/s);
  assert.match(centerHtml, /CURRENT_ROLE==='owner'.*แพ็กเกจ/s);
  assert.match(centerHtml, /ไม่มีการซื้อหรือตัดเงินจากหน้านี้/);
  assert.match(centerHtml, /moreSurfaceParking/);
  assert.match(centerHtml, /parking\.append\(node\)/);
  assert.doesNotMatch(centerHtml, /localStorage|sessionStorage/);
});

test('role capabilities are centralized and Manager can bind Center group without Owner controls', () => {
  assert.equal(ROLE_CAPABILITIES.owner.canManageTeam, true);
  assert.equal(ROLE_CAPABILITIES.manager.canBindCenterGroup, true);
  assert.equal(ROLE_CAPABILITIES.manager.canManageTeam, false);
  assert.equal(ROLE_CAPABILITIES.staff.canBindCenterGroup, false);
  assert.equal(ROLE_CAPABILITIES.staff.canManageCenterSettings, false);
  assert.match(centerHtml, /CENTER_UI_CAPABILITIES=\{\.\.\.roleCapabilities\(center\.myRole\),\.\.\.\(center\.uiCapabilities\|\|\{\}\)\}/);
  assert.match(centerHtml, /canBindCenterGroup.*กลุ่ม LINE/s);
  assert.match(centerHtml, /canManageTeam.*ทีมงานและบทบาท/s);
});

test('safe Center context is minimized and role-specific', () => {
  const source = {
    center_id:'CTR-A', name:'ศูนย์ A', status:'active', address:'ที่อยู่', contact_phone:'020000000',
    owner_line_id:'U_RAW', group_id:'G_RAW', external_api_key:'SECRET', blood_group:'O+', chronic_conditions:['x'],
  };
  const manager = projectCenterContext(source, { role:'manager', subscription:{allowed:true,state:'active'}, staffGroupBound:true });
  assert.equal(manager.centerId, 'CTR-A');
  assert.equal(manager.role, 'manager');
  assert.equal(manager.centerStaffGroup.status, 'verified');
  assert.equal(manager.uiCapabilities.canManageTeam, false);
  assert.equal(manager.settings, undefined);
  assert.doesNotMatch(JSON.stringify(manager), /U_RAW|G_RAW|SECRET|blood_group|chronic_conditions/);
  const owner = projectCenterContext(source, { role:'owner', subscription:{allowed:true,state:'active'} });
  assert.deepEqual(owner.settings, { address:'ที่อยู่', contactPhone:'020000000' });
});

test('active Center endpoint is authorized, idempotent and becomes private-image routing authority', async () => {
  const a = await centerService.createCenter({ name:'ศูนย์ A', ownerLineId:'U_OWNER' });
  const b = await centerService.createCenter({ name:'ศูนย์ B', ownerLineId:'U_OWNER' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await request('/api/center/active-center', { method:'POST', body:{centerId:b.center_id} });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.actorContext.activeCenterId, b.center_id);
    assert.equal(body.center.centerId, b.center_id);
    assert.doesNotMatch(JSON.stringify(body), /owner_line_id|group_id|external_api_key/i);
  }
  assert.equal(await centerService.getActiveCenterIdForStaff('U_OWNER'), b.center_id);
  assert.equal((await centerService.findCenterByStaffUser('U_OWNER')).center_id, b.center_id);
  assert.notEqual(a.center_id, b.center_id);
});

test('unauthorized, pending and revoked Center selection are denied without changing context', async () => {
  const allowed = await centerService.createCenter({ name:'ศูนย์เจ้าของ', ownerLineId:'U_ACTOR' });
  const other = await centerService.createCenter({ name:'ศูนย์อื่น', ownerLineId:'U_OTHER' });
  await centerService.setActiveCenterForStaff('U_ACTOR', allowed.center_id);
  await db.CenterStaff.insert({ staff_id:'STF-P', center_id:other.center_id, line_user_id:'U_PENDING', role:'staff', status:'pending' });
  await db.CenterStaff.insert({ staff_id:'STF-R', center_id:other.center_id, line_user_id:'U_REVOKED', role:'staff', status:'revoked' });
  assert.equal((await request('/api/center/active-center', { user:'U_ACTOR', method:'POST', body:{centerId:other.center_id} })).status, 403);
  assert.equal((await request('/api/center/active-center', { user:'U_PENDING', method:'POST', body:{centerId:other.center_id} })).status, 403);
  assert.equal((await request('/api/center/active-center', { user:'U_REVOKED', method:'POST', body:{centerId:other.center_id} })).status, 403);
  assert.equal(await centerService.getActiveCenterIdForStaff('U_ACTOR'), allowed.center_id);
});

test('active member may select a suspended Center to see its factual warning, while writes remain blocked', async () => {
  const center = await centerService.createCenter({ name:'ศูนย์ระงับ', ownerLineId:'U_OWNER' });
  await db.Centers.update((row) => row.center_id === center.center_id, { status:'suspended' });
  const selection = await request('/api/center/active-center', { method:'POST', body:{centerId:center.center_id} });
  assert.equal(selection.status, 200);
  const selected = await selection.json();
  assert.equal(selected.center.operationalStatus, 'suspended');
  assert.equal(selected.center.entitlement.allowed, false);
  const protectedWrite = await request('/api/residents', { method:'POST', body:{centerId:center.center_id,fullName:'ไม่ควรถูกสร้าง'} });
  assert.equal(protectedWrite.status, 402);
});

test('/api/center/me returns deterministic active context and no raw identities or group IDs', async () => {
  const z = await centerService.createCenter({ name:'ศูนย์ Z', ownerLineId:'U_OWNER' });
  const a = await centerService.createCenter({ name:'ศูนย์ A', ownerLineId:'U_OWNER' });
  await centerService.setActiveCenterForStaff('U_OWNER', z.center_id);
  const response = await request('/api/center/me');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.actorContext.activeCenterId, z.center_id);
  assert.deepEqual(body.centers.map((center) => center.name), ['ศูนย์ A','ศูนย์ Z']);
  assert.ok(body.centers.every((center) => center.uiCapabilities && center.entitlement));
  assert.doesNotMatch(JSON.stringify(body), /owner_line_id|line_user_id|group_id|external_api_key/i);
  assert.notEqual(a.center_id, z.center_id);
});

test('Center switch invalidates old state before authoritative selection and guards stale responses', () => {
  const select = centerHtml.slice(centerHtml.indexOf('function invalidateCenterState'), centerHtml.indexOf('window.addEventListener'));
  assert.match(select, /CENTER_CONTEXT_GENERATION\+=1/);
  assert.match(select, /residentsCache=\[\]/);
  assert.match(select, /centerCareUi\.clear\(\)/);
  assert.match(select, /editCardRequestGuard\.invalidate\(\)/);
  assert.match(select, /closeCenterModals\(\)/);
  assert.match(centerHtml, /requestedGeneration!==CENTER_CONTEXT_GENERATION/);
  assert.match(centerHtml, /if\(generation!==CENTER_CONTEXT_GENERATION\)return/);
  assert.match(centerHtml, /contextGuard:false/);
});

test('Phase 1 introduces no migration, environment variable or Family LIFF dependency', () => {
  const migrationNames = fs.readdirSync(path.join(root, 'backend', 'migrations')).filter((name) => /^\d{4}_.*\.js$/.test(name)).sort();
  assert.equal(migrationNames.at(-1), '0016_add_center_family_linking_integrity.js');
  assert.doesNotMatch(shellJs + shellCss, /process\.env|LIFF_ID|CareProfile|Resident/);
  assert.match(centerHtml, /\.\.\/shared\/app-shell\.js/);
  assert.match(adminHtml, /\.\.\/shared\/app-shell\.js/);
});
