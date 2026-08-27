const { CareProfiles, GroupBindings } = require('../db');
const notificationService = require('./notificationService');

const PROJECTION_VERSION = 'family-care-v2';
const KINDS = Object.freeze({
  vital_signs: Object.freeze({ kind:'family_vital_signs_recorded', title:'รายงานสัญญาณชีพ' }),
  daily_care: Object.freeze({ kind:'family_daily_care_recorded', title:'รายงานการดูแลประจำวัน' }),
});
const DAILY_LABELS = Object.freeze({
  nutrition:'อาหาร/โภชนาการ', fluid_intake:'ปริมาณน้ำ', sleep_rest:'การนอน/พักผ่อน',
  bowel_movement:'การขับถ่ายอุจจาระ', urination:'การปัสสาวะ', activity:'กิจกรรม',
  mood_behavior:'อารมณ์/พฤติกรรม', general_condition:'อาการโดยรวม', symptom_note:'อาการ/บันทึก',
});
const VITAL_LABELS = Object.freeze({
  temperature:'อุณหภูมิ', pulse:'ชีพจร', spo2:'SpO₂', respiratory_rate:'อัตราการหายใจ',
  blood_pressure_systolic:'ความดันตัวบน', blood_pressure_diastolic:'ความดันตัวล่าง',
});

function validId(value) {
  const clean = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(clean) ? clean : null;
}

function cleanText(value, max = 600, oneLine = false) {
  if (value === undefined || value === null) return null;
  let clean = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (oneLine) clean = clean.replace(/\s+/g, ' ');
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, Math.max(1, max - 1))}…` : clean;
}

function thaiDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    date:new Intl.DateTimeFormat('th-TH', { dateStyle:'medium', timeZone:'Asia/Bangkok' }).format(date),
    time:new Intl.DateTimeFormat('th-TH', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Asia/Bangkok' }).format(date),
  };
}

function displayUnit(value) {
  const unit = cleanText(value, 32, true);
  return unit === 'mm[Hg]' ? 'mmHg' : unit;
}

function observationValue(observation) {
  if (!observation) return null;
  const source = cleanText(observation.sourceValueText ?? observation.source_value_text, 80, true);
  const numeric = observation.numericValue ?? observation.numeric_value;
  const value = source || (Number.isFinite(Number(numeric)) ? String(Number(numeric)) : null);
  const unit = displayUnit(observation.sourceUnit ?? observation.source_unit);
  return value ? `${value}${unit ? `${unit === '%' ? '' : ' '}${unit}` : ''}` : null;
}

function renderVitals(observations = []) {
  const byType = new Map((Array.isArray(observations) ? observations : [])
    .map((item) => [item?.measurementType ?? item?.measurement_type, item]));
  const lines = [];
  const systolic = byType.get('blood_pressure_systolic');
  const diastolic = byType.get('blood_pressure_diastolic');
  const systolicValue = observationValue(systolic)?.split(' ')[0] || null;
  const diastolicValue = observationValue(diastolic)?.split(' ')[0] || null;
  if (systolicValue && diastolicValue) {
    const unit = displayUnit(systolic?.sourceUnit ?? systolic?.source_unit)
      || displayUnit(diastolic?.sourceUnit ?? diastolic?.source_unit);
    lines.push(`• ความดัน ${systolicValue}/${diastolicValue}${unit ? ` ${unit}` : ''}`);
    byType.delete('blood_pressure_systolic'); byType.delete('blood_pressure_diastolic');
  }
  for (const type of ['temperature', 'blood_pressure_systolic', 'blood_pressure_diastolic', 'pulse', 'spo2', 'respiratory_rate']) {
    const value = observationValue(byType.get(type));
    if (value) lines.push(`• ${VITAL_LABELS[type]} ${value}`);
  }
  return lines;
}

function itemValue(item) {
  const source = cleanText(item?.sourceValueText ?? item?.source_value_text, 600);
  if (source) return source;
  const valueType = item?.valueType ?? item?.value_type;
  if (valueType === 'text') return cleanText(item?.textValue ?? item?.text_value, 600);
  if (valueType === 'numeric') {
    const numeric = item?.numericValue ?? item?.numeric_value;
    if (!Number.isFinite(Number(numeric))) return null;
    const unit = displayUnit(item?.sourceUnit ?? item?.source_unit);
    return `${Number(numeric)}${unit ? ` ${unit}` : ''}`;
  }
  if (valueType === 'boolean') {
    const value = item?.booleanValue ?? item?.boolean_value;
    return typeof value === 'boolean' ? (value ? 'มี' : 'ไม่มี') : null;
  }
  return null;
}

function renderFamilyCareMessage({ kind, profile, projection = {} }) {
  const definition = KINDS[kind];
  if (!definition) return null;
  const lines = [definition.title];
  const recipientName = cleanText(profile?.patient_name || projection.careRecipientName, 160, true);
  const room = cleanText(projection.room, 80, true);
  const center = cleanText(projection.centerDisplayName, 200, true);
  const occurred = thaiDateTime(projection.occurredAt);
  const recorded = thaiDateTime(projection.recordedAt);
  if (recipientName) lines.push(`ผู้รับการดูแล: ${recipientName}`);
  if (room) lines.push(`ห้อง: ${room}`);
  if (center) lines.push(`ศูนย์/สาขา: ${center}`);
  if (occurred) lines.push(`วันที่ดูแล: ${occurred.date}`, `เวลาการดูแล: ${occurred.time} น.`);
  if (recorded && (!occurred || recorded.date !== occurred.date || recorded.time !== occurred.time)) {
    lines.push(`บันทึกเข้าระบบ: ${recorded.date} ${recorded.time} น.`);
  }

  const dailyItems = Array.isArray(projection.dailyCare) ? projection.dailyCare : [];
  const shift = dailyItems.find((item) => (item.itemType ?? item.item_type) === 'shift');
  const shiftValue = itemValue(shift);
  if (shiftValue) lines.push(`ช่วงเวลา/เวร: ${shiftValue}`);

  const vitalLines = renderVitals(projection.vitalSigns);
  if (vitalLines.length) lines.push('', 'สัญญาณชีพ', ...vitalLines);

  const dailyLines = dailyItems.filter((item) => (item.itemType ?? item.item_type) !== 'shift').flatMap((item) => {
    const type = item.itemType ?? item.item_type;
    const label = DAILY_LABELS[type]; const value = itemValue(item);
    return label && value ? [`• ${label}: ${value}`] : [];
  });
  if (dailyLines.length) lines.push('', 'การดูแลประจำวัน', ...dailyLines);

  const recorder = cleanText(projection.recorderDisplayName, 160, true);
  if (recorder) lines.push('', `ผู้บันทึก: ${recorder}`);
  lines.push('', 'ข้อมูลนี้เป็นข้อเท็จจริงตามที่บันทึกไว้ โดยไม่มีการแปลผลทางการแพทย์');
  const message = lines.join('\n');
  return message.length <= 4900 ? message : `${message.slice(0, 4899)}…`;
}

function createFamilyCareNotificationService(overrides = {}) {
  const profiles = overrides.CareProfiles || CareProfiles;
  const bindings = overrides.GroupBindings || GroupBindings;
  const enqueue = overrides.enqueue || notificationService.enqueue;

  async function resolveRecipient(careProfileId) {
    const profileId = validId(careProfileId);
    if (!profileId) return null;
    const binding = await bindings.findOne((row) => row.kind === 'family'
      && row.care_profile_id === profileId && row.status === 'active'
      && typeof row.line_group_id === 'string' && row.line_group_id.trim());
    if (binding) return { to:binding.line_group_id.trim(), type:'family_group', reference:binding.binding_id };
    const profile = await profiles.findOne((row) => row.care_profile_id === profileId
      && !['inactive', 'revoked', 'deleted'].includes(row.status));
    if (typeof profile?.owner_line_id === 'string' && profile.owner_line_id.trim()) {
      return { to:profile.owner_line_id.trim(), type:'profile_owner', reference:profileId };
    }
    return null;
  }

  async function enqueueRecorded({ kind, careProfileId, resourceId, projection = {} }) {
    const definition = KINDS[kind];
    const profileId = validId(careProfileId); const recordId = validId(resourceId);
    if (!definition || !profileId || !recordId) {
      throw Object.assign(new Error('invalid family notification intent'), { code:'INVALID_FAMILY_NOTIFICATION_INTENT', status:400 });
    }
    const recipient = await resolveRecipient(profileId);
    if (!recipient) return { ok:false, reason:'no_family_recipient' };
    const profile = await profiles.findOne((row) => row.care_profile_id === profileId) || null;
    const text = renderFamilyCareMessage({ kind, profile, projection });
    const dedupeKey = `care-recorded:${kind}:${recordId}:${PROJECTION_VERSION}:${recipient.type}:${recipient.reference}`;
    return enqueue({
      dedupeKey, to:recipient.to, kind:definition.kind,
      meta:{ careProfileId:profileId, resourceType:kind, resourceId:recordId,
        projectionVersion:PROJECTION_VERSION, recipientType:recipient.type },
      messages:[{ type:'text', text }],
    });
  }

  return { resolveRecipient, enqueueRecorded };
}

const familyCareNotificationService = createFamilyCareNotificationService();
module.exports = {
  KINDS, PROJECTION_VERSION, createFamilyCareNotificationService, familyCareNotificationService,
  renderFamilyCareMessage, renderVitals,
};
