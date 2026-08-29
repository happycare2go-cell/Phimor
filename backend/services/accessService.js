// services/accessService.js — Center ↔ Family Care Profile consent lifecycle.
// Known-profile requests remain backward compatible. Anonymous Flow-A links
// never reveal a Family actor or Care Profile to the Center before approval.

const { randomBytes, createHash } = require('crypto');
const {
  AccessRequests, CareProfiles, Residents, Centers, Invites,
  audit, id, now, withTransactionLocks,
} = require('../db');
const lineClient = require('../providers/lineClient');

const ANONYMOUS_REQUEST_KIND = 'anonymous_existing_profile_link';
const KNOWN_REQUEST_KIND = 'known_profile';
const LINK_TTL_MS = 7 * 86400000;

function normalizeThaiPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('66') && digits.length >= 10) return `0${digits.slice(2)}`;
  return digits;
}

// Kept only for compatibility with existing records/internal callers. New
// Center onboarding never discovers a Care Profile from a phone number.
async function findProfileByPhone(phone) {
  if (!phone) return null;
  const normalized = normalizeThaiPhone(phone);
  if (!normalized) return null;
  const direct = await CareProfiles.findWhere((profile) => normalizeThaiPhone(profile.family_phone) === normalized);
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return null;
  const priorLinks = await Residents.findWhere((resident) => normalizeThaiPhone(resident.family_phone) === normalized && resident.care_profile_id);
  const uniqueIds = [...new Set(priorLinks.map((resident) => resident.care_profile_id))];
  if (uniqueIds.length !== 1) return null;
  return CareProfiles.findOneByField('care_profile_id', uniqueIds[0]);
}

function hashLinkToken(token) {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function newLinkToken() {
  return randomBytes(32).toString('base64url');
}

function isExpired(request, at = Date.now()) {
  return Boolean(request?.expires_at) && new Date(request.expires_at).getTime() <= at;
}

async function materializeExpiry(request) {
  if (!request || request.status !== 'pending' || !isExpired(request)) return request;
  const updated = await AccessRequests.update(
    (item) => item.request_id === request.request_id && item.status === 'pending',
    { status:'expired', responded_at:now(), expired_at:now() }
  );
  return updated || { ...request, status:'expired' };
}

function safeCenterProjection(center) {
  return {
    centerName:center?.name || 'ศูนย์ดูแล',
    centerAddress:center?.address || '',
    centerPhone:center?.contact_phone || '',
  };
}

async function centerIsAllowed(centerId) {
  const center = await Centers.findOneByField('center_id', centerId);
  const entitlement = require('./subscriptionService').entitlement(center);
  return { center, entitlement, allowed:Boolean(center && entitlement.allowed) };
}

async function createAnonymousLinkRequest({ centerId, requestedBy }) {
  const access = await centerIsAllowed(centerId);
  if (!access.allowed) return { ok:false, code:'CENTER_NOT_AVAILABLE', reason:'ศูนย์นี้ยังไม่พร้อมสร้างลิงก์เชื่อม Care Profile' };
  const token = newLinkToken();
  const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
  const request = await AccessRequests.insert({
    request_id:id('AR'), request_kind:ANONYMOUS_REQUEST_KIND,
    center_id:centerId, care_profile_id:null, resident_id:null,
    link_token_hash:hashLinkToken(token),
    status:'pending', requested_by:requestedBy, requested_at:now(), responded_at:null,
    presented_to_line_user_id:null, presented_at:null, expires_at:expiresAt,
  });
  await audit('access_request.anonymous_link_created', requestedBy, {
    requestId:request.request_id, centerId, requestKind:ANONYMOUS_REQUEST_KIND,
  });
  const liffId = process.env.LIFF_ID_FAMILY || (process.env.NODE_ENV === 'test' ? 'TEST_FAMILY_LIFF' : 'YOUR_LIFF_ID');
  return {
    ok:true, request, token,
    linkUrl:`https://liff.line.me/${liffId}?centerLink=${encodeURIComponent(token)}`,
    expiresAt,
  };
}

async function profileEligibility(profile, actorLineId) {
  if (!profile || profile.owner_line_id !== actorLineId) return { eligible:false, code:'OWNER_REQUIRED' };
  if (profile.center_id || profile.status !== 'independent' || profile.managed_by_center === true) {
    return { eligible:false, code:'ALREADY_CENTER_LINKED' };
  }
  const resident = await Residents.findOne(
    (item) => item.care_profile_id === profile.care_profile_id && item.status === 'active'
  );
  if (resident) return { eligible:false, code:'ACTIVE_RESIDENT_CONFLICT' };
  if (!String(profile.patient_name || '').trim()) return { eligible:false, code:'PROFILE_INELIGIBLE' };
  return { eligible:true };
}

async function listOwnedEligibleProfiles(actorLineId) {
  const owned = await CareProfiles.findWhereByField('owner_line_id', actorLineId);
  const unique = new Map();
  for (const profile of owned) if (!unique.has(profile.care_profile_id)) unique.set(profile.care_profile_id, profile);
  const ordered = [...unique.values()].sort((a, b) =>
    String(a.created_at || a._createdAt || '').localeCompare(String(b.created_at || b._createdAt || ''))
      || String(a.care_profile_id || '').localeCompare(String(b.care_profile_id || ''))
  );
  const output = [];
  for (const profile of ordered) {
    const eligibility = await profileEligibility(profile, actorLineId);
    if (eligibility.eligible) output.push({ careProfileId:profile.care_profile_id, patientName:profile.patient_name });
  }
  return output;
}

async function projectAnonymousRequest(request, actorLineId) {
  const center = await Centers.findOneByField('center_id', request.center_id);
  return {
    requestId:request.request_id,
    requestKind:ANONYMOUS_REQUEST_KIND,
    status:request.status,
    ...safeCenterProjection(center),
    requestedAt:request.requested_at,
    expiresAt:request.expires_at,
    eligibleProfiles:await listOwnedEligibleProfiles(actorLineId),
  };
}

async function openAnonymousLink({ token, lineUserId }) {
  const tokenHash = hashLinkToken(token);
  const probe = await AccessRequests.findOneByField('link_token_hash', tokenHash);
  if (!probe || probe.request_kind !== ANONYMOUS_REQUEST_KIND) {
    return { ok:false, status:404, code:'LINK_NOT_FOUND', reason:'ไม่พบลิงก์เชื่อม Care Profile นี้' };
  }
  return withTransactionLocks([`center-family-link-request:${probe.request_id}`], async () => {
    let request = await AccessRequests.findOneByField('link_token_hash', tokenHash);
    if (!request) return { ok:false, status:404, code:'LINK_NOT_FOUND', reason:'ไม่พบลิงก์เชื่อม Care Profile นี้' };
    request = await materializeExpiry(request);
    if (request.status !== 'pending') {
      return { ok:false, status:410, code:`LINK_${String(request.status).toUpperCase()}`, reason:'ลิงก์นี้ไม่สามารถใช้งานได้แล้ว' };
    }
    const access = await centerIsAllowed(request.center_id);
    if (!access.allowed) return { ok:false, status:410, code:'CENTER_NOT_AVAILABLE', reason:'ศูนย์นี้ยังไม่พร้อมรับการเชื่อมต่อ' };
    if (request.presented_to_line_user_id && request.presented_to_line_user_id !== lineUserId) {
      return { ok:false, status:403, code:'LINK_ACTOR_MISMATCH', reason:'ลิงก์นี้ถูกเปิดเพื่อดำเนินการแล้ว กรุณาใช้บัญชี LINE เดิมที่เปิดลิงก์ครั้งแรก' };
    }
    if (!request.presented_to_line_user_id) {
      const ownedProfiles = await CareProfiles.findWhereByField('owner_line_id', lineUserId);
      if (!ownedProfiles.length) {
        return { ok:false, status:403, code:'OWNER_PROFILE_REQUIRED', reason:'บัญชี LINE นี้ยังไม่มี Care Profile ที่เป็นเจ้าของสำหรับดำเนินการ' };
      }
      request = await AccessRequests.update(
        (item) => item.request_id === request.request_id && item.status === 'pending' && !item.presented_to_line_user_id,
        { presented_to_line_user_id:lineUserId, presented_at:now() }
      );
      await audit('access_request.anonymous_link_presented', lineUserId, {
        requestId:request.request_id, centerId:request.center_id, requestKind:ANONYMOUS_REQUEST_KIND,
      });
    }
    return { ok:true, request:await projectAnonymousRequest(request, lineUserId) };
  });
}

// Legacy known-profile request creation remains available, but new Center
// resident onboarding no longer invokes it from a phone number.
async function createAccessRequest({ centerId, careProfileId, residentId, requestedBy }) {
  const profile = await CareProfiles.findOneByField('care_profile_id', careProfileId);
  if (profile?.center_id) return { ok:false, reason:'ผู้ป่วยรายนี้ผูกอยู่กับอีกศูนย์แล้ว ไม่สามารถผูกซ้ำได้' };
  const access = await centerIsAllowed(centerId);
  const resident = residentId && await Residents.findOne(
    (item) => item.resident_id === residentId && item.center_id === centerId && item.status === 'active'
  );
  if (!access.allowed || (residentId && !resident)) return { ok:false, reason:'ข้อมูลศูนย์หรือผู้พักไม่ถูกต้อง' };
  const existing = await AccessRequests.findOne((item) => item.center_id === centerId
    && item.care_profile_id === careProfileId && item.resident_id === (residentId || null) && item.status === 'pending');
  if (existing) return { ok:true, request:existing, duplicate:true };
  const request = await AccessRequests.insert({
    request_id:id('AR'), request_kind:KNOWN_REQUEST_KIND,
    center_id:centerId, care_profile_id:careProfileId, resident_id:residentId || null,
    status:'pending', requested_by:requestedBy, requested_at:now(), responded_at:null,
    expires_at:new Date(Date.now() + LINK_TTL_MS).toISOString(),
  });
  if (profile?.owner_line_id) {
    await lineClient.pushMessage(profile.owner_line_id, [{
      type:'text',
      text:`${access.center.name} ขอเชื่อมต่อกับข้อมูลสุขภาพของ ${profile.patient_name} ในพี่หมอ\nกรุณาเปิด Family LIFF เพื่อตรวจสอบชื่อสาขาและอนุญาตหรือปฏิเสธคำขอค่ะ`,
    }]);
  }
  return { ok:true, request };
}

async function approveAnonymousRequest(request, selectedCareProfileId, respondingLineId) {
  if (!selectedCareProfileId) return { ok:false, code:'CARE_PROFILE_REQUIRED', reason:'กรุณาเลือก Care Profile ที่ต้องการเชื่อม' };
  return withTransactionLocks([
    `center-family-link-request:${request.request_id}`,
    `center-family-link-profile:${selectedCareProfileId}`,
  ], async () => {
    const current = await AccessRequests.findOneByField('request_id', request.request_id);
    if (!current) return { ok:false, code:'REQUEST_NOT_FOUND', reason:'ไม่พบคำขอ' };
    if (current.status === 'approved') {
      if (current.presented_to_line_user_id === respondingLineId && current.care_profile_id === selectedCareProfileId) {
        return { ok:true, status:'approved', duplicate:true, careProfileId:current.care_profile_id, residentId:current.resident_id };
      }
      return { ok:false, code:'REQUEST_ALREADY_USED', reason:'คำขอนี้เชื่อม Care Profile อื่นแล้ว' };
    }
    const unexpired = await materializeExpiry(current);
    if (unexpired.status !== 'pending') return { ok:false, code:'REQUEST_NOT_PENDING', reason:'คำขอนี้ไม่สามารถใช้งานได้แล้ว' };
    if (unexpired.presented_to_line_user_id !== respondingLineId) return { ok:false, code:'OWNER_REQUIRED', reason:'บัญชี LINE นี้ไม่มีสิทธิ์ตอบคำขอ' };
    const access = await centerIsAllowed(unexpired.center_id);
    if (!access.allowed) return { ok:false, code:'CENTER_NOT_AVAILABLE', reason:'ศูนย์นี้ยังไม่พร้อมรับการเชื่อมต่อ' };
    const profile = await CareProfiles.findOneByField('care_profile_id', selectedCareProfileId);
    const eligibility = await profileEligibility(profile, respondingLineId);
    if (!eligibility.eligible) return { ok:false, code:eligibility.code, reason:'Care Profile นี้ไม่สามารถเชื่อมกับศูนย์ได้' };

    const resident = await Residents.insert({
      resident_id:id('R'), center_id:unexpired.center_id,
      full_name:String(profile.patient_name).trim(), aliases:[], room:null, family_phone:null,
      care_profile_id:selectedCareProfileId, status:'active', link_status:'linked',
      link_request_id:unexpired.request_id, created_at:now(),
    });
    const linked = await CareProfiles.update(
      (item) => item.care_profile_id === selectedCareProfileId
        && item.owner_line_id === respondingLineId && !item.center_id
        && item.status === 'independent' && item.managed_by_center !== true,
      { center_id:unexpired.center_id, status:'linked', linked_at:now() }
    );
    if (!linked) {
      const error = new Error('CARE_PROFILE_LINK_CONFLICT');
      error.code = 'CARE_PROFILE_LINK_CONFLICT';
      throw error;
    }
    const approvedAt = now();
    const approved = await AccessRequests.update(
      (item) => item.request_id === unexpired.request_id && item.status === 'pending',
      {
        care_profile_id:selectedCareProfileId, resident_id:resident.resident_id,
        status:'approved', responded_at:approvedAt, approved_at:approvedAt,
        consumed_at:approvedAt,
      }
    );
    if (!approved) {
      const error = new Error('ACCESS_REQUEST_APPROVAL_CONFLICT');
      error.code = 'ACCESS_REQUEST_APPROVAL_CONFLICT';
      throw error;
    }
    await audit('access_request.anonymous_link_approved', respondingLineId, {
      requestId:approved.request_id, centerId:approved.center_id,
      careProfileId:selectedCareProfileId, residentId:resident.resident_id,
      requestKind:ANONYMOUS_REQUEST_KIND,
    });
    return { ok:true, status:'approved', careProfileId:selectedCareProfileId, residentId:resident.resident_id };
  });
}

async function declineAnonymousRequest(request, respondingLineId) {
  return withTransactionLocks([`center-family-link-request:${request.request_id}`], async () => {
    let current = await AccessRequests.findOneByField('request_id', request.request_id);
    if (!current) return { ok:false, code:'REQUEST_NOT_FOUND', reason:'ไม่พบคำขอ' };
    current = await materializeExpiry(current);
    if (current.status === 'declined' && current.presented_to_line_user_id === respondingLineId) {
      return { ok:true, status:'declined', duplicate:true };
    }
    if (current.status !== 'pending') return { ok:false, code:'REQUEST_NOT_PENDING', reason:'คำขอนี้ไม่สามารถใช้งานได้แล้ว' };
    if (current.presented_to_line_user_id !== respondingLineId) return { ok:false, code:'OWNER_REQUIRED', reason:'บัญชี LINE นี้ไม่มีสิทธิ์ตอบคำขอ' };
    const declinedAt = now();
    const declined = await AccessRequests.update(
      (item) => item.request_id === current.request_id && item.status === 'pending',
      { status:'declined', responded_at:declinedAt, declined_at:declinedAt }
    );
    await audit('access_request.anonymous_link_declined', respondingLineId, {
      requestId:declined.request_id, centerId:declined.center_id,
      requestKind:ANONYMOUS_REQUEST_KIND,
    });
    return { ok:true, status:'declined' };
  });
}

async function respondKnownRequest(request, approved, respondingLineId) {
  const keys = [`access-request:${request.request_id}`];
  if (request.care_profile_id) keys.push(`center-family-link-profile:${request.care_profile_id}`);
  return withTransactionLocks(keys, async () => {
    let current = await AccessRequests.findOneByField('request_id', request.request_id);
    if (!current) return { ok:false, reason:'ไม่พบคำขอ' };
    current = await materializeExpiry(current);
    if (current.status !== 'pending') return { ok:false, reason:'คำขอนี้ถูกตอบหรือหมดอายุแล้ว' };
    const profile = await CareProfiles.findOneByField('care_profile_id', current.care_profile_id);
    if (!profile || profile.owner_line_id !== respondingLineId) return { ok:false, reason:'เฉพาะเจ้าของ Care Profile เท่านั้นที่ตอบคำขอนี้ได้' };
    const access = await centerIsAllowed(current.center_id);
    if (approved && !access.allowed) return { ok:false, reason:'ศูนย์นี้ยังไม่พร้อมรับการเชื่อมต่อ' };
    if (approved && profile.center_id && profile.center_id !== current.center_id) return { ok:false, reason:'Care Profile นี้เชื่อมกับศูนย์อื่นแล้ว ต้องทำรายการย้ายศูนย์ก่อน' };
    const resident = current.resident_id && await Residents.findOne(
      (item) => item.resident_id === current.resident_id && item.center_id === current.center_id && item.status === 'active'
    );
    if (approved && current.resident_id && !resident) return { ok:false, reason:'ผู้พักหรือสาขานี้ไม่ได้ใช้งานแล้ว' };
    const newStatus = approved ? 'approved' : 'declined';
    if (approved) {
      const linked = await CareProfiles.update(
        (item) => item.care_profile_id === current.care_profile_id && (!item.center_id || item.center_id === current.center_id),
        { center_id:current.center_id, status:'linked' }
      );
      if (!linked) {
        const error = new Error('CARE_PROFILE_LINK_CONFLICT');
        error.code = 'CARE_PROFILE_LINK_CONFLICT';
        throw error;
      }
      if (current.resident_id) {
        await Residents.update(
          (item) => item.resident_id === current.resident_id && item.center_id === current.center_id && item.status === 'active',
          { care_profile_id:current.care_profile_id, link_status:'linked' }
        );
        await Invites.updateAll(
          (item) => item.resident_id === current.resident_id && !item.used_at,
          { status:'revoked', revoked_at:now(), revoke_reason:'access_request_approved' }
        );
        await require('./deliveryService').deliverPendingForResident(current.resident_id, current.care_profile_id);
      }
      await AccessRequests.updateAll(
        (item) => item.request_id !== current.request_id && item.care_profile_id === current.care_profile_id && item.status === 'pending',
        { status:'superseded', responded_at:now() }
      );
    }
    await AccessRequests.update(
      (item) => item.request_id === current.request_id && item.status === 'pending',
      { status:newStatus, responded_at:now(), ...(approved ? { approved_at:now() } : { declined_at:now() }) }
    );
    await audit('access_request.responded', respondingLineId, { requestId:current.request_id, approved });
    return { ok:true, status:newStatus };
  });
}

async function respondAccessRequest(requestId, approved, respondingLineId, selectedCareProfileId = null) {
  const request = await AccessRequests.findOneByField('request_id', requestId);
  if (!request) return { ok:false, code:'REQUEST_NOT_FOUND', reason:'ไม่พบคำขอ' };
  if (request.request_kind === ANONYMOUS_REQUEST_KIND) {
    return approved
      ? approveAnonymousRequest(request, selectedCareProfileId, respondingLineId)
      : declineAnonymousRequest(request, respondingLineId);
  }
  return respondKnownRequest(request, approved, respondingLineId);
}

async function getRequestStatusForCenter(requestId, centerId = null) {
  let request = await AccessRequests.findOneByField('request_id', requestId);
  if (!request || (centerId && request.center_id !== centerId)) return null;
  request = await materializeExpiry(request);
  return { requestId:request.request_id, status:request.status === 'declined' ? 'not_approved' : request.status };
}

async function listActiveAnonymousLinksForCenter(centerId) {
  const requests = await AccessRequests.findWhereByField('center_id', centerId);
  const output = [];
  for (let request of requests) {
    if (request.request_kind !== ANONYMOUS_REQUEST_KIND) continue;
    request = await materializeExpiry(request);
    if (request.status !== 'pending') continue;
    output.push({ status:'pending', requestedAt:request.requested_at, expiresAt:request.expires_at });
  }
  return output.sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
}

async function listPendingRequestsForOwner(lineUserId) {
  const profiles = await CareProfiles.findWhereByField('owner_line_id', lineUserId);
  const profileIds = new Set(profiles.map((profile) => profile.care_profile_id));
  const candidates = new Map();
  const anonymous = await AccessRequests.findWhereByField('presented_to_line_user_id', lineUserId);
  for (const request of anonymous) candidates.set(request.request_id, request);
  const knownGroups = await Promise.all(
    [...profileIds].map((careProfileId) => AccessRequests.findWhereByField('care_profile_id', careProfileId))
  );
  for (const group of knownGroups) for (const request of group) candidates.set(request.request_id, request);
  const output = [];
  for (let request of candidates.values()) {
    if (request.status !== 'pending') continue;
    request = await materializeExpiry(request);
    if (request.status !== 'pending') continue;
    if (request.request_kind === ANONYMOUS_REQUEST_KIND) {
      if (request.presented_to_line_user_id !== lineUserId) continue;
      const access = await centerIsAllowed(request.center_id);
      if (!access.allowed) continue;
      output.push(await projectAnonymousRequest(request, lineUserId));
      continue;
    }
    if (!profileIds.has(request.care_profile_id)) continue;
    const center = await Centers.findOneByField('center_id', request.center_id);
    const resident = request.resident_id && await Residents.findOneByField('resident_id', request.resident_id);
    output.push({
      requestId:request.request_id, requestKind:request.request_kind || KNOWN_REQUEST_KIND,
      careProfileId:request.care_profile_id,
      patientName:profiles.find((profile) => profile.care_profile_id === request.care_profile_id)?.patient_name || '',
      ...safeCenterProjection(center),
      residentName:resident?.full_name || '', room:resident?.room || '',
      requestedAt:request.requested_at, expiresAt:request.expires_at || null,
    });
  }
  return output.sort((a, b) => String(a.requestedAt || '').localeCompare(String(b.requestedAt || ''))
    || String(a.requestId).localeCompare(String(b.requestId)));
}

module.exports = {
  ANONYMOUS_REQUEST_KIND, KNOWN_REQUEST_KIND, LINK_TTL_MS,
  normalizeThaiPhone, findProfileByPhone, hashLinkToken,
  createAnonymousLinkRequest, openAnonymousLink, listOwnedEligibleProfiles,
  createAccessRequest, respondAccessRequest, getRequestStatusForCenter,
  listActiveAnonymousLinksForCenter, listPendingRequestsForOwner,
};
