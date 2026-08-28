// services/cardService.js — FR-C (รับรูป) FR-D (จับคู่) FR-E (ยืนยัน/แก้ไข) FR-F (ส่งครอบครัว)
//
// ผังสถานะ (ตาม Technical Design หมวด 3.1) ขยายเพิ่ม awaiting_selection สำหรับกรณี
// AI จับคู่ผู้พักไม่ได้ทันที (ข้อ D3: ห้ามเดา ต้องถามก่อนเสมอ):
//
//   created → awaiting_selection → pending → editing → pending → confirmed
//                                      │                            │
//                                      └──────── (เกิน 24 ชม.) ──→ expired

const { PendingCards, Residents, CareProfiles, Appointments, Medications, MedicationSnapshots, audit, id, now } = require('../db');
const { findActiveFamilyBinding } = require('./groupBindingRepository');
const aiProvider = require('../providers/aiProvider');
const lineClient = require('../providers/lineClient');
const { matchResident } = require('../utils/nameMatch');
const { createLabDocumentIngestionService, sourceImageProjection } = require('./labDocumentIngestionService');

let labDocumentIngestionService = null;

function getLabDocumentIngestionService() {
  if (!labDocumentIngestionService) labDocumentIngestionService = createLabDocumentIngestionService();
  return labDocumentIngestionService;
}

const CARD_EXPIRY_HOURS = 24;   // ข้อ E10
const CARD_REMINDER_HOURS = 2;  // ข้อ E11

function isPast(datetimeStr) {
  if (!datetimeStr) return false;
  const d = new Date(datetimeStr);
  if (isNaN(d.getTime())) return false;
  return d.getTime() <= Date.now();
}

// ── FR-C, D: รับรูปจากกลุ่มงานศูนย์ → อ่าน → จับคู่ผู้พัก ──
async function handleIncomingPhoto({ centerId, imageBuffer, imageMimeType = 'image/jpeg', submittedBy }) {
  const aiResult = await aiProvider.interpretDocument(imageBuffer, imageMimeType);

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

  let labCandidate = null;
  let labExtractionErrorCode = null;
  if (aiResult.documentSubtype === 'lab_report') {
    try {
      labCandidate = await getLabDocumentIngestionService().extractDraftCandidate({
        imageBuffer, imageMimeType, careProfileId: matched?.care_profile_id || null,
      });
    } catch (error) {
      labExtractionErrorCode = error?.code || 'LAB_EXTRACTION_FAILED';
    }
  }

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
    image_mime_type: imageMimeType || null,
    image_byte_size: imageBuffer?.length || 0,
    document_subtype: aiResult.documentSubtype || null,
    lab_extraction_candidate: labCandidate,
    lab_extraction_status: aiResult.documentSubtype === 'lab_report'
      ? (labExtractionErrorCode ? 'extraction_failed' : 'extracted') : null,
    lab_extraction_error_code: labExtractionErrorCode,
    lab_report_id: null,
    submitted_by: submittedBy || null, // ใครเป็นคนถ่ายรูปส่งมา (ใช้แจ้งกลับเมื่อผู้จัดการยืนยันแล้ว)
    status: needsSelection ? 'awaiting_selection' : 'pending',
    created_at: now(),
    confirmed_by: null,
    confirmed_at: null,
  });

  let currentCard = card;
  let labDraftUnavailable = false;
  if (aiResult.documentSubtype === 'lab_report' && matched && submittedBy) {
    try {
      const draft = await getLabDocumentIngestionService().ensureDraftForPendingCard({
        cardId: card.card_id, lineUserId: submittedBy, extraction: labCandidate,
      });
      if (draft.ok) currentCard = await PendingCards.findOne((item) => item.card_id === card.card_id);
    } catch (_) {
      // The Pending Card and source image remain available for a safe manual
      // retry. Never convert an ingestion failure into confirmed Lab data.
      labDraftUnavailable = true;
    }
  }

  return {
    rejected: false,
    card: currentCard,
    needsSelection,
    labExtractionFailed: Boolean(labExtractionErrorCode),
    labDraftUnavailable,
    candidates: needsSelection ? candidates.map((c) => ({ residentId: c.resident_id, fullName: c.full_name, room: c.room })) : [],
  };
}

// ── FR-D3: เมื่อ AI ไม่มั่นใจ ให้พนักงานเลือกจาก Quick Reply ──
async function selectResidentForCard(cardId, residentId, selectedByLineUserId = null) {
  const card = await PendingCards.findOne((c) => c.card_id === cardId);
  if (!card) return { ok: false, reason: 'ไม่พบการ์ด' };
  if (card.status !== 'awaiting_selection') return { ok: false, reason: 'การ์ดนี้ไม่ได้อยู่ในสถานะรอเลือกผู้พัก' };
  const resident = await Residents.findOne((r) => r.resident_id === residentId && r.center_id === card.center_id && r.status === 'active');
  if (!resident) return { ok: false, reason: 'ผู้พักไม่ได้อยู่ในสาขาของเอกสารนี้' };

  await PendingCards.update((c) => c.card_id === cardId && c.status === 'awaiting_selection', { resident_id: residentId, status: 'pending' });
  if ((card.document_subtype || card.ai_result?.documentSubtype) === 'lab_report') {
    if (!selectedByLineUserId) return { ok: false, reason: 'ไม่พบตัวตนผู้ตรวจสอบผล Lab' };
    const draft = await getLabDocumentIngestionService().ensureDraftForPendingCard({
      cardId, lineUserId: selectedByLineUserId,
    });
    if (!draft.ok && draft.needsCareProfile) {
      return { ok: true, needsCareProfile: true };
    }
  }
  return { ok: true };
}

// ── FR-E3-E6: เปิดหน้าแก้ไข / บันทึกค่าที่แก้ (ข้อ E4: คืนรูปต้นฉบับด้วยเสมอ) ──
async function getCardForEdit(cardId, lineUserId = null) {
  const card = await PendingCards.findOne((c) => c.card_id === cardId);
  if (!card) return null;
  if ((card.document_subtype || card.ai_result?.documentSubtype) === 'lab_report') {
    if (!lineUserId) return { ok: false, reason: 'ไม่พบตัวตนผู้ตรวจสอบผล Lab' };
    const review = await getLabDocumentIngestionService().getReview({ cardId, lineUserId });
    if (!review.ok) {
      const sourceImage = sourceImageProjection(card);
      return {
        ...review,
        card: {
          cardId: card.card_id, centerId: card.center_id, residentId: card.resident_id,
          status: card.status, documentSubtype: 'lab_report', createdAt: card.created_at,
        },
        sourceImage,
        imageBase64: sourceImage.status === 'available' ? card.image_base64 : null,
        imageMimeType: sourceImage.mimeType,
      };
    }
    return review;
  }
  const resident = card.resident_id ? await Residents.findOne((r) => r.resident_id === card.resident_id) : null;
  const sourceImage = sourceImageProjection(card);
  return {
    card, resident, current: card.edited_result || card.ai_result, sourceImage,
    imageBase64: sourceImage.status === 'available' ? card.image_base64 : null,
    imageMimeType: sourceImage.mimeType,
  };
}

// ── FR-E3, E6, E7, E8: บันทึกการแก้ไข พร้อมทำเครื่องหมายว่าช่องไหนถูกแก้ ──
async function patchCard(cardId, { residentId, appointment, medications, doctorNote, labReport, editedFields = [] }, lineUserId = null) {
  const card = await PendingCards.findOne((c) => c.card_id === cardId);
  if (!card) return { ok: false, reason: 'ไม่พบการ์ด' };
  if (card.status === 'confirmed') return { ok: false, reason: 'การ์ดนี้ถูกส่งไปแล้ว แก้ไขไม่ได้' };
  if (card.status === 'expired') return { ok: false, reason: 'การ์ดหมดอายุแล้ว กรุณาส่งรูปใหม่' };

  if ((card.document_subtype || card.ai_result?.documentSubtype) === 'lab_report') {
    if (!lineUserId) return { ok: false, reason: 'ไม่พบตัวตนผู้ตรวจสอบผล Lab' };
    if (!labReport) return { ok: false, reason: 'ไม่พบข้อมูลผล Lab ที่ต้องบันทึก' };
    if (residentId && residentId !== card.resident_id) {
      return { ok: false, reason: 'กรุณาเลือกผู้พักผ่านขั้นตอนจับคู่ก่อนแก้ผล Lab' };
    }
    const result = await getLabDocumentIngestionService().updateReview({ cardId, lineUserId, labReport });
    return result.ok ? { ok: true, card: result.report, labReport: result.report } : result;
  }

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
  const result = await require('../db').withTransaction(`card-confirm:${cardId}`, async () => {
  const card = await PendingCards.findOne((c) => c.card_id === cardId);
  if (!card) return { ok: false, reason: 'ไม่พบการ์ด' };

  // ตรวจสิทธิ์ก่อนอื่นใด
  const centerService = require('./centerService');
  const allowed = await centerService.canApprove(card.center_id, confirmedByLineId);
  if (!allowed) {
    return { ok: false, reason: 'เฉพาะเจ้าของศูนย์และผู้จัดการเท่านั้นที่ยืนยันข้อมูลได้', forbidden: true };
  }
  const center = await require('../db').Centers.findOne((c) => c.center_id === card.center_id);
  const entitlement = require('./subscriptionService').entitlement(center);
  if (!entitlement.allowed) {
    return { ok: false, reason: 'สิทธิ์แพ็กเกจของศูนย์ไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ', forbidden: true };
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

  const resident = await Residents.findOne((r) => r.resident_id === card.resident_id && r.center_id === card.center_id && r.status === 'active');
  if (!resident) return { ok:false, reason:'ผู้พักไม่ได้อยู่ในสาขานี้แล้ว กรุณายกเลิกรายการ' };

  if ((card.document_subtype || card.ai_result?.documentSubtype) === 'lab_report') {
    if (card.lab_extraction_status !== 'reviewed') {
      return {
        ok: false,
        reason: 'กรุณาเปิดหน้าตรวจสอบผล Lab เทียบเอกสารต้นฉบับ และบันทึกฉบับร่างก่อนยืนยัน',
        requiresReview: true,
      };
    }
    let confirmed;
    try {
      confirmed = await getLabDocumentIngestionService().confirmReview({
        cardId, lineUserId: confirmedByLineId,
      });
    } catch (error) {
      return {
        ok: false,
        reason: error?.code === 'CONFIRMATION_REQUIRES_OBSERVATIONS'
          ? 'กรุณาตรวจสอบและเพิ่มรายการผล Lab อย่างน้อย 1 รายการก่อนยืนยัน'
          : error?.code === 'LAB_REVIEW_REQUIRED'
            ? 'กรุณาเปิดหน้าตรวจสอบผล Lab เทียบเอกสารต้นฉบับ และบันทึกฉบับร่างก่อนยืนยัน'
            : 'ยังยืนยันผล Lab ไม่สำเร็จ กรุณาตรวจสอบข้อมูลและลองใหม่',
        requiresReview: error?.code === 'LAB_REVIEW_REQUIRED',
      };
    }
    if (!confirmed.ok) return { ok: false, reason: 'ยังไม่สามารถสร้างผล Lab สำหรับ Care Profile นี้ได้' };
    const confirmedAt = now();
    await PendingCards.update((c) => c.card_id === cardId, {
      status: 'confirmed', confirmed_by: confirmedByLineId, confirmed_at: confirmedAt,
      lab_extraction_status: 'confirmed',
    });
    await audit('card.lab_confirmed', confirmedByLineId, {
      cardId, residentId: card.resident_id, reportId: confirmed.report.reportId,
      editedFields: card.edited_fields,
    });
    return {
      ok: true, status: 'confirmed', confirmedBy: confirmedByLineId,
      confirmedAt, sentToFamily: false, queuedForLater: false,
      submittedBy: card.submitted_by, labReport: confirmed.report,
    };
  }
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
  let transportPlan = null;
  let createdAppointment = null;
  if (resident.care_profile_id) {
    careProfile = await CareProfiles.findOne((p) => p.care_profile_id === resident.care_profile_id);
    if (data.appointment) {
      createdAppointment = await Appointments.insert({
        appointment_id: id('APT'), care_profile_id: resident.care_profile_id,
        hospital: data.appointment.hospital, datetime: data.appointment.datetime, note: data.appointment.note || '',
        clinic_or_department: data.appointment.clinicOrDepartment || '',
        reason_for_visit: data.appointment.reasonForVisit || '',
        related_condition: data.appointment.relatedCondition || '',
        doctor_name: data.appointment.doctorName || '',
        // ข้อ J5: บันทึกที่มาให้ครบ — ระบบใด (source) ศูนย์ใด (source_center_id) เมื่อใด (created_at)
        source: 'center_photo', source_center_id: card.center_id, created_by: confirmedByLineId, created_at: now(),
        status: 'confirmed', confirmed_from_card_id: cardId,
      });
      const transportService = require('./transportService');
      transportPlan = await transportService.launchTransportChoice({ appointment:createdAppointment, careProfileId:resident.care_profile_id, centerId:card.center_id, notifyFamily:false });
    }
    let medicationSnapshotId = null;
    if ((data.medications || []).length > 0) {
      const snapshot = await MedicationSnapshots.insert({
        snapshot_id: id('MEDS'), care_profile_id: resident.care_profile_id,
        items: data.medications, source: 'center_photo', source_card_id: cardId,
        recorded_by: confirmedByLineId, recorded_at: now(),
      });
      medicationSnapshotId = snapshot.snapshot_id;
    }
    for (const med of (data.medications || [])) {
      await Medications.insert({
        medication_id: id('MED'), care_profile_id: resident.care_profile_id,
        name: med.name, dose: med.dose, condition: med.condition || '', snapshot_id: medicationSnapshotId,
        source: 'center_photo', source_center_id: card.center_id, created_at: now(),
      });
    }
  }

  // ── FR-F: ส่งเข้ากลุ่มครอบครัว ──
  let sentToFamily = false, queuedForLater = false, postCommitFamilyDelivery = null;
  if (resident.care_profile_id) {
    const groupBinding = await findActiveFamilyBinding(resident.care_profile_id);
    const target = groupBinding ? groupBinding.line_group_id : (careProfile ? careProfile.owner_line_id : null);
    if (target) {
      const messages = [{
        type: 'text',
        text: buildFamilySummaryText({ residentName: resident.full_name, data, confirmedByName }),
        // ข้อ F4: แนบปุ่มแจ้งข้อมูลไม่ถูกต้องไว้กับข้อความนี้เสมอ ผูกกับ Quick Reply ของข้อความสุดท้าย
        quickReply: {
          items: [{
            type: 'action',
            action: { type: 'postback', label: '⚠️ ข้อมูลไม่ถูกต้อง', data: `action=report_issue&cardId=${cardId}` },
          }],
        },
      }];
      if (transportPlan && data.appointment) messages.push({ type:'text', text:`📅 ${resident.full_name} — กรุณาเปิด Family LIFF เพื่อเลือกวิธีเดินทางสำหรับนัดนี้\nhttps://liff.line.me/${process.env.LIFF_ID_FAMILY || 'YOUR_LIFF_ID'}?view=transport` });
      // Provider I/O happens only after the appointment/card transaction has
      // committed. A LINE outage must not roll back authoritative care data.
      postCommitFamilyDelivery = { target, messages, residentId:resident.resident_id, cardId };
    } else {
      queuedForLater = true; // ข้อ F3: เก็บไว้ส่งย้อนหลังเมื่อผูกสำเร็จ
    }
  } else {
    queuedForLater = true;
  }
  if (queuedForLater) {
    const delayedMessages = [{ type:'text', text:buildFamilySummaryText({ residentName:resident.full_name, data, confirmedByName }) }];
    await require('./deliveryService').queueForResident({ residentId:resident.resident_id, cardId, messages:delayedMessages });
  }

  return { ok: true, status: 'confirmed', confirmedBy: confirmedByLineId, confirmedAt: now(), sentToFamily, queuedForLater, submittedBy: card.submitted_by, appointmentForLifecycle:createdAppointment, postCommitFamilyDelivery };
  });
  if (result?.postCommitFamilyDelivery) {
    const delivery = result.postCommitFamilyDelivery;
    try {
      await lineClient.pushMessage(delivery.target, delivery.messages);
      result.sentToFamily = true;
    } catch (_error) {
      await require('./deliveryService').queueForResident({
        residentId:delivery.residentId, cardId:delivery.cardId, messages:delivery.messages,
      });
      result.queuedForLater = true;
    }
    delete result.postCommitFamilyDelivery;
  }
  if (result?.appointmentForLifecycle) {
    result.notificationState = await require('./appointmentNotificationService').notifyLifecycle({
      eventType:'created', appointment:result.appointmentForLifecycle,
    });
    delete result.appointmentForLifecycle;
  }
  return result;
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
  if (!resident?.care_profile_id || !await require('./familyService').canAccessProfile(resident.care_profile_id, reporterLineId)) {
    return { ok:false, reason:'คุณไม่มีสิทธิ์แจ้งปัญหาของ Care Profile นี้' };
  }

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

async function sendPendingCardReminders() {
  const cards = await findCardsNeedingReminder();
  let queued = 0;
  for (const card of cards) {
    const approvers = await require('./centerService').listApprovers(card.center_id);
    for (const approver of approvers) {
      await require('./notificationService').enqueueAndDeliver({
        dedupeKey:`pending-card:${card.card_id}:${approver.line_user_id}`,
        to:approver.line_user_id, kind:'pending_card_reminder', meta:{cardId:card.card_id,centerId:card.center_id},
        messages:[{type:'text',text:'⏳ มีเอกสารทางการแพทย์รอตรวจสอบเกิน 2 ชั่วโมง กรุณาเปิดหน้าศูนย์เพื่อยืนยันหรือแก้ไขค่ะ'}],
      });
      queued += 1;
    }
    await PendingCards.update((c) => c.card_id === card.card_id && !c.reminder_sent, { reminder_sent:true, reminder_sent_at:now() });
  }
  return { cards:cards.length, queued };
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

function setLabDocumentIngestionServiceForTests(service) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Lab ingestion override is test-only');
  labDocumentIngestionService = service || null;
}

module.exports = {
  handleIncomingPhoto, selectResidentForCard, getCardForEdit, patchCard, confirmCard,
  findCardsNeedingReminder, sendPendingCardReminders, expireOldCards, buildFamilySummaryText, reportCardIssue, isPast,
  setLabDocumentIngestionServiceForTests,
};
