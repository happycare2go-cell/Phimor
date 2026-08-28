const { createHash } = require('crypto');
const {
  CareProfiles, CareProfileMembers, Residents, Centers,
} = require('../db');
const { formatThaiDateTime } = require('../utils/thaiDate');
const notificationService = require('./notificationService');
const {
  findActiveFamilyBinding,
  findActiveCenterBindingByCenter,
} = require('./groupBindingRepository');

const MATERIAL_FIELD_MAP = Object.freeze({
  hospital: 'hospital',
  datetime: 'datetime',
  note: 'note',
  clinicOrDepartment: 'clinic_or_department',
  clinic_or_department: 'clinic_or_department',
  reasonForVisit: 'reason_for_visit',
  reason_for_visit: 'reason_for_visit',
  relatedCondition: 'related_condition',
  related_condition: 'related_condition',
  doctorName: 'doctor_name',
  doctor_name: 'doctor_name',
});

const MATERIAL_FIELD_LABELS = Object.freeze({
  hospital: 'สถานที่',
  datetime: 'วันและเวลา',
  note: 'หมายเหตุ',
  clinic_or_department: 'แผนก/คลินิก',
  reason_for_visit: 'วัตถุประสงค์การนัด',
  related_condition: 'ข้อมูลที่เกี่ยวข้อง',
  doctor_name: 'แพทย์',
});

function normalizeComparable(field, value) {
  if (field === 'datetime') {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? String(timestamp) : String(value || '').trim();
  }
  return String(value ?? '').trim();
}

function materialPatch(current, input = {}) {
  const patch = {};
  const changedFields = [];
  for (const [inputField, storedField] of Object.entries(MATERIAL_FIELD_MAP)) {
    if (!(inputField in input) || storedField in patch) continue;
    const value = typeof input[inputField] === 'string' ? input[inputField].trim() : input[inputField];
    if (normalizeComparable(storedField, current?.[storedField]) === normalizeComparable(storedField, value)) continue;
    patch[storedField] = value;
    changedFields.push(storedField);
  }
  return { patch, changedFields };
}

async function resolveAppointmentContext(careProfileId) {
  const profile = await CareProfiles.findOne((item) => item.care_profile_id === careProfileId);
  if (!profile) return { profile:null, resident:null, center:null, relationship:'profile_missing' };
  const activeResidents = await Residents.findWhere((item) => (
    item.care_profile_id === careProfileId && item.status === 'active'
  ));
  if (activeResidents.length === 0) return { profile, resident:null, center:null, relationship:'independent' };
  if (activeResidents.length !== 1) return { profile, resident:null, center:null, relationship:'ambiguous' };
  const resident = activeResidents[0];
  const center = await Centers.findOne((item) => item.center_id === resident.center_id && item.status === 'active');
  if (!center) return { profile, resident, center:null, relationship:'center_inactive' };
  return { profile, resident, center, relationship:'center_linked' };
}

async function resolveFamilyTargets(careProfileId, profile = null) {
  const binding = await findActiveFamilyBinding(careProfileId);
  if (binding) return [{ to:binding.line_group_id, mode:'family_group', logicalReference:'primary' }];
  const resolvedProfile = profile || await CareProfiles.findOne((item) => item.care_profile_id === careProfileId);
  if (!resolvedProfile) return [];
  const members = await CareProfileMembers.findWhere((item) => (
    item.care_profile_id === careProfileId
      && item.status === 'active'
      && item.notification_opt_out !== true
  ));
  const targets = [];
  if (resolvedProfile.owner_line_id) targets.push({
    to:resolvedProfile.owner_line_id, mode:'family_fallback', logicalReference:'primary',
  });
  for (const member of members) {
    if (!member.line_user_id || targets.some((target) => target.to === member.line_user_id)) continue;
    targets.push({
      to:member.line_user_id, mode:'family_fallback',
      logicalReference:`member-${targetReference(member.line_user_id)}`,
    });
  }
  return targets;
}

async function resolveCenterTarget(context) {
  if (context.relationship !== 'center_linked') return null;
  const binding = await findActiveCenterBindingByCenter(context.center.center_id);
  return binding ? { to:binding.line_group_id, mode:'center_staff_group' } : null;
}

function targetReference(target) {
  return createHash('sha256').update(String(target || '')).digest('hex').slice(0, 20);
}

function appointmentDetails(appointment) {
  const lines = [formatThaiDateTime(appointment.datetime)];
  if (appointment.hospital) lines.push(String(appointment.hospital));
  if (appointment.clinic_or_department) lines.push(String(appointment.clinic_or_department));
  if (appointment.doctor_name) lines.push(`แพทย์ ${appointment.doctor_name}`);
  return lines;
}

function lifecycleLabel(eventType) {
  if (eventType === 'created') return 'มีนัดหมายใหม่';
  if (eventType === 'updated') return 'นัดหมายมีการเปลี่ยนแปลง';
  return 'ยกเลิกนัดหมายแล้ว';
}

function buildLifecycleMessage({ eventType, audience, appointment, context, changedFields = [] }) {
  const profileName = context.profile?.patient_name || context.resident?.full_name || 'Care Profile';
  const centerIdentity = [context.resident?.full_name || profileName, context.resident?.room ? `ห้อง ${context.resident.room}` : '']
    .filter(Boolean).join(' · ');
  const lines = audience === 'center'
    ? [lifecycleLabel(eventType).replace('แล้ว', ''), centerIdentity]
    : [`${profileName} — ${lifecycleLabel(eventType)}`];
  if (eventType === 'cancelled') lines.push(`นัดเดิม ${formatThaiDateTime(appointment.datetime)}`);
  else lines.push(...appointmentDetails(appointment));
  if (eventType === 'updated' && changedFields.length) {
    lines.push(`เปลี่ยนแปลง: ${changedFields.map((field) => MATERIAL_FIELD_LABELS[field]).filter(Boolean).join(', ')}`);
  }
  if (eventType === 'cancelled' && appointment.hospital) lines.push(String(appointment.hospital));
  return lines.filter(Boolean).join('\n');
}

function buildReminderMessage({ audience, reminderKind, appointment, context }) {
  const profileName = context.profile?.patient_name || context.resident?.full_name || 'Care Profile';
  const label = reminderKind === 'day_before' ? 'พรุ่งนี้มีนัด' : 'วันนี้มีนัด';
  if (audience === 'center') {
    const identity = [context.resident?.full_name || profileName, context.resident?.room ? `ห้อง ${context.resident.room}` : '']
      .filter(Boolean).join(' · ');
    return [label, identity, ...appointmentDetails(appointment)].filter(Boolean).join('\n');
  }
  return [`${profileName} — ${label}`, ...appointmentDetails(appointment)].filter(Boolean).join('\n');
}

async function enqueueSafely(input, deliver = false) {
  try {
    const result = await (deliver ? notificationService.enqueueAndDeliver(input) : notificationService.enqueue(input));
    return {
      ok:result.ok === true,
      duplicate:result.duplicate === true,
      status:result.ok
        ? (result.duplicate ? 'already_queued' : deliver ? 'delivered_or_accepted' : 'queued')
        : 'unavailable',
      reason:result.ok ? null : (result.reason || 'notification_unavailable'),
      retryable:result.ok ? false : result.retryable !== false,
    };
  } catch (_error) {
    return { ok:false, duplicate:false, status:'unavailable', reason:'notification_enqueue_unavailable', retryable:true };
  }
}

async function notifyLifecycle({ eventType, appointment, changedFields = [], deliver = false }) {
  const context = await resolveAppointmentContext(appointment.care_profile_id);
  const revision = eventType === 'updated' ? `v${Number(appointment.version || 1)}` : eventType;
  const results = { family:[], center:null, relationship:context.relationship };
  const familyTargets = await resolveFamilyTargets(appointment.care_profile_id, context.profile);
  for (const target of familyTargets) {
    results.family.push(await enqueueSafely({
      dedupeKey:`appointment-lifecycle:${appointment.appointment_id}:${revision}:family:${target.logicalReference}`,
      to:target.to,
      kind:`appointment_${eventType}_family`,
      meta:{ appointmentId:appointment.appointment_id, careProfileId:appointment.care_profile_id, audience:'family', eventType, revision, routing:target.mode },
      messages:[{ type:'text', text:buildLifecycleMessage({ eventType, audience:'family', appointment, context, changedFields }) }],
    }, deliver));
  }
  if (context.relationship === 'center_linked') {
    const target = await resolveCenterTarget(context);
    results.center = target ? await enqueueSafely({
      dedupeKey:`appointment-lifecycle:${appointment.appointment_id}:${revision}:center`,
      to:target.to,
      kind:`appointment_${eventType}_center`,
      meta:{ appointmentId:appointment.appointment_id, careProfileId:appointment.care_profile_id, centerId:context.center.center_id, audience:'center', eventType, revision, routing:target.mode },
      messages:[{ type:'text', text:buildLifecycleMessage({ eventType, audience:'center', appointment, context, changedFields }) }],
    }, deliver) : { ok:false, duplicate:false, status:'held', reason:'center_group_not_bound', retryable:false };
  }
  return results;
}

async function notifyReminder({ appointment, reminderKind, includeCenter = false, deliver = true }) {
  const context = await resolveAppointmentContext(appointment.care_profile_id);
  const results = { family:[], center:null, relationship:context.relationship };
  const familyTargets = await resolveFamilyTargets(appointment.care_profile_id, context.profile);
  for (const target of familyTargets) {
    results.family.push(await enqueueSafely({
      dedupeKey:`appointment-reminder:${appointment.appointment_id}:${reminderKind}:family:${target.logicalReference}`,
      to:target.to,
      kind:'appointment_reminder',
      meta:{ appointmentId:appointment.appointment_id, careProfileId:appointment.care_profile_id, audience:'family', reminderKind, routing:target.mode },
      messages:[{ type:'text', text:buildReminderMessage({ audience:'family', reminderKind, appointment, context }) }],
    }, deliver));
  }
  if (includeCenter && context.relationship === 'center_linked') {
    const target = await resolveCenterTarget(context);
    results.center = target ? await enqueueSafely({
      dedupeKey:`appointment-reminder:${appointment.appointment_id}:${reminderKind}:center`,
      to:target.to,
      kind:'appointment_reminder_center',
      meta:{ appointmentId:appointment.appointment_id, careProfileId:appointment.care_profile_id, centerId:context.center.center_id, audience:'center', reminderKind, routing:target.mode },
      messages:[{ type:'text', text:buildReminderMessage({ audience:'center', reminderKind, appointment, context }) }],
    }, deliver) : { ok:false, duplicate:false, status:'held', reason:'center_group_not_bound', retryable:false };
  }
  return results;
}

module.exports = {
  MATERIAL_FIELD_MAP,
  MATERIAL_FIELD_LABELS,
  materialPatch,
  resolveAppointmentContext,
  resolveFamilyTargets,
  resolveCenterTarget,
  buildLifecycleMessage,
  buildReminderMessage,
  notifyLifecycle,
  notifyReminder,
};
