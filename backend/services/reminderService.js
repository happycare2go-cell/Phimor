// services/reminderService.js — FR-G (แจ้งเตือนนัด 2 จังหวะ) FR-I (สรุปรายสัปดาห์ให้ศูนย์)

const { Appointments, Centers, Residents, now } = require('../db');
const { formatThaiDateTime } = require('../utils/thaiDate');
const notificationService = require('./notificationService');
const { findActiveCenterBindingByCenter } = require('./groupBindingRepository');
const appointmentNotificationService = require('./appointmentNotificationService');

function bangkokDateKey(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit',
  }).format(value);
}

function isSameDay(a, b) {
  const key = (d) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return key(a) === key(b);
}

// ── FR-G1: เตือนล่วงหน้า 1 วัน และเช้าวันนัด ──
async function sendAppointmentReminders(referenceDate = new Date()) {
  const all = await Appointments.findWhere(() => true);
  const tomorrow = new Date(referenceDate); tomorrow.setDate(tomorrow.getDate() + 1);
  let sent = 0;

  for (const appt of all) {
    if (appt.status === 'cancelled') continue;
    const apptDate = new Date(appt.datetime);
    if (isNaN(apptDate.getTime())) continue;

    let kind = null;
    if (isSameDay(apptDate, tomorrow)) kind = 'day_before';
    else if (isSameDay(apptDate, referenceDate)) kind = 'same_day';
    if (!kind) continue;

    const remindKey = `${kind}_reminded`;
    if (appt[remindKey]) continue; // กันเตือนซ้ำ

    const delivery = await appointmentNotificationService.notifyReminder({
      appointment:appt,
      reminderKind:kind,
      // The existing 18:00 Center tomorrow summary is the Center's one-day
      // operational reminder. Add only the missing day-of Center intent here.
      includeCenter:kind === 'same_day',
      deliver:true,
    });
    const familyAccepted = delivery.family.some((item) => item.ok);
    const createdIntent = delivery.family.some((item) => item.ok && !item.duplicate)
      || Boolean(delivery.center?.ok && !delivery.center?.duplicate);
    if (familyAccepted) {
      await Appointments.update((a) => a.appointment_id === appt.appointment_id && !a[remindKey], {
        [remindKey]: true, [`${kind}_reminded_at`]: now(),
      });
    }
    if (createdIntent) sent++;
  }
  return { sent };
}

// ── FR-I1, I2: สรุปนัดของสัปดาห์ถัดไปให้ผู้จัดการทุกวันอาทิตย์ ──
async function sendWeeklySummary(referenceDate = new Date()) {
  const weekStart = new Date(referenceDate);
  const weekEnd = new Date(referenceDate); weekEnd.setDate(weekEnd.getDate() + 7);

  const centers = await Centers.findWhere((c) => c.status === 'active');
  let sent = 0;

  for (const center of centers) {
    const centerBinding = await findActiveCenterBindingByCenter(center.center_id);
    if (!centerBinding) continue;
    const residents = await Residents.findWhere((r) => r.center_id === center.center_id && r.status === 'active');
    const residentProfileIds = new Set(residents.map((r) => r.care_profile_id).filter(Boolean));

    const allAppts = await Appointments.findWhere((a) => residentProfileIds.has(a.care_profile_id) && a.status !== 'cancelled');
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
    const delivery = await notificationService.enqueueAndDeliver({
      dedupeKey:`appointment-weekly-summary:${center.center_id}:${bangkokDateKey(referenceDate)}`,
      to:centerBinding.line_group_id, kind:'appointment_weekly_summary',
      meta:{ centerId:center.center_id, summaryDate:bangkokDateKey(referenceDate) },
      messages:[{ type:'text', text:lines.join('\n') }],
    });
    if (delivery.ok && !delivery.duplicate) sent++;
  }
  return { sent };
}

// ── FR-K3: สรุปนัดของวันพรุ่งนี้เข้ากลุ่มงานศูนย์ทุกเย็น พร้อมระบุรายการที่ยังค้างอยู่ ──
async function sendTomorrowSummaryToCenters(referenceDate = new Date()) {
  const { TransportPlans } = require('../db');
  const tomorrow = new Date(referenceDate); tomorrow.setDate(tomorrow.getDate() + 1);

  const centers = await Centers.findWhere((c) => c.status === 'active');
  let sent = 0;

  for (const center of centers) {
    const centerBinding = await findActiveCenterBindingByCenter(center.center_id);
    if (!centerBinding) continue;
    const residents = await Residents.findWhere((r) => r.center_id === center.center_id && r.status === 'active');
    const profileToResident = new Map(residents.filter((r) => r.care_profile_id).map((r) => [r.care_profile_id, r]));

    const allAppts = await Appointments.findWhere((a) => profileToResident.has(a.care_profile_id) && a.status !== 'cancelled');
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

    const summaryDate = bangkokDateKey(tomorrow);
    const delivery = await notificationService.enqueueAndDeliver({
      dedupeKey:`appointment-tomorrow-summary:${center.center_id}:${summaryDate}`,
      to:centerBinding.line_group_id, kind:'appointment_tomorrow_summary',
      meta:{ centerId:center.center_id, summaryDate },
      messages:[{ type:'text', text:lines.join('\n') }],
    });
    if (delivery.ok && !delivery.duplicate) sent++;
  }
  return { sent };
}

module.exports = { sendAppointmentReminders, sendWeeklySummary, sendTomorrowSummaryToCenters, bangkokDateKey };
