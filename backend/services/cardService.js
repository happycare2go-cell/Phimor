// services/cardService.js — FR-C (รับรูป) FR-D (จับคู่) FR-E (ยืนยัน/แก้ไข) FR-F (ส่งครอบครัว)
//
// ผังสถานะ (ตาม Technical Design หมวด 3.1) ขยายเพิ่ม awaiting_selection สำหรับกรณี
// AI จับคู่ผู้พักไม่ได้ทันที (ข้อ D3: ห้ามเดา ต้องถามก่อนเสมอ):
//
//   created → awaiting_selection → pending → editing → pending → confirmed
//                                      │                            │
//                                      └──────── (เกิน 24 ชม.) ──→ expired

const { PendingCards, Residents, GroupBindings, CareProfiles, Appointments, Medications, audit, id, now } = require('../db');
const aiProvider = require('../providers/aiProvider');
const lineClient = require('../providers/lineClient');
const { matchResident } = require('../utils/nameMatch');

const CARD_EXPIRY_HOURS = 24;   // ข้อ E10
const CARD_REMINDER_HOURS = 2;  // ข้อ E11

function isPast(datetimeStr) {
  if (!datetimeStr) return false;
  const d = new Date(datetimeStr);
  if (isNaN(d.getTime())) return false;
  return d.getTime() <= Date.now();
}

// ── FR-C, D: รับรูปจากกลุ่มงานศูนย์ → อ่าน → จับคู่ผู้พัก ──
async function handleIncomingPhoto({ centerId, imageBuffer, submittedBy }) {
  const aiResult = await aiProvider.interpretDocument(imageBuffer);

  // ข้อ C3: ไม่ใช่เอกสารทางการแพทย์ → ปฏิเสธสุภาพ ไม่สร้างการ์ด
  if (aiResult.documentType !== 'medical') {
    return { rejected: true, reason: aiResult.unrelatedNote || 'รูปนี้ไม่เกี่ยวข้องกับเอกสารทางการแพทย์' };
  }

  // ข้อ G2 ชั้นที่ 1: กันนัดที่เป็นอดีตตั้งแต่ตอน AI อ่านเสร็จ
  if (aiResult.appointment?.datetime && isPast(aiResult.appointment.datetime)) {
    return {
      rejected: true,
      reason: `วันที่ที่อ่านได้ (${aiResult.appointment.datetime}) เป็นเวลาที่ผ่านมาแล้ว AI อาจตีความวันที่ผิด กรุณาลองถ่ายใหม่ให้เห็นวันที่ชัดเจน`,
    };
  }

  const activeResidents = await Residents.findWhere((r) => r.center_id === centerId && r.status === 'active');
  const { matched, needsSelection, candidates } = matchResident(aiResult.nameGuess, activeResidents);

  // ข้อ E4: ต้องแสดงรูปต้นฉบับค้างไว้ในหน้าแก้ไขให้เทียบได้ — จึงต้องเก็บรูปไว้ ไม่ใช่ทิ้งหลัง AI อ่านเสร็จ
  const imageBase64 = imageBuffer && imageBuffer.length > 0 ? imageBuffer.toString('base64') : null;

  const card = await PendingCards.insert({
    card_id: id('CARD'),
    center_id: centerId,
    resident_id: matched ? matched.resident_id : null,
    ai_result: aiResult,
    edited_result: null,
    edited_fields: [],
    image_base64: imageBase64,
    submitted_by: submittedBy || null, // ใครเป็นคนถ่ายรูปส่งมา (ใช้แจ้งกลับเมื่อผู้จัดการยืนยันแล้ว)
    status: needsSelection ? 'awaiting_selection' : 'pending',
    created_at: now(),
    confirmed_by: null,
    confirmed_at: null,
  });

  return {
    rejected: false,
    card,
    needsSelection,
    candidates: needsSelection ? candidates.map((c) => ({ residentId: c.resident_id, fullName: c.full_name, room: c.room })) : [],
  };
}

// ── FR-D3: เมื่อ AI ไม่มั่นใจ ให้พนักงานเลือกจาก Quick Reply ──
async function selectResidentForCard(cardId, residentId) {
  const card = await PendingCards.findOne((c) => c.card_id === cardId);
  if (!card) return { ok: false, reason: 'ไม่พบการ์ด' };
  if (card.status !== 'awaiting_selection') return { ok: false, reason: 'การ์ดนี้ไม่ได้อยู่ในสถานะรอเลือกผู้พัก' };

  await PendingCards.update((c) => c.card_id === cardId, { resident_id: residentId, status: 'pending' });
  return { ok: true };
}

// ── FR-E3-E6: เปิดหน้าแก้ไข / บันทึกค่าที่แก้ (ข้อ E4: คืนรูปต้นฉบับด้วยเสมอ) ──
async function getCardForEdit(cardId) {
  const card = await PendingCards.findOne((c) => c.card_id === cardId);
  if (!card) return null;
  const resident = card.resident_id ? await Residents.findOne((r) => r.resident_id === card.resident_id) : null;
  return { card, resident, current: card.edited_result || card.ai_result, imageBase64: card.image_base64 || null };
}

// ── FR-E3, E6, E7, E8: บันทึกการแก้ไข พร้อมทำเครื่องหมายว่าช่องไหนถูกแก้ ──
async function patchCard(cardId, { residentId, appointment, medications, doctorNote, editedFields = [] }) {
  const card = await PendingCards.findOne((c) => c.card_id === cardId);
  if (!card) return { ok: false, reason: 'ไม่พบการ์ด' };
  if (card.status === 'confirmed') return { ok: false, reason: 'การ์ดนี้ถูกส่งไปแล้ว แก้ไขไม่ได้' };
  if (card.status === 'expired') return { ok: false, reason: 'การ์ดหมดอายุแล้ว กรุณาส่งรูปใหม่' };

  // ข้อ G2: กันวันที่อดีตตอนแก้ไขด้วย
  if (appointment?.datetime && isPast(appointment.datetime)) {
    return { ok: false, reason: 'ไม่สามารถบันทึกนัดที่เป็นเวลาในอดีตได้' };
  }

  const editedResult = {
    ...(card.edited_result || card.ai_result),
    ...(appointment !== undefined ? { appointment } : {}),
    ...(medications !== undefined ? { medications } : {}),
    ...(doctorNote !== undefined ? { doctorNote } : {}),
  };

  const patch = { edited_result: editedResult, edited_fields: [...new Set([...card.edited_fields, ...editedFields])] };
  if (residentId) patch.resident_id = residentId; // ข้อ E6: เปลี่ยนตัวผู้พักได้จากหน้าแก้ไข
  if (card.status === 'awaiting_selection' && residentId) patch.status = 'pending';

  const updated = await PendingCards.update((c) => c.card_id === cardId, patch);
  return { ok: true, card: updated };
}

// ── FR-E9-E12, FR-F: ยืนยันและส่งให้ครอบครัว ──
// ⚠️ เฉพาะเจ้าของศูนย์และผู้จัดการเท่านั้นที่ยืนยันได้ (พนักงานทั่วไปยืนยันไม่ได้)
//    เหตุผล: ต้องมีผู้รับผิดชอบชัดเจนต่อข้อมูลที่ส่งถึงครอบครัว และป้องกันการกดยืนยันโดยไม่ตรวจสอบ
async function confirmCard(cardId, confirmedByLineId, confirmedByName) {
  const card = await PendingCards.findOne((c) => c.card_id === cardId);
  if (!card) return { ok: false, reason: 'ไม่พบการ์ด' };

  // ตรวจสิทธิ์ก่อนอื่นใด
  const centerService = require('./centerService');
  const allowed = await centerService.canApprove(card.center_id, confirmedByLineId);
  if (!allowed) {
    return { ok: false, reason: 'เฉพาะเจ้าของศูนย์และผู้จัดการเท่านั้นที่ยืนยันข้อมูลได้', forbidden: true };
  }

  // ข้อ E9: ยืนยันได้ครั้งเดียว
  if (card.status === 'confirmed') {
    return { ok: false, reason: `ส่งไปแล้วเมื่อ ${card.confirmed_at} โดย ${card.confirmed_by}`, alreadyConfirmed: true };
  }
  // ข้อ E10: หมดอายุ
  const ageHours = (Date.now() - new Date(card.created_at).getTime()) / 3600000;
  if (ageHours > CARD_EXPIRY_HOURS || card.status === 'expired') {
    await PendingCards.update((c) => c.card_id === cardId, { status: 'expired' });
    return { ok: false, reason: 'การ์ดหมดอายุแล้ว กรุณาส่งรูปใหม่', expired: true };
  }
  if (card.status === 'awaiting_selection') {
    return { ok: false, reason: 'กรุณาเลือกผู้พักก่อนยืนยัน' };
  }
  if (!card.resident_id) {
    return { ok: false, reason: 'ยังไม่ทราบว่าเป็นข้อมูลของผู้พักคนใด' };
  }

  const resident = await Residents.findOne((r) => r.resident_id === card.resident_id);
  const data = card.edited_result || card.ai_result;

  // ข้อ G2 ชั้นที่ 2 (Safety Net สุดท้ายก่อนบันทึกจริง)
  if (data.appointment?.datetime && isPast(data.appointment.datetime)) {
    return { ok: false, reason: 'วันที่นัดเป็นเวลาที่ผ่านมาแล้ว ไม่สามารถบันทึกได้' };
  }

  // บันทึกยืนยัน
  await PendingCards.update((c) => c.card_id === cardId, {
    status: 'confirmed', confirmed_by: confirmedByLineId, confirmed_at: now(),
  });
  await audit('card.confirmed', confirmedByLineId, { cardId, residentId: card.resident_id, editedFields: card.edited_fields });

  // บันทึกลง Care Profile ถ้าผูกแล้ว
  let careProfile = null;
  if (resident.care_profile_id) {
    careProfile = await CareProfiles.findOne((p) => p.care_profile_id === resident.care_profile_id);
    if (data.appointment) {
      await Appointments.insert({
        appointment_id: id('APT'), care_profile_id: resident.care_profile_id,
        hospital: data.appointment.hospital, datetime: data.appointment.datetime, note: data.appointment.note || '',
        // ข้อ J5: บันทึกที่มาให้ครบ — ระบบใด (source) ศูนย์ใด (source_center_id) เมื่อใด (created_at)
        source: 'center_photo', source_center_id: card.center_id, created_by: confirmedByLineId, created_at: now(),
      });
    }
    for (const med of (data.medications || [])) {
      await Medications.insert({
        medication_id: id('MED'), care_profile_id: resident.care_profile_id,
        name: med.name, dose: med.dose, source: 'center_photo', source_center_id: card.center_id, created_at: now(),
      });
    }
  }

  // ── FR-F: ส่งเข้ากลุ่มครอบครัว ──
  let sentToFamily = false, queuedForLater = false;
  if (resident.care_profile_id) {
    const groupBinding = await GroupBindings.findOne((g) => g.care_profile_id === resident.care_profile_id && g.kind === 'family');
    const target = groupBinding ? groupBinding.line_group_id : (careProfile ? careProfile.owner_line_id : null);
    if (target) {
      await lineClient.pushMessage(target, [{
        type: 'text',
        text: buildFamilySummaryText({ residentName: resident.full_name, data, confirmedByName }),
        // ข้อ F4: แนบปุ่มแจ้งข้อมูลไม่ถูกต้องไว้กับข้อความนี้เสมอ ผูกกับ Quick Reply ของข้อความสุดท้าย
        quickReply: {
          items: [{
            type: 'action',
            action: { type: 'postback', label: '⚠️ ข้อมูลไม่ถูกต้อง', data: `action=report_issue&cardId=${cardId}` },
          }],
        },
      }]);
      sentToFamily = true;
    } else {
      queuedForLater = true; // ข้อ F3: เก็บไว้ส่งย้อนหลังเมื่อผูกสำเร็จ
    }
  } else {
    queuedForLater = true;
  }

  return { ok: true, status: 'confirmed', confirmedBy: confirmedByLineId, confirmedAt: now(), sentToFamily, queuedForLater, submittedBy: card.submitted_by };
}

// ── ข้อ F2: ข้อความต้องระบุผู้ตรวจสอบ ──
function buildFamilySummaryText({ residentName, data, confirmedByName }) {
  const lines = [`📋 อัปเดตข้อมูลของ ${residentName}`];
  if (data.appointment) {
    lines.push('', '📅 นัดครั้งหน้า', `${data.appointment.hospital} — ${data.appointment.datetime}`);
    if (data.appointment.note) lines.push(data.appointment.note);
  }
  if (data.medications?.length) {
    lines.push('', '💊 รายการยา', ...data.medications.map((m) => `${m.name} — ${m.dose}`));
  }
  if (data.doctorNote) lines.push('', '📋 คำสั่งแพทย์', data.doctorNote);
  lines.push('', `ตรวจสอบโดย ${confirmedByName || 'พนักงานศูนย์'}`); // ข้อ F2
  return lines.join('\n');
}

// ── ข้อ F4: ครอบครัวแจ้งว่าข้อมูลไม่ถูกต้อง → แจ้งกลับกลุ่มงานศูนย์ทันที ──
async function reportCardIssue(cardId, reporterLineId, note) {
  const card = await PendingCards.findOne((c) => c.card_id === cardId);
  if (!card) return { ok: false, reason: 'ไม่พบข้อมูลนี้ในระบบ' };
  if (card.status !== 'confirmed') return { ok: false, reason: 'แจ้งปัญหาได้เฉพาะข้อมูลที่ส่งไปแล้วเท่านั้น' };

  const { Centers, Residents: R } = require('../db');
  const center = await Centers.findOne((c) => c.center_id === card.center_id);
  const resident = card.resident_id ? await R.findOne((r) => r.resident_id === card.resident_id) : null;

  await audit('card.issue_reported', reporterLineId, { cardId, note });

  if (center?.group_id) {
    const lines = [
      '⚠️ ครอบครัวแจ้งว่าข้อมูลไม่ถูกต้อง',
      resident ? `ผู้พัก: ${resident.full_name}${resident.room ? ' · ห้อง ' + resident.room : ''}` : '',
      note ? `รายละเอียด: ${note}` : '',
      '',
      'กรุณาตรวจสอบและติดต่อครอบครัวเพื่อแก้ไขค่ะ',
    ].filter(Boolean);
    await lineClient.pushMessage(center.group_id, [{ type: 'text', text: lines.join('\n') }]);
    return { ok: true, notifiedCenter: true };
  }
  return { ok: true, notifiedCenter: false };
}

// ── ข้อ E11: เตือนถ้ายังไม่ยืนยันภายใน 2 ชม. (เรียกจาก Scheduler) ──
async function findCardsNeedingReminder() {
  const all = await PendingCards.findAll();
  const cutoff = Date.now() - CARD_REMINDER_HOURS * 3600000;
  return all.filter((c) =>
    ['pending', 'awaiting_selection'].includes(c.status) &&
    !c.reminder_sent &&
    new Date(c.created_at).getTime() <= cutoff
  );
}

// ── เรียกจาก Scheduler ทุกช่วงเวลา: หมดอายุการ์ดที่เกิน 24 ชม. ──
async function expireOldCards() {
  const all = await PendingCards.findAll();
  const cutoff = Date.now() - CARD_EXPIRY_HOURS * 3600000;
  const toExpire = all.filter((c) => ['pending', 'awaiting_selection', 'editing'].includes(c.status) && new Date(c.created_at).getTime() <= cutoff);
  for (const c of toExpire) {
    await PendingCards.update((x) => x.card_id === c.card_id, { status: 'expired' });
  }
  return toExpire.length;
}

module.exports = {
  handleIncomingPhoto, selectResidentForCard, getCardForEdit, patchCard, confirmCard,
  findCardsNeedingReminder, expireOldCards, buildFamilySummaryText, reportCardIssue, isPast,
};
