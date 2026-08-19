// services/reminderService.js — FR-G (แจ้งเตือนนัด 2 จังหวะ) FR-I (สรุปรายสัปดาห์ให้ศูนย์)

const { Appointments, CareProfiles, GroupBindings, Centers, Residents, now } = require('../db');
const lineClient = require('../providers/lineClient');
const { formatThaiDateTime } = require('../utils/thaiDate');

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

async function resolveFamilyTarget(careProfileId) {
  const gb = await GroupBindings.findOne((g) => g.care_profile_id === careProfileId && g.kind === 'family');
  if (gb) return gb.line_group_id;
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId);
  return profile ? profile.owner_line_id : null;
}

// ── FR-G1: เตือนล่วงหน้า 1 วัน และเช้าวันนัด ──
async function sendAppointmentReminders(referenceDate = new Date()) {
  const all = await Appointments.findWhere(() => true);
  const tomorrow = new Date(referenceDate); tomorrow.setDate(tomorrow.getDate() + 1);
  let sent = 0;

  for (const appt of all) {
    const apptDate = new Date(appt.datetime);
    if (isNaN(apptDate.getTime())) continue;

    let kind = null;
    if (isSameDay(apptDate, tomorrow)) kind = 'day_before';
    else if (isSameDay(apptDate, referenceDate)) kind = 'same_day';
    if (!kind) continue;

    const remindKey = `${kind}_reminded`;
    if (appt[remindKey]) continue; // กันเตือนซ้ำ

    const target = await resolveFamilyTarget(appt.care_profile_id);
    if (target) {
      const label = kind === 'day_before' ? 'พรุ่งนี้มีนัด' : 'วันนี้มีนัด';
      await lineClient.pushMessage(target, [{
        type: 'text',
        text: `⏰ ${label}: ${appt.hospital} — ${formatThaiDateTime(appt.datetime)}`,
      }]);
      sent++;
    }
    appt[remindKey] = true; // ทำเครื่องหมายว่าเตือนแล้ว (in-memory เท่านั้น — ของจริงต้อง update ผ่าน DB)
  }
  return { sent };
}

// ── FR-I1, I2: สรุปนัดของสัปดาห์ถัดไปให้ผู้จัดการทุกวันอาทิตย์ ──
async function sendWeeklySummary(referenceDate = new Date()) {
  const weekStart = new Date(referenceDate);
  const weekEnd = new Date(referenceDate); weekEnd.setDate(weekEnd.getDate() + 7);

  const centers = await Centers.findWhere((c) => c.status === 'active' && c.group_id);
  let sent = 0;

  for (const center of centers) {
    const residents = await Residents.findWhere((r) => r.center_id === center.center_id && r.status === 'active');
    const residentProfileIds = new Set(residents.map((r) => r.care_profile_id).filter(Boolean));

    const allAppts = await Appointments.findWhere((a) => residentProfileIds.has(a.care_profile_id));
    const upcoming = allAppts.filter((a) => {
      const d = new Date(a.datetime);
      return d >= weekStart && d <= weekEnd;
    }).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

    if (upcoming.length === 0) continue;

    const lines = [`📅 สรุปนัดสัปดาห์นี้ (${upcoming.length} รายการ)`];
    for (const a of upcoming) {
      const resident = residents.find((r) => r.care_profile_id === a.care_profile_id);
      lines.push(`• ${resident?.full_name || 'ไม่ทราบชื่อ'} — ${a.hospital} · ${formatThaiDateTime(a.datetime)}`);
    }
    await lineClient.pushMessage(center.group_id, [{ type: 'text', text: lines.join('\n') }]);
    sent++;
  }
  return { sent };
}

// ── FR-K3: สรุปนัดของวันพรุ่งนี้เข้ากลุ่มงานศูนย์ทุกเย็น พร้อมระบุรายการที่ยังค้างอยู่ ──
async function sendTomorrowSummaryToCenters(referenceDate = new Date()) {
  const { TransportPlans } = require('../db');
  const tomorrow = new Date(referenceDate); tomorrow.setDate(tomorrow.getDate() + 1);

  const centers = await Centers.findWhere((c) => c.status === 'active' && c.group_id);
  let sent = 0;

  for (const center of centers) {
    const residents = await Residents.findWhere((r) => r.center_id === center.center_id && r.status === 'active');
    const profileToResident = new Map(residents.filter((r) => r.care_profile_id).map((r) => [r.care_profile_id, r]));

    const allAppts = await Appointments.findWhere((a) => profileToResident.has(a.care_profile_id));
    const tomorrowAppts = allAppts.filter((a) => isSameDay(new Date(a.datetime), tomorrow))
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

    if (tomorrowAppts.length === 0) continue; // ข้อ K3/I2: ไม่มีนัดก็ไม่ต้องส่งข้อความรบกวน

    const allPlans = await TransportPlans.findWhere((p) => p.center_id === center.center_id);
    const planByAppt = new Map(allPlans.map((p) => [p.appointment_id, p]));

    const lines = [`📅 สรุปนัดพรุ่งนี้ (${tomorrowAppts.length} รายการ)`];
    let pendingCount = 0;
    for (const a of tomorrowAppts) {
      const resident = profileToResident.get(a.care_profile_id);
      const plan = planByAppt.get(a.appointment_id);
      const stillPending = !plan || ['awaiting_family', 'awaiting_center'].includes(plan.status);
      if (stillPending) pendingCount++;
      const flag = stillPending ? ' ⚠️ ยังไม่ได้จัดการเดินทาง' : '';
      lines.push(`• ${resident?.full_name || 'ไม่ทราบชื่อ'} — ${a.hospital} · ${new Date(a.datetime).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' })}${flag}`);
    }
    if (pendingCount > 0) lines.push('', `⚠️ มี ${pendingCount} รายการที่ยังไม่ได้จัดการเดินทาง กรุณาตรวจสอบด่วน`);

    await lineClient.pushMessage(center.group_id, [{ type: 'text', text: lines.join('\n') }]);
    sent++;
  }
  return { sent };
}

module.exports = { sendAppointmentReminders, sendWeeklySummary, sendTomorrowSummaryToCenters };
