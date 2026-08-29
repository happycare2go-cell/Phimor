const { Centers, CenterStaff, Residents, CareProfiles, audit, now, withTransaction } = require('../db');
const notificationService = require('./notificationService');
const { formatThaiDateTime } = require('../utils/thaiDate');
const { displayIdentity, maskedInternalReference } = require('../utils/safeIdentity');

const DAY_MS = 86400000;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const MONTHLY_RENEWAL_DAYS = 30;
const MAX_MONTHLY_RENEWAL_UNITS = 3;

function parseDate(value, field) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`${field} ไม่ถูกต้อง`);
  return date;
}

// Center trials use one Bangkok calendar month, not 30 elapsed days. Shifting
// to Bangkok local time before doing UTC calendar arithmetic keeps the helper
// deterministic without depending on the host timezone (Thailand has no DST).
function addBangkokCalendarMonth(value) {
  const start = parseDate(value, 'วันเริ่มทดลองใช้');
  const local = new Date(start.getTime() + BANGKOK_OFFSET_MS);
  const sourceYear = local.getUTCFullYear();
  const sourceMonth = local.getUTCMonth();
  const targetMonthIndex = sourceMonth + 1;
  const targetYear = sourceYear + Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const lastTargetDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(local.getUTCDate(), lastTargetDay);
  const targetLocalTime = Date.UTC(
    targetYear, targetMonth, targetDay,
    local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds(),
  );
  return new Date(targetLocalTime - BANGKOK_OFFSET_MS);
}

function subscriptionChronology(center, at = new Date()) {
  const packageType = center?.subscription_package_type || null;
  const startsAt = center?.subscription_start_at || null;
  const expiresAt = center?.subscription_end_at || null;
  if (!startsAt || !expiresAt) {
    return { state:'not_configured', packageType, startsAt:null, expiresAt:null, remainingDays:null, needsConfiguration:true };
  }
  const start = new Date(startsAt);
  const end = new Date(expiresAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { state:'not_configured', packageType, startsAt:null, expiresAt:null, remainingDays:null, needsConfiguration:true };
  }
  if (at < start) {
    return { state:'not_started', packageType, startsAt:start.toISOString(), expiresAt:end.toISOString(), remainingDays:null, needsConfiguration:false };
  }
  if (at > end) {
    return { state:'expired', packageType, startsAt:start.toISOString(), expiresAt:end.toISOString(), remainingDays:0, needsConfiguration:false };
  }
  return {
    state:packageType === 'trial' ? 'trial' : 'active', packageType,
    startsAt:start.toISOString(), expiresAt:end.toISOString(),
    remainingDays:Math.max(0, Math.ceil((end.getTime() - at.getTime()) / DAY_MS)), needsConfiguration:false,
  };
}

function entitlement(center, at = new Date()) {
  if (!center) return { allowed:false, code:'center_not_found', operationalStatus:'not_found', state:'not_configured', packageType:null, startsAt:null, expiresAt:null, remainingDays:null, needsConfiguration:true };
  const chronology = subscriptionChronology(center, at);
  const operationalStatus = center.status === 'active' ? 'active' : 'suspended';
  if (operationalStatus !== 'active') return { ...chronology, allowed:false, code:'center_suspended', operationalStatus };
  // Existing installations are not locked out until an administrator has set
  // their first package period.
  if (chronology.state === 'not_configured') {
    const code = center.subscription_required ? 'subscription_unconfigured' : 'legacy_unconfigured';
    return { ...chronology, allowed:!center.subscription_required, code, operationalStatus };
  }
  if (chronology.state === 'not_started') return { ...chronology, allowed:false, code:'subscription_not_started', operationalStatus };
  if (chronology.state === 'expired') return { ...chronology, allowed:false, code:'subscription_expired', operationalStatus };
  return { ...chronology, allowed:true, code:'active', operationalStatus };
}

class MonthlyRenewalInputError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_MONTHLY_RENEWAL';
    this.status = 400;
  }
}

function normalizeRenewalUnits(value) {
  const units = Number(value);
  if (!Number.isSafeInteger(units) || units < 1 || units > MAX_MONTHLY_RENEWAL_UNITS) {
    throw new MonthlyRenewalInputError(`จำนวนเดือนต้องเป็นเลขจำนวนเต็มระหว่าง 1 ถึง ${MAX_MONTHLY_RENEWAL_UNITS}`);
  }
  return units;
}

function validStoredDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Paid monthly packages intentionally use fixed 30 x 24-hour units. This is
// separate from the Bangkok calendar-month helper used only for free trials.
function calculateMonthlyRenewal(center, renewalUnits, referenceDate = new Date()) {
  const units = normalizeRenewalUnits(renewalUnits);
  const reference = parseDate(referenceDate, 'เวลาอ้างอิง');
  const previousStart = validStoredDate(center?.subscription_start_at);
  const previousEnd = validStoredDate(center?.subscription_end_at);
  const preservesCurrentPeriod = Boolean(previousEnd && previousEnd > reference);
  const base = preservesCurrentPeriod ? previousEnd : reference;
  const startsAt = preservesCurrentPeriod && previousStart ? previousStart : reference;
  const expiresAt = new Date(base.getTime() + units * MONTHLY_RENEWAL_DAYS * DAY_MS);
  return {
    packageType:'monthly', renewalUnits:units,
    renewalDays:units * MONTHLY_RENEWAL_DAYS,
    previousExpiresAt:previousEnd?.toISOString() || null,
    baseAt:base.toISOString(), startsAt:startsAt.toISOString(), expiresAt:expiresAt.toISOString(),
    preservesCurrentPeriod,
  };
}

async function deliverSubscriptionUpdatedNotification(center, expiresAt) {
  const owners = await CenterStaff.findWhere((s) => s.center_id === center.center_id && s.role === 'owner');
  const text = `✅ สิทธิการใช้ระบบพี่หมอของ ${center.name} ได้รับการอัปเดตแล้ว\nท่านสามารถใช้งานระบบได้ถึงวันที่ ${formatThaiDateTime(expiresAt)}`;
  for (const owner of owners) {
    await notificationService.enqueueAndDeliver({
      dedupeKey:`subscription-updated:${center.center_id}:${expiresAt}:${owner.line_user_id}`,
      to:owner.line_user_id, kind:'subscription_updated', meta:{ centerId:center.center_id, expiresAt },
      messages:[{ type:'text', text }],
    });
  }
}

async function previewMonthlyRenewal({ centerId, renewalUnits, referenceDate = new Date() }) {
  const center = await Centers.findOne((item) => item.center_id === centerId);
  if (!center) return { ok:false, reason:'ไม่พบศูนย์นี้' };
  return { ok:true, ...calculateMonthlyRenewal(center, renewalUnits, referenceDate) };
}

async function renewMonthlySubscription({ centerId, renewalUnits, actor = 'admin', referenceDate = new Date() }) {
  const units = normalizeRenewalUnits(renewalUnits);
  const reference = parseDate(referenceDate, 'เวลาอ้างอิง');
  const result = await withTransaction(`center-subscription-renew:${centerId}`, async () => {
    const center = await Centers.findOne((item) => item.center_id === centerId);
    if (!center) return { ok:false, reason:'ไม่พบศูนย์นี้' };
    const renewal = calculateMonthlyRenewal(center, units, reference);
    const updated = await Centers.update((item) => item.center_id === centerId, {
      subscription_required:true,
      subscription_start_at:renewal.startsAt,
      subscription_end_at:renewal.expiresAt,
      subscription_package_type:'monthly',
      subscription_updated_at:now(),
      subscription_updated_by:actor,
    });
    await audit('center.subscription_updated', actor, {
      centerId, packageType:'monthly', renewalUnits:units, renewalDays:renewal.renewalDays,
      previousEnd:renewal.previousExpiresAt, startsAt:renewal.startsAt, expiresAt:renewal.expiresAt,
    });
    return { ok:true, center:updated, renewal, entitlement:entitlement(updated, reference) };
  });
  if (result.ok) await deliverSubscriptionUpdatedNotification(result.center, result.renewal.expiresAt);
  return result;
}

async function setSubscription({ centerId, startsAt, expiresAt, packageType = 'custom', note = '', actor = 'admin' }) {
  const center = await Centers.findOne((c) => c.center_id === centerId);
  if (!center) return { ok: false, reason: 'ไม่พบศูนย์นี้' };
  const start = parseDate(startsAt, 'วันเริ่มใช้');
  const end = parseDate(expiresAt, 'วันหมดอายุ');
  if (end <= start) return { ok: false, reason: 'วันหมดอายุต้องอยู่หลังวันเริ่มใช้' };
  const previousEnd = center.subscription_end_at || null;
  const updated = await Centers.update((c) => c.center_id === centerId, {
    subscription_start_at: start.toISOString(), subscription_end_at: end.toISOString(),
    subscription_package_type: packageType, subscription_note: String(note || '').slice(0, 500),
    subscription_updated_at: now(), subscription_updated_by: actor,
  });
  await audit('center.subscription_updated', actor, { centerId, startsAt: start.toISOString(), expiresAt: end.toISOString(), packageType, previousEnd });
  await deliverSubscriptionUpdatedNotification(center, end.toISOString());
  return { ok: true, center: updated, entitlement: entitlement(updated) };
}

async function sendExpiryReminders(referenceDate = new Date()) {
  const centers = await Centers.findWhere((c) => c.status === 'active' && c.subscription_end_at);
  let queued = 0;
  for (const center of centers) {
    const end = new Date(center.subscription_end_at);
    // Calendar-style warning: at any time on the date three days before
    // expiry, the owner should already receive the notice.
    const days = Math.floor((end.getTime() - referenceDate.getTime()) / DAY_MS);
    if (days < 0 || days > 3) continue;
    const owners = await CenterStaff.findWhere((s) => s.center_id === center.center_id && s.role === 'owner');
    for (const owner of owners) {
      const result = await notificationService.enqueueAndDeliver({
        dedupeKey: `subscription-expiry-3d:${center.center_id}:${end.toISOString()}:${owner.line_user_id}`,
        to: owner.line_user_id, kind: 'subscription_expiring', meta: { centerId: center.center_id, expiresAt: end.toISOString() },
        messages: [{ type: 'text', text: `⚠️ สิทธิการใช้ระบบพี่หมอของ ${center.name} จะหมดอายุภายใน 3 วัน\nวันหมดอายุ: ${formatThaiDateTime(end.toISOString())}\nกรุณาติดต่อเจ้าหน้าที่เพื่อดำเนินการต่ออายุแพ็กเกจค่ะ` }],
      });
      if (result.ok) queued += 1;
    }
  }
  return { queued };
}

async function getAdminCenterDetails(centerId) {
  const center = await Centers.findOne((c) => c.center_id === centerId);
  if (!center) return null;
  const staff = await CenterStaff.findWhere((s) => s.center_id === centerId);
  const residents = await Residents.findWhere((r) => r.center_id === centerId);
  const profileIds = new Set(residents.map((r) => r.care_profile_id).filter(Boolean));
  const profiles = await CareProfiles.findWhere((p) => profileIds.has(p.care_profile_id));
  const owner = staff.find((row) => row.role === 'owner' && row.line_user_id === center.owner_line_id) || staff.find((row) => row.role === 'owner');
  return {
    center:{
      centerId:center.center_id, name:center.name, status:center.status,
      address:center.address || '', contactPhone:center.contact_phone || '',
      ownerIdentity:displayIdentity({ displayName:owner?.display_name, lineUserId:center.owner_line_id }),
      reference:maskedInternalReference(center.center_id, 'ศูนย์'),
    },
    entitlement:entitlement(center),
    staff:staff.map((row) => ({ staffId:row.staff_id, role:row.role, status:row.status || 'active', displayIdentity:displayIdentity({ displayName:row.display_name, lineUserId:row.line_user_id }) })),
    residents:residents.map((row) => ({ residentId:row.resident_id, displayName:row.full_name, room:row.room || null, status:row.status, careProfileLinked:Boolean(row.care_profile_id) })),
    profiles:profiles.map((row) => ({ careProfileId:row.care_profile_id, displayName:row.patient_name, status:row.status })),
  };
}

module.exports = {
  DAY_MS, MONTHLY_RENEWAL_DAYS, MAX_MONTHLY_RENEWAL_UNITS,
  entitlement, subscriptionChronology, addBangkokCalendarMonth,
  MonthlyRenewalInputError, normalizeRenewalUnits, calculateMonthlyRenewal,
  previewMonthlyRenewal, renewMonthlySubscription,
  setSubscription, sendExpiryReminders, getAdminCenterDetails,
};
