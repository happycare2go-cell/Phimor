const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';
process.env.ADMIN_API_KEY = 'privacy-admin-key';
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');

let server; let baseUrl;
before(async () => {
  const app = require('../backend/server'); server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve)); baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => new Promise((resolve) => server.close(resolve)));
beforeEach(() => db.resetAll());

function family(path, options = {}, actor = 'U-A-1642') {
  return fetch(baseUrl + path, { ...options, headers:{ 'Content-Type':'application/json', 'X-Line-User-Id':actor, ...(options.headers || {}) } });
}
function admin(path, options = {}) {
  return fetch(baseUrl + path, { ...options, headers:{ 'Content-Type':'application/json', 'X-Admin-Key':'privacy-admin-key', ...(options.headers || {}) } });
}

test('Family consent routes require explicit withdrawal confirmation and affect only the authenticated actor', async () => {
  assert.equal((await family('/api/consent/withdraw', { method:'POST', body:'{}' })).status, 400);
  assert.equal((await family('/api/consent', { method:'POST', body:JSON.stringify({accepted:true}) })).status, 201);
  const withdrawn = await family('/api/consent/withdraw', { method:'POST', body:JSON.stringify({confirmed:true}) });
  assert.equal(withdrawn.status, 200); assert.equal((await withdrawn.json()).consent.status, 'withdrawn');
  assert.equal((await (await family('/api/consent/check', {}, 'U-B-9876')).json()).status, 'not_given');
});

test('Family creates and lists only own DSR while another actor receives safe 404 for the reference', async () => {
  const created = await family('/api/data-requests', { method:'POST', body:JSON.stringify({type:'export',note:'ขอสำเนาข้อมูล'}) });
  assert.equal(created.status, 201); const payload = await created.json();
  assert.equal(payload.request.type, 'export'); assert.doesNotMatch(JSON.stringify(payload), /U-A-1642|line_user/i);
  const duplicate = await family('/api/data-requests', { method:'POST', body:JSON.stringify({type:'export',note:'กดซ้ำ'}) });
  assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).duplicate, true);
  const row = (await db.DataSubjectRequests.findAll())[0];
  assert.equal((await family(`/api/data-requests/${row.request_id}`, {}, 'U-B-9876')).status, 404);
  const own = await (await family('/api/data-requests')).json(); assert.equal(own.requests.length, 1);
  const other = await (await family('/api/data-requests', {}, 'U-B-9876')).json(); assert.equal(other.requests.length, 0);
});

test('Admin DSR queue is separately authorized, minimized and cannot claim automatic fulfillment', async () => {
  await family('/api/data-requests', { method:'POST', body:JSON.stringify({type:'delete',note:'ขอตรวจสอบข้อมูลบัญชี'}) });
  assert.equal((await fetch(baseUrl + '/api/admin/data-requests')).status, 401);
  const queue = await admin('/api/admin/data-requests'); assert.equal(queue.status, 200); const body=await queue.json();
  assert.equal(body.requests.length, 1); assert.match(body.requests[0].requesterIdentity, /••••1642/);
  assert.doesNotMatch(JSON.stringify(body), /U-A-1642|line_user_id/);
  const id = body.requests[0].requestId;
  const unsafeComplete = await admin(`/api/admin/data-requests/${id}`, { method:'PATCH', body:JSON.stringify({status:'completed'}) });
  assert.equal(unsafeComplete.status, 400);
  const complete = await admin(`/api/admin/data-requests/${id}`, { method:'PATCH', body:JSON.stringify({status:'completed',manualFulfillmentConfirmed:true,publicNote:'ดำเนินการตามขั้นตอนแล้ว'}) });
  assert.equal(complete.status, 200); assert.equal((await complete.json()).request.fulfillmentMode, 'manual_review');
});

test('Family caregiver, Center team and System Admin projections never expose raw LINE IDs', async () => {
  await db.CareProfiles.insert({care_profile_id:'CP-1',owner_line_id:'U-OWNER-1111',patient_name:'คุณแม่ตัวอย่าง'});
  await db.CareProfileMembers.insert({member_id:'MEM-1',care_profile_id:'CP-1',line_user_id:'U-CARE-2222',role:'caregiver',status:'active',permissions:['view']});
  const caregivers = await (await family('/api/care-profile/CP-1/caregivers', {}, 'U-OWNER-1111')).json();
  assert.equal(caregivers.members[0].displayIdentity, 'บัญชี LINE ••••2222'); assert.doesNotMatch(JSON.stringify(caregivers), /U-CARE-2222|line_user/i);

  const center = await centerService.createCenter({name:'ศูนย์ตัวอย่าง',ownerLineId:'U-OWNER-1111'});
  await db.CenterStaff.insert({staff_id:'STF-1',center_id:center.center_id,line_user_id:'U-STAFF-3333',role:'staff',status:'active'});
  const team = await (await family(`/api/center/staff?centerId=${center.center_id}`, {}, 'U-OWNER-1111')).json();
  assert.match(team.staff[1].display_identity, /••••3333/); assert.doesNotMatch(JSON.stringify(team), /U-STAFF-3333|line_user/i);
  const adminStaff = await (await admin(`/api/admin/centers/${center.center_id}/staff`)).json();
  assert.doesNotMatch(JSON.stringify(adminStaff), /U-STAFF-3333|lineUserId|line_user/);
});

test('ordinary System Admin Center detail contains relationships but no clinical facts', async () => {
  const center = await centerService.createCenter({name:'ศูนย์ตัวอย่าง',ownerLineId:'U-OWNER-1111'});
  const resident = await db.Residents.insert({resident_id:'RES-1',center_id:center.center_id,full_name:'คุณสมใจ',room:'A201',status:'active',care_profile_id:'CP-1'});
  await db.CareProfiles.insert({care_profile_id:'CP-1',center_id:center.center_id,owner_line_id:'U-FAMILY',patient_name:'คุณสมใจ',status:'linked',blood_type:'O+',chronic_conditions:['เบาหวาน'],drug_allergies:'ยาเอ',food_allergies:'ถั่ว'});
  assert.ok(resident);
  const detail = await (await admin(`/api/admin/centers/${center.center_id}`)).json();
  const relationships = await (await admin(`/api/admin/centers/${center.center_id}/care-profiles`)).json();
  const serialized = JSON.stringify({detail,relationships});
  assert.match(serialized, /คุณสมใจ/);
  assert.doesNotMatch(serialized, /O\+|เบาหวาน|ยาเอ|ถั่ว|blood_type|chronic|allerg/i);
  assert.doesNotMatch(serialized, /U-FAMILY|U-OWNER-1111/);
});
