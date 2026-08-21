// services/accessService.js — FR-O การเชื่อมต่อศูนย์กับ Care Profile ที่มีอยู่แล้ว
//
// หลักการ (ข้อ O1, O2): ห้ามเชื่อมอัตโนมัติเด็ดขาด ต้องขอความยินยอมจากครอบครัวก่อนเสมอ
// และครอบครัวปฏิเสธได้โดยไม่ต้องให้เหตุผล ศูนย์ต้องไม่เห็นเหตุผล

const { AccessRequests, CareProfiles, Residents, Centers, Invites, audit, id, now, withTransaction } = require('../db');
const lineClient = require('../providers/lineClient');

// ── FR-O1: ศูนย์เพิ่มผู้พักที่เบอร์ตรงกับ Care Profile เดิม → ส่งคำขอ ไม่เชื่อมทันที ──
async function findProfileByPhone(phone) {
  if (!phone) return null;
  const normalized = normalizeThaiPhone(phone);
  if (!normalized) return null;

  // ทางที่ 1: Care Profile เก็บเบอร์ไว้ตรงๆ (ครอบคลุมทั้งกรณีสร้างอิสระเองและกรณีเคยผ่านศูนย์)
  const direct = await CareProfiles.findWhere((p) => normalizeThaiPhone(p.family_phone) === normalized);
  if (direct.length === 1) return direct[0];
  // A shared/duplicate phone is not a safe identity proof.  Require an invite
  // or one-time link code instead of selecting an arbitrary profile.
  if (direct.length > 1) return null;

  // ทางที่ 2 (Fallback): ค้นย้อนผ่านทะเบียนผู้พักเดิมที่เคยผูกไว้ — เผื่อข้อมูลเก่าก่อนมี Field family_phone ใน CareProfile
  const { Residents: R } = require('../db');
  const priorLinks = await R.findWhere((r) => normalizeThaiPhone(r.family_phone) === normalized && r.care_profile_id);
  const uniqueIds = [...new Set(priorLinks.map((r) => r.care_profile_id))];
  if (uniqueIds.length !== 1) return null;
  return CareProfiles.findOne((p) => p.care_profile_id === uniqueIds[0]);
}

function normalizeThaiPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('66') && digits.length >= 10) return `0${digits.slice(2)}`;
  return digits;
}

async function createAccessRequest({ centerId, careProfileId, residentId, requestedBy }) {
  // ข้อ O3: หนึ่ง Care Profile ผูกกับศูนย์ได้ครั้งละหนึ่งศูนย์
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId);
  if (profile?.center_id) {
    return { ok: false, reason: 'ผู้ป่วยรายนี้ผูกอยู่กับอีกศูนย์แล้ว ไม่สามารถผูกซ้ำได้' };
  }
  const center = await Centers.findOne((c) => c.center_id === centerId && c.status === 'active');
  const resident = residentId && await Residents.findOne((r) => r.resident_id === residentId && r.center_id === centerId && r.status === 'active');
  if (!center || (residentId && !resident)) return { ok: false, reason: 'ข้อมูลศูนย์หรือผู้พักไม่ถูกต้อง' };
  const existing = await AccessRequests.findOne((r) => r.center_id === centerId && r.care_profile_id === careProfileId && r.resident_id === (residentId || null) && r.status === 'pending');
  if (existing) return { ok: true, request: existing, duplicate: true };

  const request = await AccessRequests.insert({
    request_id: id('AR'), center_id: centerId, care_profile_id: careProfileId, resident_id: residentId || null,
    status: 'pending', requested_by: requestedBy, requested_at: now(), responded_at: null,
    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
  });

  if (profile) {
    await lineClient.pushMessage(profile.owner_line_id, [{
      type: 'text',
      text: `${center.name} ขอเชื่อมต่อกับข้อมูลสุขภาพของ ${profile.patient_name} ในพี่หมอ\nกรุณาเปิด Family LIFF เพื่อตรวจสอบชื่อสาขาและอนุญาตหรือปฏิเสธคำขอค่ะ`,
    }]);
  }
  return { ok: true, request };
}

// ── FR-O2: ครอบครัวตอบรับหรือปฏิเสธ (ไม่ต้องให้เหตุผล) ──
async function respondAccessRequest(requestId, approved, respondingLineId) {
  return withTransaction(`access-request:${requestId}`, async () => {
    const request = await AccessRequests.findOne((r) => r.request_id === requestId);
    if (!request) return { ok: false, reason: 'ไม่พบคำขอ' };
    if (request.status !== 'pending') return { ok: false, reason: 'คำขอนี้ถูกตอบไปแล้ว' };
    if (request.expires_at && new Date(request.expires_at).getTime() < Date.now()) {
      await AccessRequests.update((r) => r.request_id === requestId, { status: 'expired', responded_at: now() });
      return { ok: false, reason: 'คำขอนี้หมดอายุแล้ว' };
    }
    const profile = await CareProfiles.findOne((p) => p.care_profile_id === request.care_profile_id);
    if (!profile || profile.owner_line_id !== respondingLineId) return { ok: false, reason: 'เฉพาะเจ้าของ Care Profile เท่านั้นที่ตอบคำขอนี้ได้' };
    if (approved && profile.center_id && profile.center_id !== request.center_id) return { ok: false, reason: 'Care Profile นี้เชื่อมกับศูนย์อื่นแล้ว ต้องทำรายการย้ายศูนย์ก่อน' };
    const resident = request.resident_id && await Residents.findOne((r) => r.resident_id === request.resident_id && r.center_id === request.center_id && r.status === 'active');
    if (approved && request.resident_id && !resident) return { ok: false, reason: 'ผู้พักหรือสาขานี้ไม่ได้ใช้งานแล้ว' };

    const newStatus = approved ? 'approved' : 'declined';
    await AccessRequests.update((r) => r.request_id === requestId && r.status === 'pending', { status: newStatus, responded_at: now() });
    if (approved) {
      await CareProfiles.update((p) => p.care_profile_id === request.care_profile_id && (!p.center_id || p.center_id === request.center_id), { center_id: request.center_id, status: 'linked' });
      if (request.resident_id) {
        await Residents.update((r) => r.resident_id === request.resident_id && r.center_id === request.center_id && r.status === 'active', { care_profile_id: request.care_profile_id, link_status: 'linked' });
        await Invites.updateAll((i) => i.resident_id === request.resident_id && !i.used_at, { status: 'revoked', revoked_at: now(), revoke_reason: 'access_request_approved' });
        await require('./deliveryService').deliverPendingForResident(request.resident_id, request.care_profile_id);
      }
      await AccessRequests.updateAll((r) => r.request_id !== requestId && r.care_profile_id === request.care_profile_id && r.status === 'pending', { status: 'superseded', responded_at: now() });
    }
    await audit('access_request.responded', respondingLineId, { requestId, approved });
    return { ok: true, status: newStatus };
  });
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
  const output = [];
  for (const request of requests) {
    const center = await Centers.findOne((c) => c.center_id === request.center_id);
    const resident = request.resident_id && await Residents.findOne((r) => r.resident_id === request.resident_id);
    output.push({ requestId: request.request_id, careProfileId: request.care_profile_id,
      patientName: profiles.find((p) => p.care_profile_id === request.care_profile_id)?.patient_name || '',
      centerId: center?.center_id || null, centerName: center?.name || 'ไม่ทราบชื่อศูนย์', centerAddress: center?.address || '',
      centerPhone: center?.contact_phone || '', residentName: resident?.full_name || '', room: resident?.room || '',
      requestedBy: request.requested_by, requestedAt: request.requested_at, expiresAt: request.expires_at || null });
  }
  return output;
}

module.exports = { normalizeThaiPhone, findProfileByPhone, createAccessRequest, respondAccessRequest, getRequestStatusForCenter, listPendingRequestsForOwner };
