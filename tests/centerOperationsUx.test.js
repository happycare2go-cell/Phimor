process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const subscriptionService = require('../backend/services/subscriptionService');
const directoryService = require('../backend/services/adminCenterDirectoryService');

const root = path.resolve(__dirname, '..');
const centerHtml = fs.readFileSync(path.join(root, 'liff-app', 'center-admin', 'index.html'), 'utf8');
const registerHtml = fs.readFileSync(path.join(root, 'liff-app', 'register', 'index.html'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'liff-app', 'system-admin', 'index.html'), 'utf8');

beforeEach(() => db.resetAll());

test('Center identity uses authenticated LINE profile presentation and backend-selected role context', () => {
  assert.match(centerHtml, /aria-label="บัญชี LINE และสิทธิ์ศูนย์ที่กำลังใช้งาน"/);
  assert.match(centerHtml, /id="lineProfilePicture"/);
  assert.match(centerHtml, /id="lineProfileFallback"/);
  assert.match(centerHtml, /id="lineDisplayName"/);
  assert.match(centerHtml, /profile\.displayName/);
  assert.match(centerHtml, /profile\.pictureUrl/);
  assert.match(centerHtml, /safeLineProfilePictureUrl/);
  assert.match(centerHtml, /parsed\.protocol==='https:'/);
  assert.match(centerHtml, /name\.textContent=displayName/);
  assert.doesNotMatch(centerHtml.slice(centerHtml.indexOf('function renderLineIdentity'), centerHtml.indexOf('function toast')), /LINE_USER_ID|userId|innerHTML/);
  assert.match(centerHtml, /center-line-identity__avatar\{width:46px;height:46px/);
  assert.match(centerHtml, /center-line-identity__avatar img\[hidden\]\{display:none\}/);
  assert.match(centerHtml, /text-overflow:ellipsis/);
});

test('Center role labels and controls are reapplied on every authoritative Center switch', () => {
  assert.match(centerHtml, /function applySelectedCenterContext\(center\)/);
  assert.match(centerHtml, /CURRENT_ROLE=center\.myRole/);
  assert.match(centerHtml, /owner:'เจ้าของศูนย์',manager:'ผู้จัดการ',staff:'พนักงาน'/);
  assert.match(centerHtml, /function applyRoleControls\(role\)/);
  assert.match(centerHtml, /addResidentCard'\)\.hidden=!capabilities\.canCreateResident/);
  assert.match(centerHtml, /CENTER_UI_CAPABILITIES\.canBindCenterGroup/);
  assert.match(centerHtml, /CENTER_UI_CAPABILITIES\.canManageRateCard/);
  assert.match(centerHtml, /CENTER_UI_CAPABILITIES\.canManageTeam/);
  const selectSource = centerHtml.slice(centerHtml.indexOf('async function selectCenter'), centerHtml.indexOf('async function removeManager'));
  assert.match(selectSource, /CENTERS\.find\(\(item\)=>item\.center_id===centerId\)/);
  assert.match(selectSource, /\/api\/center\/active-center/);
  assert.match(selectSource, /invalidateCenterState\(\)/);
  assert.match(selectSource, /applySelectedCenterContext\(CENTERS\[index\]\|\|center\)/);
  assert.doesNotMatch(selectSource, /req\.body|location\.search|localStorage|sessionStorage/);
  assert.match(centerHtml, /#centerSelector\{min-height:44px\}/);
});

test('Register LIFF uses fail-closed runtime backend configuration with no production fallback', () => {
  assert.match(registerHtml, /<script src="\.\.\/environment\.js"><\/script>/);
  assert.match(registerHtml, /<script src="\.\.\/runtime-config\.js"><\/script>/);
  assert.match(registerHtml, /requireBackendUrl\(window\.PHIMOR_PUBLIC_BACKEND_URL\)/);
  assert.match(registerHtml, /assertBackendConfig\(BACKEND_URL, config\)/);
  assert.match(registerHtml, /ยังไม่สามารถเปิดหน้าลงทะเบียนได้/);
  assert.doesNotMatch(registerHtml, /const BACKEND_URL\s*=\s*['"]https:\/\/phimor-backend\.onrender\.com/);
  assert.match(registerHtml, /ทดลองใช้พี่หมอได้ฟรี 1 เดือน/);
  assert.match(registerHtml, /timeZone:'Asia\/Bangkok'/);
});

test('Bangkok calendar-month helper preserves local time and clamps end-of-month', () => {
  assert.equal(
    subscriptionService.addBangkokCalendarMonth('2026-08-29T10:15:30+07:00').toISOString(),
    '2026-09-29T03:15:30.000Z',
  );
  assert.equal(
    subscriptionService.addBangkokCalendarMonth('2027-01-31T22:30:00+07:00').toISOString(),
    '2027-02-28T15:30:00.000Z',
  );
  assert.equal(
    subscriptionService.addBangkokCalendarMonth('2028-01-31T22:30:00+07:00').toISOString(),
    '2028-02-29T15:30:00.000Z',
  );
});

test('self-registration option atomically creates an active one-calendar-month trial', async () => {
  const center = await centerService.createCenter({
    name:'ศูนย์ทดลอง', ownerLineId:'U-TRIAL', selfRegistrationTrial:true,
  });
  assert.equal(center.subscription_required, true);
  assert.equal(center.subscription_package_type, 'trial');
  assert.ok(center.subscription_start_at);
  assert.equal(
    center.subscription_end_at,
    subscriptionService.addBangkokCalendarMonth(center.subscription_start_at).toISOString(),
  );
  const active = subscriptionService.entitlement(center, new Date(center.subscription_start_at));
  assert.equal(active.allowed, true);
  assert.equal(active.state, 'trial');
  assert.equal(active.operationalStatus, 'active');
  const expired = subscriptionService.entitlement(center, new Date(new Date(center.subscription_end_at).getTime() + 1));
  assert.equal(expired.allowed, false);
  assert.equal(expired.state, 'expired');
  assert.equal(expired.code, 'subscription_expired');
});

test('suspension overrides trial access without erasing trial chronology', async () => {
  const center = await centerService.createCenter({ name:'ศูนย์พักใช้', ownerLineId:'U-S', selfRegistrationTrial:true });
  const suspended = { ...center, status:'suspended' };
  const result = subscriptionService.entitlement(suspended, new Date(center.subscription_start_at));
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'center_suspended');
  assert.equal(result.operationalStatus, 'suspended');
  assert.equal(result.state, 'trial');
  assert.equal(result.startsAt, center.subscription_start_at);
  assert.equal(result.expiresAt, center.subscription_end_at);
});

test('Admin-created and legacy Centers are not silently assigned trials', async () => {
  const adminCreated = await centerService.createCenter({ name:'Admin Center', ownerLineId:'U-A', subscriptionRequired:true });
  assert.equal(adminCreated.subscription_package_type, null);
  assert.equal(subscriptionService.entitlement(adminCreated).state, 'not_configured');
  assert.equal(subscriptionService.entitlement(adminCreated).allowed, false);
  const legacy = await centerService.createCenter({ name:'Legacy Center', ownerLineId:'U-L', subscriptionRequired:false });
  const legacyEntitlement = subscriptionService.entitlement(legacy);
  assert.equal(legacyEntitlement.allowed, true);
  assert.equal(legacyEntitlement.state, 'not_configured');
  assert.equal(legacyEntitlement.code, 'legacy_unconfigured');
  assert.equal(legacyEntitlement.needsConfiguration, true);
});

async function seedCenter({ id, name, status='active', required=true, packageType=null, start=null, end=null, owner='U-OWNER', clinical=false }) {
  const center = await db.Centers.insert({
    center_id:id, name, status, owner_line_id:owner, group_id:null,
    subscription_required:required, subscription_package_type:packageType,
    subscription_start_at:start, subscription_end_at:end, created_at:'2026-01-01T00:00:00.000Z',
    ...(clinical ? { blood_group:'O+', chronic_conditions:['secret'], allergies:['secret'] } : {}),
  });
  await db.CenterStaff.insert({ staff_id:`S-${id}`, center_id:id, line_user_id:owner, role:'owner', status:'active', display_name:`Owner ${id}` });
  return center;
}

test('Admin directory classifies all operational/subscription states without clinical projection', async () => {
  await seedCenter({ id:'C-A', name:'Alpha Care', packageType:'monthly', start:'2026-01-01T00:00:00Z', end:'2027-01-01T00:00:00Z', clinical:true });
  await seedCenter({ id:'C-T', name:'ศูนย์ทดลอง', packageType:'trial', start:'2026-01-01T00:00:00Z', end:'2027-01-01T00:00:00Z' });
  await seedCenter({ id:'C-E', name:'Expired', packageType:'monthly', start:'2024-01-01T00:00:00Z', end:'2025-01-01T00:00:00Z' });
  await seedCenter({ id:'C-NC', name:'No Config' });
  await seedCenter({ id:'C-NS', name:'Not Started', packageType:'annual', start:'2027-01-01T00:00:00Z', end:'2028-01-01T00:00:00Z' });
  await seedCenter({ id:'C-S', name:'Suspended', status:'suspended', packageType:'monthly', start:'2026-01-01T00:00:00Z', end:'2027-01-01T00:00:00Z' });
  const result = await directoryService.listAdminCenters({ limit:100 }, { at:'2026-08-29T00:00:00Z' });
  assert.deepEqual(result.counts, { all:6, active:1, trial:1, expired:1, notConfigured:1, notStarted:1, suspended:1 });
  assert.deepEqual(new Set(result.items.map((item) => item.directoryStatus)), new Set(['active','trial','expired','not_configured','not_started','suspended']));
  assert.doesNotMatch(JSON.stringify(result), /blood_group|chronic_conditions|allergies|O\+|secret/);
  const suspended = result.items.find((item) => item.centerId === 'C-S');
  assert.equal(suspended.operationalStatus, 'suspended');
  assert.equal(suspended.subscription.state, 'active');
  assert.equal(suspended.subscription.allowed, false);
});

test('Admin directory supports Thai/Latin substring and treats SQL wildcard characters literally', async () => {
  await seedCenter({ id:'C-1', name:'Happy Home เชียงใหม่' });
  await seedCenter({ id:'C-2', name:'ศูนย์สุขใจ 100%' });
  await seedCenter({ id:'C-3', name:'Care_Center' });
  assert.deepEqual((await directoryService.listAdminCenters({ search:'เชียง' })).items.map((item) => item.centerId), ['C-1']);
  assert.deepEqual((await directoryService.listAdminCenters({ search:'HAPPY home' })).items.map((item) => item.centerId), ['C-1']);
  assert.deepEqual((await directoryService.listAdminCenters({ search:'%' })).items.map((item) => item.centerId), ['C-2']);
  assert.deepEqual((await directoryService.listAdminCenters({ search:'_' })).items.map((item) => item.centerId), ['C-3']);
  assert.equal((await directoryService.listAdminCenters({ search:'ไม่พบ' })).items.length, 0);
});

test('Admin directory pagination is bounded, stable and counts ignore the selected chip', async () => {
  for (let index=1; index<=25; index+=1) {
    await seedCenter({ id:`C-${String(index).padStart(2,'0')}`, name:`Center ${String(index).padStart(2,'0')}` });
  }
  const first = await directoryService.listAdminCenters({ page:1, limit:10, subscriptionStatus:'not_configured' });
  const second = await directoryService.listAdminCenters({ page:2, limit:10, subscriptionStatus:'not_configured' });
  assert.equal(first.items.length, 10);
  assert.equal(first.pagination.total, 25);
  assert.equal(first.pagination.totalPages, 3);
  assert.equal(first.counts.all, 25);
  assert.equal(first.counts.notConfigured, 25);
  assert.equal(new Set([...first.items,...second.items].map((item) => item.centerId)).size, 20);
  assert.equal(directoryService.normalizeDirectoryQuery({}).limit, 20);
  assert.equal(directoryService.normalizeDirectoryQuery({ limit:999 }).limit, 100);
  assert.throws(() => directoryService.normalizeDirectoryQuery({ search:'x'.repeat(101) }), /ไม่เกิน 100/);
  assert.throws(() => directoryService.normalizeDirectoryQuery({ subscriptionStatus:'unknown' }), /ไม่ถูกต้อง/);
});

test('Admin directory SQL uses literal-position substring search, stable ordering and no extension dependency', () => {
  assert.match(directoryService.DIRECTORY_SQL, /POSITION\(LOWER\(\$1::text\) IN LOWER/);
  assert.match(directoryService.DIRECTORY_SQL, /ORDER BY LOWER\(COALESCE\(data->>'name'/);
  assert.doesNotMatch(directoryService.DIRECTORY_SQL, /ILIKE|pg_trgm|CREATE EXTENSION|raw.*id/i);
});

test('System Admin directory UI consumes backend projection with mobile-safe filters and paging', () => {
  assert.match(adminHtml, /placeholder="ค้นหาชื่อศูนย์"/);
  for (const status of ['all','active','trial','expired','not_configured','not_started','suspended']) {
    assert.match(adminHtml, new RegExp(`data-status="${status}"`));
  }
  assert.match(adminHtml, /subscriptionStatus:centerDirectory\.status/);
  assert.match(adminHtml, /d\.items\|\|d\.centers/);
  assert.match(adminHtml, /directoryStatus/);
  assert.match(adminHtml, /ทดลองใช้ถึง/);
  assert.match(adminHtml, /timeZone:'Asia\/Bangkok'/);
  assert.match(adminHtml, /directory-filters\{[^}]*overflow-x:auto/);
  assert.match(adminHtml, /input,select,button\{[^}]*min-height:44px/);
  assert.doesNotMatch(adminHtml, /ค้นหาชื่อศูนย์\/เจ้าของ/);
});
