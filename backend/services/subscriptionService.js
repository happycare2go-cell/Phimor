const { Centers, CenterStaff, Residents, CareProfiles, audit, now } = require('../db');
const notificationService = require('./notificationService');
const { formatThaiDateTime } = require('../utils/thaiDate');
const { displayIdentity, maskedInternalReference } = require('../utils/safeIdentity');

const DAY_MS = 86400000;

function parseDate(value, field) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`${field} ไม่ถูกต้อง`);
  return date;
}

function entitlement(center, at = new Date()) {
  if (!center) return { allowed: false, code: 'center_not_found' };
  if (center.status !== 'active') return { allowed: false, code: 'center_suspended' };
  // Existing installations are not locked out until an administrator has set
  // their first package period.
  if (!center.subscription_start_at || !center.subscription_end_at) {
    if (center.subscription_required) return { allowed: false, code: 'subscription_unconfigured' };
    return { allowed: true, code: 'legacy_unconfigured', needsConfiguration: true };
  }
  const start = new Date(center.subscription_start_at);
  const end = new Date(center.subscription_end_at);
  if (at < start) return { allowed: false, code: 'subscription_not_started', startsAt: start.toISOString(), expiresAt: end.toISOString() };
  if (at > end) return { allowed: false, code: 'subscription_expired', expiresAt: end.toISOString() };
  const remainingDays = Math.max(0, Math.ceil((end.getTime() - at.getTime()) / DAY_MS));
  return { allowed: true, code: 'active', startsAt: start.toISOString(), expiresAt: end.toISOString(), remainingDays };
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
  const owners = await CenterStaff.findWhere((s) => s.center_id === centerId && s.role === 'owner');
  const text = `✅ สิทธิการใช้ระบบพี่หมอของ ${center.name} ได้รับการอัปเดตแล้ว\nท่านสามารถใช้งานระบบได้ถึงวันที่ ${formatThaiDateTime(end.toISOString())}`;
  for (const owner of owners) {
    await notificationService.enqueueAndDeliver({
      dedupeKey: `subscription-updated:${centerId}:${end.toISOString()}:${owner.line_user_id}`,
      to: owner.line_user_id, kind: 'subscription_updated', meta: { centerId, expiresAt: end.toISOString() },
      messages: [{ type: 'text', text }],
    });
  }
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

module.exports = { entitlement, setSubscription, sendExpiryReminders, getAdminCenterDetails };
