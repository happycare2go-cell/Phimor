// services/accessService.js — FR-O การเชื่อมต่อศูนย์กับ Care Profile ที่มีอยู่แล้ว
//
// หลักการ (ข้อ O1, O2): ห้ามเชื่อมอัตโนมัติเด็ดขาด ต้องขอความยินยอมจากครอบครัวก่อนเสมอ
// และครอบครัวปฏิเสธได้โดยไม่ต้องให้เหตุผล ศูนย์ต้องไม่เห็นเหตุผล

const { AccessRequests, CareProfiles, Residents, audit, id, now } = require('../db');
const lineClient = require('../providers/lineClient');

// ── FR-O1: ศูนย์เพิ่มผู้พักที่เบอร์ตรงกับ Care Profile เดิม → ส่งคำขอ ไม่เชื่อมทันที ──
async function findProfileByPhone(phone) {
  if (!phone) return null;

  // ทางที่ 1: Care Profile เก็บเบอร์ไว้ตรงๆ (ครอบคลุมทั้งกรณีสร้างอิสระเองและกรณีเคยผ่านศูนย์)
  const direct = await CareProfiles.findOne((p) => p.family_phone === phone);
  if (direct) return direct;

  // ทางที่ 2 (Fallback): ค้นย้อนผ่านทะเบียนผู้พักเดิมที่เคยผูกไว้ — เผื่อข้อมูลเก่าก่อนมี Field family_phone ใน CareProfile
  const { Residents: R } = require('../db');
  const priorResidentLink = await R.findOne((r) => r.family_phone === phone && r.care_profile_id);
  if (!priorResidentLink) return null;
  return CareProfiles.findOne((p) => p.care_profile_id === priorResidentLink.care_profile_id);
}

async function createAccessRequest({ centerId, careProfileId, residentId, requestedBy }) {
  // ข้อ O3: หนึ่ง Care Profile ผูกกับศูนย์ได้ครั้งละหนึ่งศูนย์
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId);
  if (profile?.center_id) {
    return { ok: false, reason: 'ผู้ป่วยรายนี้ผูกอยู่กับอีกศูนย์แล้ว ไม่สามารถผูกซ้ำได้' };
  }

  const request = await AccessRequests.insert({
    request_id: id('AR'), center_id: centerId, care_profile_id: careProfileId, resident_id: residentId || null,
    status: 'pending', requested_by: requestedBy, requested_at: now(), responded_at: null,
  });

  if (profile) {
    await lineClient.pushMessage(profile.owner_line_id, [{
      type: 'text',
      text: 'ศูนย์ดูแลขอเชื่อมต่อกับข้อมูลสุขภาพของคุณในพี่หมอ อนุญาตให้เชื่อมต่อไหมคะ',
    }]);
  }
  return { ok: true, request };
}

// ── FR-O2: ครอบครัวตอบรับหรือปฏิเสธ (ไม่ต้องให้เหตุผล) ──
async function respondAccessRequest(requestId, approved, respondingLineId) {
  const request = await AccessRequests.findOne((r) => r.request_id === requestId);
  if (!request) return { ok: false, reason: 'ไม่พบคำขอ' };
  if (request.status !== 'pending') return { ok: false, reason: 'คำขอนี้ถูกตอบไปแล้ว' };

  const profile = await CareProfiles.findOne((p) => p.care_profile_id === request.care_profile_id);
  if (profile && profile.owner_line_id !== respondingLineId) {
    return { ok: false, reason: 'เฉพาะเจ้าของ Care Profile เท่านั้นที่ตอบคำขอนี้ได้' };
  }

  const newStatus = approved ? 'approved' : 'declined';
  await AccessRequests.update((r) => r.request_id === requestId, { status: newStatus, responded_at: now() });
  await audit('access_request.responded', respondingLineId, { requestId, approved });

  if (approved) {
    await CareProfiles.update((p) => p.care_profile_id === request.care_profile_id, {
      center_id: request.center_id, status: 'linked',
    });
    // ผูก Resident ที่รอเชื่อมกลับเข้าโปรไฟล์เดียวกัน
    if (request.resident_id) {
      await Residents.update(
        (r) => r.resident_id === request.resident_id && r.center_id === request.center_id,
        { care_profile_id: request.care_profile_id }
      );
    }
  }
  // ข้อ O2: ศูนย์เห็นแค่สถานะ "ยังไม่ได้รับอนุญาต" ไม่เห็นเหตุผลใดๆ — ไม่ส่งรายละเอียดเพิ่มให้ศูนย์
  return { ok: true, status: newStatus };
}

async function getRequestStatusForCenter(requestId, centerId = null) {
  const r = await AccessRequests.findOne((x) => x.request_id === requestId && (!centerId || x.center_id === centerId));
  if (!r) return null;
  // คืนเฉพาะสถานะ ไม่มีช่องเหตุผลให้เห็นเลย (ตามหลักการ O2)
  return { requestId: r.request_id, status: r.status === 'declined' ? 'not_approved' : r.status };
}

async function listPendingRequestsForOwner(lineUserId) {
  const profiles = await CareProfiles.findWhere((p) => p.owner_line_id === lineUserId);
  const profileIds = new Set(profiles.map((p) => p.care_profile_id));
  const requests = await AccessRequests.findWhere((r) => profileIds.has(r.care_profile_id) && r.status === 'pending');
  return requests.map((request) => ({
    requestId: request.request_id, careProfileId: request.care_profile_id,
    patientName: profiles.find((p) => p.care_profile_id === request.care_profile_id)?.patient_name || '',
    requestedAt: request.requested_at,
  }));
}

module.exports = { findProfileByPhone, createAccessRequest, respondAccessRequest, getRequestStatusForCenter, listPendingRequestsForOwner };
