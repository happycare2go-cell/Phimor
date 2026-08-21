// services/transportService.js — FR-K (ตารางนัดศูนย์) FR-L (ตัดสินใจ 2 ชั้น) FR-M (ราคา/ใบแจ้งหนี้)
//
// ผังสถานะ (ตาม Technical Design หมวด 6.1):
//
//   detected → awaiting_family ─┬→ family_handled                              (จบ)
//                                └→ awaiting_center ─┬→ center_handled          (2.1 ตัวการ)
//                                                     └→ care2go_requested ─┬→ care2go_confirmed   (2.2 ตัวแทน)
//                                                                            └→ care2go_unavailable → กลับ awaiting_center
//
// ⚠️ ข้อ L4 (ตัดสินใจแล้วในบทสนทนา): ศูนย์มีทางเลือกสองทางเท่านั้น "ศูนย์จัดการเอง" หรือ
//    "ใช้บริการ Care2Go" — ห้ามมีปุ่มปฏิเสธ เพราะตัวเลือก Care2Go ทำหน้าที่เป็นทางออกอยู่แล้ว
//    ครอบครัวที่กดขอให้ศูนย์จัดต้องมั่นใจได้ว่าจะมีคนจัดให้เสมอ

const { TransportPlans, CenterRateCards, Bills, GroupBindings, CareProfiles, audit, id, now } = require('../db');
const lineClient = require('../providers/lineClient');

const CARE2GO_UNAVAILABLE_DEADLINE_HOURS = 12; // ข้อ L11

// ── FR-K, L1: เมื่อมีนัดใหม่ สร้างแผนรอครอบครัวตัดสินใจ ──
async function createTransportPlan({ appointmentId, careProfileId, centerId }) {
  return TransportPlans.insert({
    plan_id: id('TP'),
    appointment_id: appointmentId,
    care_profile_id: careProfileId,
    center_id: centerId || null,
    family_choice: null, family_decided_by: null, family_decided_at: null,
    center_choice: null, center_decided_by: null, center_decided_at: null,
    liability_mode: null,
    assigned_staff: null, care2go_booking_id: null,
    needs: [], note: null,
    status: 'awaiting_family',
    reminder_stages_sent: [], // ข้อ L10: จังหวะเตือนที่ส่งไปแล้ว (stage_12h, stage_6h)
    history: [],
    created_at: now(),
  });
}

async function launchTransportChoice({ appointment, careProfileId, centerId, notifyFamily = true }) {
  if (!appointment?.appointment_id) return null;
  const existing = await TransportPlans.findOne((p) => p.appointment_id === appointment.appointment_id);
  const plan = existing || await createTransportPlan({ appointmentId: appointment.appointment_id, careProfileId, centerId });
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId);
  const target = await resolveFamilyTarget(careProfileId, profile);
  if (target && notifyFamily) {
    const liffId = process.env.LIFF_ID_FAMILY || 'YOUR_LIFF_ID';
    await lineClient.pushMessage(target, [{ type:'text', text:`📅 มีนัดใหม่ที่รอเลือกวิธีเดินทาง\n${appointment.hospital} — ${appointment.datetime}\n\nกรุณาเปิด Family LIFF เพื่อตรวจสอบและยืนยัน\nhttps://liff.line.me/${liffId}?view=transport` }]);
  }
  return plan;
}

async function bindCare2goOperationsGroup(groupId, actorLineId) {
  const old = await GroupBindings.findOne((g) => g.kind === 'care2go_ops' && g.status !== 'inactive');
  if (old && old.line_group_id !== groupId) await GroupBindings.update((g) => g.binding_id === old.binding_id, { status:'inactive', unbound_at:now() });
  let binding = await GroupBindings.findOne((g) => g.kind === 'care2go_ops' && g.line_group_id === groupId && g.status !== 'inactive');
  if (!binding) binding = await GroupBindings.insert({ binding_id:id('GB'), kind:'care2go_ops', line_group_id:groupId, status:'active', bound_by_line_user_id:actorLineId, bound_at:now() });
  await audit('care2go.group_bound', actorLineId, { groupId });
  return binding;
}

async function notifyCare2goOperations(planId, requestedByType) {
  const { Appointments, Centers, Residents } = require('../db');
  const plan = await TransportPlans.findOne((p) => p.plan_id === planId);
  const appointment = plan && await Appointments.findOne((a) => a.appointment_id === plan.appointment_id);
  if (!plan || !appointment) return { ok:false, reason:'ไม่พบข้อมูลคำขอ' };
  const center = plan.center_id ? await Centers.findOne((c) => c.center_id === plan.center_id) : null;
  const resident = plan.center_id ? await Residents.findOne((r) => r.center_id === plan.center_id && r.care_profile_id === plan.care_profile_id && r.status === 'active') : null;
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === plan.care_profile_id);
  const ops = await GroupBindings.findOne((g) => g.kind === 'care2go_ops' && g.status !== 'inactive');
  if (!ops) return { ok:false, reason:'ยังไม่ได้ผูกกลุ่มปฏิบัติการ Care2Go' };
  const contact = requestedByType === 'center' ? (center?.contact_phone || 'ยังไม่มีเบอร์ติดต่อศูนย์') : (profile?.emergency_contact_phone || profile?.family_phone || 'ยังไม่มีเบอร์ญาติ');
  const flex = require('../flexMessages');
  await lineClient.pushMessage(ops.line_group_id, [flex.care2goOperationsRequestFlex({
    planId, residentName:resident?.full_name || profile?.patient_name || 'ไม่ระบุ', destination:appointment.hospital,
    origin:[center?.name,center?.address].filter(Boolean).join(' — ') || 'ญาติแจ้งจุดรับทางโทรศัพท์', datetime:appointment.datetime,
    contact, requestedByType, needs:plan.needs || ['vehicle'], note:plan.note || '',
  })]);
  await appendHistory(planId, 'care2go_operations_notified');
  return { ok:true };
}

async function familyRequestCare2go(planId, requesterLineId) {
  const plan = await TransportPlans.findOne((p) => p.plan_id === planId);
  if (!plan || plan.status !== 'awaiting_family') return { ok:false, reason:'รายการนี้ไม่อยู่ในสถานะรอครอบครัว' };
  const ops = await GroupBindings.findOne((g) => g.kind === 'care2go_ops' && g.status !== 'inactive');
  const requireOps = process.env.REQUIRE_CARE2GO_OPS_BINDING === 'true' || (process.env.NODE_ENV !== 'test' && process.env.REQUIRE_CARE2GO_OPS_BINDING !== 'false');
  if (!ops && requireOps) return { ok:false, reason:'ยังไม่ได้เปิดรับคำขอ Care2Go กรุณาติดต่อเจ้าหน้าที่' };
  await TransportPlans.update((p) => p.plan_id === planId, { family_choice:'care2go', family_decided_by:requesterLineId, family_decided_at:now(), status:'care2go_requested', needs:['vehicle'], liability_mode:'agent', care2go_booking_id:id('B') });
  await appendHistory(planId,'family_choice=care2go'); await audit('transport.family_care2go',requesterLineId,{planId});
  const notified = await notifyCare2goOperations(planId,'family');
  return {ok:true,status:'care2go_requested',operationsNotified:notified.ok,operationsWarning:notified.ok?null:notified.reason};
}

async function care2goAcknowledge(planId, actorLineId, confirmed=false) {
  const plan = await TransportPlans.findOne((p) => p.plan_id === planId);
  if (!plan || !['care2go_requested','care2go_acknowledged'].includes(plan.status)) return {ok:false,reason:'สถานะคำขอไม่ถูกต้อง'};
  const status=confirmed?'care2go_confirmed':'care2go_acknowledged';
  await TransportPlans.update((p)=>p.plan_id===planId,{status,care2go_acknowledged_by:actorLineId,care2go_acknowledged_at:now()});
  await appendHistory(planId,confirmed?'care2go_confirmed':'care2go_acknowledged'); await audit(`transport.${status}`,actorLineId,{planId});
  const profile=await CareProfiles.findOne((p)=>p.care_profile_id===plan.care_profile_id); const target=await resolveFamilyTarget(plan.care_profile_id,profile);
  if(target) await lineClient.pushMessage(target,[{type:'text',text:confirmed?'✅ Care2Go ยืนยันการจัดบริการแล้ว ทีมงานจะโทรยืนยันรายละเอียดค่ะ':'✅ ทีม Care2Go รับเรื่องแล้ว กำลังประสานรถ/ผู้ดูแลค่ะ'}]);
  return {ok:true,status};
}

async function appendHistory(planId, event) {
  const plan = await TransportPlans.findOne((p) => p.plan_id === planId);
  const history = [...(plan.history || []), { event, at: now() }];
  return TransportPlans.update((p) => p.plan_id === planId, { history });
}

async function notifyAppointmentChanged(appointmentId, changeType, actorLineId) {
  const { Appointments } = require('../db');
  const plan = await TransportPlans.findOne((p) => p.appointment_id === appointmentId);
  if (!plan) return { ok: true, skipped: true };
  const appointment = await Appointments.findOne((a) => a.appointment_id === appointmentId);
  const ops = await GroupBindings.findOne((g) => g.kind === 'care2go_ops' && g.status !== 'inactive');
  if (ops && (plan.care2go_booking_id || ['care2go_requested','care2go_acknowledged','care2go_confirmed'].includes(plan.status))) {
    const label = changeType === 'cancelled' ? '❌ ยกเลิกนัด/คำขอบริการ' : '⚠️ นัดมีการแก้ไข กรุณาตรวจสอบข้อมูลล่าสุด';
    await require('./notificationService').enqueueAndDeliver({
      dedupeKey:`care2go-${changeType}:${plan.plan_id}:${appointment?.version || appointment?.updated_at || now()}`,
      to:ops.line_group_id, kind:`care2go_${changeType}`, meta:{planId:plan.plan_id,appointmentId},
      messages:[{type:'text',text:`${label}\nเลขคำขอ: ${plan.care2go_booking_id || plan.plan_id}\n${appointment?.hospital || ''} · ${appointment?.datetime || ''}`}],
    });
  }
  await appendHistory(plan.plan_id, `appointment_${changeType}`);
  await audit(`transport.appointment_${changeType}`, actorLineId, { planId:plan.plan_id, appointmentId });
  return { ok:true };
}

// ── FR-L1, L2: ครอบครัวเลือก "เราไปเอง" ──
async function familyChooseSelf(planId, requesterLineId) {
  const plan = await TransportPlans.findOne((p) => p.plan_id === planId);
  if (!plan) return { ok: false, reason: 'ไม่พบแผนการเดินทาง' };
  if (plan.status !== 'awaiting_family') return { ok: false, reason: 'รายการนี้ไม่ได้อยู่ในสถานะรอครอบครัวตัดสินใจ' };

  await TransportPlans.update((p) => p.plan_id === planId, {
    family_choice: 'self', family_decided_by: requesterLineId, family_decided_at: now(), status: 'family_handled',
  });
  await appendHistory(planId, 'family_choice=self');
  await audit('transport.family_self', requesterLineId, { planId });

  // แจ้งกลุ่มงานศูนย์เพื่อทราบ (ข้อ L2)
  if (plan.center_id) {
    const { Centers } = require('../db');
    const center = await Centers.findOne((c) => c.center_id === plan.center_id);
    if (center?.group_id) {
      await lineClient.pushMessage(center.group_id, [{ type: 'text', text: `ญาติแจ้งว่าจะพาไปเอง สำหรับนัดที่กำลังจะถึง` }]);
    }
  }
  return { ok: true, status: 'family_handled' };
}

// ── FR-L1, L3: ครอบครัวเลือก "ให้ศูนย์จัดการให้" ──
async function familyRequestCenter(planId, requesterLineId) {
  const plan = await TransportPlans.findOne((p) => p.plan_id === planId);
  if (!plan) return { ok: false, reason: 'ไม่พบแผนการเดินทาง' };
  if (plan.status !== 'awaiting_family') return { ok: false, reason: 'รายการนี้ไม่ได้อยู่ในสถานะรอครอบครัวตัดสินใจ' };
  if (!plan.center_id) return { ok: false, reason: 'ผู้สูงอายุไม่ได้อยู่ในความดูแลของศูนย์ ไม่สามารถส่งคำขอได้' };

  await TransportPlans.update((p) => p.plan_id === planId, {
    family_choice: 'request_center', family_decided_by: requesterLineId, family_decided_at: now(), status: 'awaiting_center',
  });
  await appendHistory(planId, 'family_choice=request_center');
  await audit('transport.family_request_center', requesterLineId, { planId });

  // ส่งการ์ดคำขอถึงเจ้าของ/ผู้จัดการเท่านั้น (ตามเกณฑ์ยอมรับข้อ 8)
  const { Centers } = require('../db');
  const center = await Centers.findOne((c) => c.center_id === plan.center_id);
  if (center?.group_id) {
    await lineClient.pushMessage(center.group_id, [{
      type: 'text', text: 'ญาติขอให้ศูนย์จัดการเรื่องการเดินทางไปพบแพทย์ — กรุณาเปิดรายการรอดำเนินการ',
    }]);
  }
  return { ok: true, status: 'awaiting_center' };
}

// ── FR-L4-L6: ศูนย์เลือก "จัดการเอง" หรือ "ใช้ Care2Go" — สองทางเท่านั้น ห้ามปฏิเสธ ──
// ข้อ M2: ถ้าศูนย์ปิดบริการรายการใด ต้องไม่เสนอให้ศูนย์จัดรายการนั้นเอง
async function centerChoose(planId, choice, requesterLineId, { needs = [], note } = {}) {
  return require('../db').withTransaction(`transport-choice:${planId}`, async () => {
  if (!['center_own', 'care2go'].includes(choice)) {
    return { ok: false, reason: 'ตัวเลือกไม่ถูกต้อง ต้องเป็น center_own หรือ care2go เท่านั้น' };
  }
  const plan = await TransportPlans.findOne((p) => p.plan_id === planId);
  if (!plan) return { ok: false, reason: 'ไม่พบแผนการเดินทาง' };
  if (plan.status !== 'awaiting_center') return { ok: false, reason: 'รายการนี้ไม่ได้อยู่ในสถานะรอศูนย์ตัดสินใจ' };
  if (!await require('./centerService').canApprove(plan.center_id, requesterLineId)) {
    return { ok: false, reason: 'เฉพาะเจ้าของศูนย์หรือผู้จัดการของสาขานี้เท่านั้นที่ตัดสินใจได้' };
  }
  if (choice === 'care2go' && (process.env.REQUIRE_CARE2GO_OPS_BINDING === 'true' || (process.env.NODE_ENV !== 'test' && process.env.REQUIRE_CARE2GO_OPS_BINDING !== 'false'))) {
    const ops = await GroupBindings.findOne((g) => g.kind === 'care2go_ops' && g.status !== 'inactive');
    if (!ops) return { ok: false, reason: 'ยังไม่ได้ผูกกลุ่มปฏิบัติการ Care2Go จึงยังส่งคำขอไม่ได้' };
  }

  // ข้อ M2: ตรวจว่าศูนย์เปิดให้บริการทุกรายการที่เลือก "จัดการเอง" จริงหรือไม่
  if (choice === 'center_own' && needs.length > 0) {
    const rateCard = await CenterRateCards.findOne((r) => r.center_id === plan.center_id);
    const closedItems = needs.filter((n) => {
      if (n === 'escort') return !rateCard?.escort_enabled;
      if (n === 'vehicle') return !rateCard?.vehicle_enabled;
      return false;
    });
    if (closedItems.length > 0) {
      const thaiLabel = { escort: 'คนเฝ้าไข้', vehicle: 'รถรับส่ง' };
      const list = closedItems.map((c) => thaiLabel[c] || c).join(' และ ');
      return { ok: false, reason: `ศูนย์ไม่ได้เปิดให้บริการ${list} กรุณาเลือก "ใช้บริการ Care2Go" สำหรับรายการนี้แทน` };
    }
  }

  const liabilityMode = choice === 'center_own' ? 'principal' : 'agent'; // ข้อ L5, L6
  const newStatus = choice === 'center_own' ? 'center_handled' : 'care2go_requested';

  await TransportPlans.update((p) => p.plan_id === planId, {
    center_choice: choice, center_decided_by: requesterLineId, center_decided_at: now(),
    liability_mode: liabilityMode, needs, note: note || null, status: newStatus,
  });
  await appendHistory(planId, `center_choice=${choice}`);
  await audit('transport.center_choice', requesterLineId, { planId, choice });

  const careProfile = await CareProfiles.findOne((cp) => cp.care_profile_id === plan.care_profile_id);
  const familyTarget = await resolveFamilyTarget(plan.care_profile_id, careProfile);

  let care2goBookingId = null;
  let familyText;

  if (choice === 'center_own') {
    // ข้อ L7: ครอบครัวต้องเห็นราคาและผู้ออกใบเสร็จ
    const rateCard = await CenterRateCards.findOne((r) => r.center_id === plan.center_id);
    const priceLines = [];
    if (needs.includes('escort') && rateCard?.escort_enabled) priceLines.push(`ค่าคนเฝ้าไข้ ${rateCard.escort_price} บาท`);
    if (needs.includes('vehicle') && rateCard?.vehicle_enabled) priceLines.push(`ค่ารถรับส่ง ${rateCard.vehicle_price} บาท`);
    familyText = ['ศูนย์รับจัดการเรื่องการเดินทางให้แล้ว', ...priceLines, '', 'ออกใบเสร็จโดยศูนย์'].join('\n');
  } else {
    care2goBookingId = id('B'); // ในระบบจริง: เรียก API ฝั่ง Care2Go เพื่อจองจริง
    await TransportPlans.update((p) => p.plan_id === planId, { care2go_booking_id: care2goBookingId });
    familyText = [
      'ศูนย์ประสาน Care2Go ให้แล้ว',
      'ทีมงาน Care2Go จะติดต่อคุณโดยตรงเพื่อยืนยันรายละเอียดและราคา',
      '', 'ออกใบเสร็จโดย Care2Go',
    ].join('\n');
    const opsResult = await notifyCare2goOperations(planId, 'center');
    var operationsNotified = opsResult.ok;
    var operationsWarning = opsResult.ok ? null : opsResult.reason;
  }

  if (familyTarget) await lineClient.pushMessage(familyTarget, [{ type: 'text', text: familyText }]);

  return { ok: true, status: newStatus, liabilityMode, care2goBookingId, familyNotified: !!familyTarget,
    operationsNotified: choice === 'care2go' ? operationsNotified : undefined,
    operationsWarning: choice === 'care2go' ? operationsWarning : undefined };
  });
}

// ── FR-L8: ศูนย์เปลี่ยนการตัดสินใจก่อนถึงนัดได้ — บันทึกประวัติทุกครั้ง ──
async function centerChangeChoice(planId, newChoice, requesterLineId, opts) {
  const plan = await TransportPlans.findOne((p) => p.plan_id === planId);
  if (!plan) return { ok: false, reason: 'ไม่พบแผนการเดินทาง' };
  if (!['center_handled', 'care2go_requested', 'care2go_confirmed'].includes(plan.status)) {
    return { ok: false, reason: 'รายการนี้ยังไม่เคยถูกจัดการ ใช้ centerChoose แทน' };
  }
  await appendHistory(planId, `changed_from=${plan.center_choice}`);
  await TransportPlans.update((p) => p.plan_id === planId, { status: 'awaiting_center' });
  return centerChoose(planId, newChoice, requesterLineId, opts);
}

// ── FR-L11: Care2Go จัดหาไม่ได้ — ต้องแจ้งกลับก่อนถึงเส้นตาย ──
async function markCare2goUnavailable(planId, appointmentDatetime) {
  const plan = await TransportPlans.findOne((p) => p.plan_id === planId);
  if (!plan || plan.status !== 'care2go_requested') return { ok: false, reason: 'สถานะไม่ตรงเงื่อนไข' };

  const hoursUntilAppt = (new Date(appointmentDatetime).getTime() - Date.now()) / 3600000;
  const onTime = hoursUntilAppt >= CARE2GO_UNAVAILABLE_DEADLINE_HOURS - 0.01; // เผื่อ floating point เล็กน้อย

  await TransportPlans.update((p) => p.plan_id === planId, { status: 'awaiting_center' });
  await appendHistory(planId, 'care2go_unavailable');

  const { Centers } = require('../db');
  const center = await Centers.findOne((c) => c.center_id === plan.center_id);
  const careProfile = await CareProfiles.findOne((cp) => cp.care_profile_id === plan.care_profile_id);
  const familyTarget = await resolveFamilyTarget(plan.care_profile_id, careProfile);

  if (center?.group_id) {
    await lineClient.pushMessage(center.group_id, [{ type: 'text', text: 'Care2Go ไม่สามารถจัดหาคนหรือรถให้ได้ กรุณาเลือกวิธีจัดการใหม่โดยเร็ว' }]);
  }
  if (familyTarget) {
    await lineClient.pushMessage(familyTarget, [{ type: 'text', text: 'ขออภัยค่ะ ตอนนี้ทีมงานกำลังจัดหาทางเลือกอื่นให้ จะแจ้งความคืบหน้าเร็วๆ นี้' }]);
  }
  return { ok: true, metDeadline: onTime };
}

async function resolveFamilyTarget(careProfileId, careProfile) {
  const groupBinding = await GroupBindings.findOne((g) => g.care_profile_id === careProfileId && g.kind === 'family' && g.status !== 'inactive');
  return groupBinding ? groupBinding.line_group_id : (careProfile ? careProfile.owner_line_id : null);
}

async function getPendingFamilyPlans(careProfileIds) {
  const { Appointments } = require('../db');
  const allowed = new Set(careProfileIds || []);
  const plans = await TransportPlans.findWhere((p) => allowed.has(p.care_profile_id) && p.status === 'awaiting_family');
  return Promise.all(plans.map(async (plan) => ({ ...plan, appointment:await Appointments.findOne((a) => a.appointment_id === plan.appointment_id) })));
}

// ── FR-L10: ครอบครัวไม่ตัดสินใจ → เตือนเพียง 2 จังหวะ คือเหลือ 12 ชม. และ 6 ชม. ──
// เดิมเตือนทุกชั่วโมงซึ่งถี่เกินไปจนสร้างความรำคาญ จึงกำหนดจังหวะที่ชัดเจนแทน
const FAMILY_REMINDER_STAGES = [
  { key: 'stage_12h', atOrBelowHours: 12, aboveHours: 6 },
  { key: 'stage_6h', atOrBelowHours: 6, aboveHours: 0 },
];

async function remindPendingFamilyChoices(referenceDate = new Date()) {
  const { Appointments, Centers } = require('../db');
  const pending = await TransportPlans.findWhere((p) => p.status === 'awaiting_family');

  let reminded = 0;
  for (const plan of pending) {
    const appt = await Appointments.findOne((a) => a.appointment_id === plan.appointment_id);
    if (!appt) continue;

    const hoursUntilAppt = (new Date(appt.datetime).getTime() - referenceDate.getTime()) / 3600000;
    if (hoursUntilAppt < 0) continue; // นัดผ่านไปแล้ว ไม่ต้องเตือน

    // หาจังหวะที่ตรงกับเวลาที่เหลือ และยังไม่เคยเตือนในจังหวะนั้น
    const stage = FAMILY_REMINDER_STAGES.find(
      (s) => hoursUntilAppt <= s.atOrBelowHours && hoursUntilAppt > s.aboveHours
    );
    if (!stage) continue;
    const sentStages = plan.reminder_stages_sent || [];
    if (sentStages.includes(stage.key)) continue; // เตือนจังหวะนี้ไปแล้ว

    const careProfile = await CareProfiles.findOne((cp) => cp.care_profile_id === plan.care_profile_id);
    const familyTarget = await resolveFamilyTarget(plan.care_profile_id, careProfile);
    const hoursLeftLabel = stage.key === 'stage_12h' ? 'ประมาณ 12 ชั่วโมง' : 'ประมาณ 6 ชั่วโมง';

    if (familyTarget) {
      await lineClient.pushMessage(familyTarget, [{
        type: 'text',
        text: `⏰ เหลืออีก${hoursLeftLabel}ก่อนถึงนัด ${appt.hospital} วันที่ ${new Date(appt.datetime).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' })}\nยังไม่ได้เลือกวิธีเดินทางเลยค่ะ`,
      }]);
    }

    // แจ้งศูนย์เฉพาะจังหวะสุดท้าย (เหลือ 6 ชม.) เพื่อไม่ให้ศูนย์ถูกรบกวนบ่อยเกินไป
    if (stage.key === 'stage_6h') {
      const center = await Centers.findOne((c) => c.center_id === plan.center_id);
      if (center?.group_id) {
        await lineClient.pushMessage(center.group_id, [{
          type: 'text', text: `⚠️ ครอบครัวยังไม่ตัดสินใจเรื่องการเดินทาง และเหลือเวลาอีกประมาณ 6 ชั่วโมงก่อนถึงนัด (รหัสนัด ${appt.appointment_id})`,
        }]);
      }
    }

    await TransportPlans.update((p) => p.plan_id === plan.plan_id, {
      reminder_stages_sent: [...sentStages, stage.key],
    });
    await appendHistory(plan.plan_id, `family_reminder_${stage.key}`);
    reminded++;
  }
  return { reminded };
}
async function getRateCard(centerId) {
  let rc = await CenterRateCards.findOne((r) => r.center_id === centerId);
  if (!rc) {
    rc = await CenterRateCards.insert({
      center_id: centerId, escort_enabled: false, escort_price: 0, vehicle_enabled: false, vehicle_price: 0,
      updated_by: null, updated_at: now(),
    });
  }
  return rc;
}

async function updateRateCard(centerId, patch, requesterLineId) {
  await getRateCard(centerId); // สร้างถ้ายังไม่มี
  const updated = await CenterRateCards.update((r) => r.center_id === centerId, {
    ...patch, updated_by: requesterLineId, updated_at: now(),
  });
  return updated;
}

// ── FR-M4, M5: ออกใบแจ้งค่าใช้จ่าย (ยังไม่รับชำระเงินจริงในระยะที่ 1) ──
async function createBill({ centerId, careProfileId, appointmentId, items, createdBy }) {
  const total = items.reduce((sum, it) => sum + (it.amount || 0), 0);
  const bill = await Bills.insert({
    bill_id: id('BILL'), center_id: centerId, care_profile_id: careProfileId, appointment_id: appointmentId,
    items, total, status: 'sent', created_by: createdBy, created_at: now(),
  });
  const careProfile = await CareProfiles.findOne((cp) => cp.care_profile_id === careProfileId);
  const target = await resolveFamilyTarget(careProfileId, careProfile);
  if (target) {
    const lines = ['ใบแจ้งค่าใช้จ่าย', ...items.map((it) => `${it.label} — ${it.amount} บาท`), '', `รวม ${total} บาท`];
    await lineClient.pushMessage(target, [{ type: 'text', text: lines.join('\n') }]);
  }
  return bill;
}

module.exports = {
  createTransportPlan, launchTransportChoice, familyChooseSelf, familyRequestCenter, familyRequestCare2go, centerChoose, centerChangeChoice, getPendingFamilyPlans,
  bindCare2goOperationsGroup, notifyCare2goOperations, care2goAcknowledge,
  markCare2goUnavailable, getRateCard, updateRateCard, createBill, remindPendingFamilyChoices, notifyAppointmentChanged,
};
