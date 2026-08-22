// One continuous, production-shaped journey across system admin, center owner,
// family, transport, medication, reminders, manager access and revocation.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../backend/db');
const lineClient = require('../backend/providers/lineClient');
const reminderService = require('../backend/services/reminderService');

let server;
let baseUrl;

before(async () => {
  server = http.createServer(require('../backend/server'));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => new Promise((resolve) => server.close(resolve)));
beforeEach(() => { db.resetAll(); lineClient.clearSentLog(); });

async function request(path, { user, admin = false, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(user ? { 'X-Line-User-Id': user } : {}),
      ...(admin ? { 'X-Admin-Key': process.env.ADMIN_API_KEY } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('json') ? await response.json() : await response.arrayBuffer();
  return { response, data };
}

function expectStatus(result, status, label) {
  assert.strictEqual(result.response.status, status, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

test('เส้นทางจริงครบวงจร: เปิดศูนย์ → Care Profile → นัด → เดินทาง → ยา → แจ้งเตือน → ถอนผู้จัดการ', async () => {
  const OWNER = 'U_OWNER';
  const FAMILY = 'U_FAMILY';
  const MANAGER = 'U_MANAGER';
  const testToday = new Date('2030-01-10T08:00:00+07:00');
  const appointmentAt = '2030-01-11T10:30:00+07:00';

  // 1) System admin creates and activates the branch subscription.
  const center = expectStatus(await request('/api/admin/centers', {
    admin: true, method: 'POST', body: {
      name: 'Happy Home Test', ownerLineId: OWNER,
      subscriptionStartAt: '2025-01-01T00:00:00+07:00',
      subscriptionEndAt: '2031-12-31T23:59:59+07:00', packageType: 'annual',
    },
  }), 201, 'create center');
  const centerId = center.centerId;

  const me = expectStatus(await request('/api/center/me', { user: OWNER }), 200, 'owner login');
  assert.strictEqual(me.centers[0].myRole, 'owner');

  // 2) Owner creates a resident and a complete center-managed Care Profile.
  const resident = expectStatus(await request(`/api/residents?centerId=${centerId}`, {
    user: OWNER, method: 'POST', body: { fullName: 'คุณสมศรี ใจดี', room: '203', familyPhone: '0812345678' },
  }), 201, 'create resident');
  const inviteToken = new URL(resident.inviteUrl).searchParams.get('token');
  assert.ok(inviteToken);

  const profile = expectStatus(await request(`/api/residents/${resident.residentId}/care-profile?centerId=${centerId}`, {
    user: OWNER, method: 'POST', body: {
      gender: 'female', bloodType: 'O', heightCm: 155, weightKg: 52,
      chronicConditions: ['เบาหวาน', 'ความดันโลหิตสูง'], drugAllergies: 'เพนิซิลลิน',
      foodAllergies: 'กุ้ง', mobilityLimitations: 'ใช้ไม้เท้า',
      emergencyContactName: 'คุณลูกสาว', emergencyContactPhone: '0899999999', familyPhone: '0812345678',
    },
  }), 201, 'create care profile');

  // 3) Family login is simulated, but consent and invite rules are real HTTP calls.
  assert.strictEqual((expectStatus(await request('/api/consent/check', { user: FAMILY }), 200, 'consent check')).hasConsent, false);
  expectStatus(await request('/api/consent', { user: FAMILY, method: 'POST', body: { accepted: true } }), 201, 'consent');
  expectStatus(await request(`/api/invite/${inviteToken}/accept`, { user: FAMILY, method: 'POST', body: {} }), 201, 'accept invite');
  const dashboard = expectStatus(await request('/api/init-dashboard', { user: FAMILY }), 200, 'family dashboard');
  assert.strictEqual(dashboard.profiles.length, 1);
  assert.strictEqual(dashboard.profiles[0].profile.care_profile_id, profile.care_profile_id);

  // 4) Family creates an appointment; the transport decision is created automatically.
  const appointment = expectStatus(await request('/api/appointments', {
    user: FAMILY, method: 'POST', body: {
      careProfileId: profile.care_profile_id, hospital: 'โรงพยาบาลสมิติเวช', datetime: appointmentAt, note: 'พบแพทย์เบาหวาน',
    },
  }), 201, 'create appointment');
  const familyPending = expectStatus(await request('/api/transport/family/pending', { user: FAMILY }), 200, 'family pending');
  assert.strictEqual(familyPending.pending.length, 1);
  const planId = familyPending.pending[0].plan_id;

  expectStatus(await request(`/api/transport/${planId}/family-choice`, {
    user: FAMILY, method: 'POST', body: { choice: 'request_center' },
  }), 200, 'family asks center');
  const centerPending = expectStatus(await request(`/api/transport/pending?centerId=${centerId}`, { user: OWNER }), 200, 'center pending screen');
  assert.strictEqual(centerPending.pending[0].plan_id, planId);
  expectStatus(await request(`/api/center/ratecard?centerId=${centerId}`, {
    user: OWNER, method: 'POST', body: { escortEnabled: true, escortPrice: 800, vehicleEnabled: true, vehiclePrice: 1200 },
  }), 200, 'configure center rate card');
  expectStatus(await request(`/api/transport/${planId}/center-choice`, {
    user: OWNER, method: 'POST', body: { centerId, choice: 'center_own', needs: ['escort', 'vehicle'] },
  }), 200, 'center transport choice');

  // 5) Medication update is immediately visible in the center clinical summary.
  expectStatus(await request(`/api/care-profile/${profile.care_profile_id}/medication-snapshots`, {
    user: FAMILY, method: 'POST', body: { items: [{ name: 'Metformin', dose: '500 mg', frequency: 'หลังอาหารเช้า-เย็น' }] },
  }), 201, 'medication snapshot');
  const clinical = expectStatus(await request(`/api/residents/${resident.residentId}/clinical-summary?centerId=${centerId}`, {
    user: OWNER,
  }), 200, 'clinical summary');
  assert.strictEqual(clinical.summary.currentMedications[0].name, 'Metformin');
  assert.ok(clinical.summary.drugAllergies.includes('เพนิซิลลิน'));

  // 6) Accelerated clock: one call represents the scheduler reaching the day before.
  lineClient.clearSentLog();
  const reminder = await reminderService.sendAppointmentReminders(testToday);
  assert.strictEqual(reminder.sent, 1);
  assert.ok(lineClient.getSentLog().some((entry) => entry.to === FAMILY && entry.messages[0].text.includes('พรุ่งนี้มีนัด')));
  assert.strictEqual((await reminderService.sendAppointmentReminders(testToday)).sent, 0, 'must not duplicate reminder');

  // 7) Owner promotes and revokes a manager; old access disappears immediately.
  expectStatus(await request(`/api/center/staff?centerId=${centerId}`, {
    user: OWNER, method: 'POST', body: { targetLineId: MANAGER },
  }), 201, 'appoint manager');
  expectStatus(await request(`/api/residents?centerId=${centerId}`, { user: MANAGER }), 200, 'manager access');
  expectStatus(await request(`/api/center/staff/${MANAGER}?centerId=${centerId}`, {
    user: OWNER, method: 'DELETE', body: { reason: 'ลาออก' },
  }), 200, 'revoke manager');
  expectStatus(await request(`/api/residents?centerId=${centerId}`, { user: MANAGER }), 403, 'revoked manager denied');

  // Keep references alive for failure diagnostics and verify no accidental cancellation.
  const savedAppointment = await db.Appointments.findOne((row) => row.appointment_id === appointment.appointment_id);
  assert.strictEqual(savedAppointment.status, 'confirmed');
});
