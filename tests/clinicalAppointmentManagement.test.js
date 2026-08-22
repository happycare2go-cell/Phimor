const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const reminderService = require('../backend/services/reminderService');
const lineClient = require('../backend/providers/lineClient');

let server, baseUrl;
before(async () => {
  server = http.createServer(require('../backend/server'));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => new Promise((resolve) => server.close(resolve)));
beforeEach(() => { db.resetAll(); lineClient.clearSentLog(); });

async function setup() {
  const center = await centerService.createCenter({ name:'ศูนย์ทดสอบ', ownerLineId:'U_OWNER' });
  await db.CenterStaff.insert({ staff_id:'S1', center_id:center.center_id, line_user_id:'U_STAFF', role:'staff' });
  const profile = await db.CareProfiles.insert({ care_profile_id:'CP1', owner_line_id:'U_FAMILY', center_id:center.center_id, status:'linked', patient_name:'คุณยาย', blood_type:'O+', chronic_conditions:['เบาหวาน'], drug_allergies:'Penicillin', food_allergies:'กุ้ง', mobility_limitations:'ใช้ไม้เท้า', emergency_contact_name:'ลูกสาว', emergency_contact_phone:'0811111111' });
  const resident = await db.Residents.insert({ resident_id:'R1', center_id:center.center_id, care_profile_id:profile.care_profile_id, full_name:'คุณยาย', room:'101', status:'active' });
  await db.MedicationSnapshots.insert({ snapshot_id:'MS1', care_profile_id:'CP1', items:[{name:'Metformin',dose:'500 mg'}], recorded_at:'2098-01-01T00:00:00Z' });
  return { center, profile, resident };
}

function api(path, user='U_STAFF', opts={}) { return fetch(baseUrl+path, { ...opts, headers:{'Content-Type':'application/json','X-Line-User-Id':user,...(opts.headers||{})} }); }

test('พนักงานเห็น Clinical Summary ที่จำเป็น แต่เปิด Care Profile เต็มไม่ได้', async () => {
  const { center } = await setup();
  const summaryRes = await api(`/api/residents/R1/clinical-summary?centerId=${center.center_id}`);
  assert.strictEqual(summaryRes.status, 200);
  const { summary } = await summaryRes.json();
  assert.strictEqual(summary.drugAllergies, 'Penicillin');
  assert.strictEqual(summary.currentMedications[0].name, 'Metformin');
  assert.strictEqual('owner_line_id' in summary, false);
  const fullRes = await api(`/api/residents/R1/care-profile?centerId=${center.center_id}`);
  assert.strictEqual(fullRes.status, 403);
});

test('owner แก้นัดได้และการแก้วันนัดรีเซ็ตสถานะเตือน', async () => {
  const { center } = await setup();
  await db.Appointments.insert({ appointment_id:'A1', care_profile_id:'CP1', hospital:'เก่า', datetime:'2099-01-01T09:00:00Z', day_before_reminded:true, same_day_reminded:true, status:'confirmed' });
  const result = await centerService.updateAppointment({ centerId:center.center_id, appointmentId:'A1', patch:{hospital:'ใหม่',datetime:'2099-02-01T09:00:00Z'}, requesterLineId:'U_OWNER' });
  assert.strictEqual(result.ok,true); assert.strictEqual(result.appointment.hospital,'ใหม่');
  assert.strictEqual(result.appointment.day_before_reminded,false);
});

test('ยกเลิกนัดแบบเก็บประวัติแล้วหยุดการแจ้งเตือนและไม่แสดงในนัดที่จะถึง', async () => {
  const { center } = await setup();
  await db.Appointments.insert({ appointment_id:'A1', care_profile_id:'CP1', hospital:'รพ.', datetime:'2050-01-02T09:00:00+07:00', status:'confirmed' });
  const cancelled = await centerService.cancelAppointment({ centerId:center.center_id, appointmentId:'A1', requesterLineId:'U_OWNER', reason:'แพทย์เลื่อน' });
  assert.strictEqual(cancelled.ok,true); assert.strictEqual(cancelled.appointment.status,'cancelled');
  assert.strictEqual((await centerService.getCenterAppointments(center.center_id)).length,0);
  const reminders = await reminderService.sendAppointmentReminders(new Date('2050-01-01T08:00:00+07:00'));
  assert.strictEqual(reminders.sent,0);
});

test('owner บันทึกราคาบริการผ่าน POST สำหรับ LINE in-app browser ได้', async () => {
  const { center } = await setup();
  const res = await api(`/api/center/ratecard?centerId=${encodeURIComponent(center.center_id)}`, 'U_OWNER', {
    method:'POST', body:JSON.stringify({ escortEnabled:true, escortPrice:'800', vehicleEnabled:true, vehiclePrice:'1200' }),
  });
  assert.strictEqual(res.status, 200);
  const saved = await res.json();
  assert.strictEqual(saved.escort_enabled, true);
  assert.strictEqual(saved.escort_price, 800);
  assert.strictEqual(saved.vehicle_price, 1200);
});
