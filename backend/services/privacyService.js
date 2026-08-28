const {
  DataSubjectRequests, audit, id, now, withTransaction,
} = require('../db');
const { displayIdentity, maskedInternalReference, cleanText } = require('../utils/safeIdentity');

const REQUEST_TYPES = Object.freeze(['export', 'correct', 'restrict', 'delete']);
const REQUEST_STATUSES = Object.freeze(['pending', 'in_progress', 'completed', 'rejected']);
const ACTIVE_STATUSES = new Set(['pending', 'in_progress']);
const TERMINAL_STATUSES = new Set(['completed', 'rejected']);
const MAX_REQUEST_NOTE_LENGTH = 500;
const MAX_PUBLIC_NOTE_LENGTH = 500;

class PrivacyRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.code = code; this.status = status;
  }
}

function normalizeType(value) {
  const type = cleanText(value, 40);
  if (!REQUEST_TYPES.includes(type)) {
    throw new PrivacyRequestError('INVALID_DATA_REQUEST_TYPE', 'ประเภทคำขอไม่ถูกต้อง');
  }
  return type;
}

function normalizeNote(value) {
  const note = cleanText(value, MAX_REQUEST_NOTE_LENGTH + 1);
  if (note.length > MAX_REQUEST_NOTE_LENGTH) {
    throw new PrivacyRequestError('DATA_REQUEST_NOTE_TOO_LONG', `รายละเอียดต้องไม่เกิน ${MAX_REQUEST_NOTE_LENGTH} ตัวอักษร`);
  }
  return note;
}

function safeReference(row) {
  return maskedInternalReference(row?.request_id, 'คำขอ');
}

function familyProjection(row) {
  return {
    requestReference:safeReference(row),
    type:row.type,
    status:row.status,
    requestedAt:row.requested_at,
    updatedAt:row.updated_at || row.requested_at,
    publicNote:cleanText(row.public_note, MAX_PUBLIC_NOTE_LENGTH) || null,
    fulfillmentMode:'manual_review',
  };
}

function adminProjection(row) {
  return {
    requestId:row.request_id,
    requestReference:safeReference(row),
    requesterIdentity:displayIdentity({ displayName:row.requester_display_name, lineUserId:row.line_user_id }),
    type:row.type,
    status:row.status,
    requestDetails:cleanText(row.note, MAX_REQUEST_NOTE_LENGTH) || null,
    publicNote:cleanText(row.public_note, MAX_PUBLIC_NOTE_LENGTH) || null,
    requestedAt:row.requested_at,
    updatedAt:row.updated_at || row.requested_at,
    handled:TERMINAL_STATUSES.has(row.status),
    fulfillmentMode:'manual_review',
  };
}

async function createRequest({ lineUserId, displayName = '', type, note = '' }) {
  const actor = cleanText(lineUserId, 256);
  if (!actor) throw new PrivacyRequestError('AUTHENTICATION_REQUIRED', 'ไม่พบตัวตนผู้ขอ', 401);
  const normalizedType = normalizeType(type);
  const normalizedNote = normalizeNote(note);
  return withTransaction(`privacy-request:${actor}:${normalizedType}`, async () => {
    const existing = await DataSubjectRequests.findOne((row) => row.line_user_id === actor
      && row.type === normalizedType && ACTIVE_STATUSES.has(row.status));
    if (existing) return { request:familyProjection(existing), duplicate:true, created:false };
    const row = await DataSubjectRequests.insert({
      request_id:id('DSR'), line_user_id:actor,
      requester_display_name:cleanText(displayName) || null,
      type:normalizedType, status:'pending', note:normalizedNote,
      requested_at:now(), updated_at:null, fulfillment_mode:'manual_review',
    });
    await audit('privacy.data_request_created', actor, { requestId:row.request_id, type:normalizedType });
    return { request:familyProjection(row), duplicate:false, created:true };
  });
}

async function listOwnRequests(lineUserId) {
  const actor = cleanText(lineUserId, 256);
  const rows = await DataSubjectRequests.findWhere((row) => row.line_user_id === actor);
  return rows.sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at))).map(familyProjection);
}

async function getOwnRequest({ lineUserId, requestId }) {
  const row = await DataSubjectRequests.findOne((item) => item.request_id === requestId && item.line_user_id === lineUserId);
  if (!row) throw new PrivacyRequestError('DATA_REQUEST_NOT_FOUND', 'ไม่พบคำขอนี้', 404);
  return familyProjection(row);
}

async function listAdminRequests(actorReference) {
  const rows = await DataSubjectRequests.findAll();
  const projected = rows.map(adminProjection);
  await audit('privacy.data_requests_listed', actorReference, { count:projected.length });
  return projected;
}

function validateTransition(current, next) {
  if (!REQUEST_STATUSES.includes(next) || next === 'pending') {
    throw new PrivacyRequestError('INVALID_DATA_REQUEST_STATUS', 'สถานะคำขอไม่ถูกต้อง');
  }
  if (TERMINAL_STATUSES.has(current) && current !== next) {
    throw new PrivacyRequestError('DATA_REQUEST_ALREADY_CLOSED', 'คำขอนี้สิ้นสุดการดำเนินงานแล้ว', 409);
  }
}

async function updateRequest({ requestId, status, publicNote = '', adminNote = '', actorReference, manualFulfillmentConfirmed = false }) {
  const nextStatus = cleanText(status, 40);
  const existing = await DataSubjectRequests.findOne((row) => row.request_id === requestId);
  if (!existing) throw new PrivacyRequestError('DATA_REQUEST_NOT_FOUND', 'ไม่พบคำขอนี้', 404);
  validateTransition(existing.status, nextStatus);
  if (nextStatus === 'completed' && manualFulfillmentConfirmed !== true) {
    throw new PrivacyRequestError('MANUAL_FULFILLMENT_CONFIRMATION_REQUIRED', 'ต้องยืนยันว่าดำเนินงานตามขั้นตอนที่ได้รับอนุมัติแล้ว');
  }
  const safePublicNote = cleanText(publicNote, MAX_PUBLIC_NOTE_LENGTH + 1);
  if (safePublicNote.length > MAX_PUBLIC_NOTE_LENGTH) {
    throw new PrivacyRequestError('PUBLIC_NOTE_TOO_LONG', `ข้อความสำหรับผู้ขอต้องไม่เกิน ${MAX_PUBLIC_NOTE_LENGTH} ตัวอักษร`);
  }
  const row = await DataSubjectRequests.update((item) => item.request_id === requestId, {
    status:nextStatus,
    admin_note:cleanText(adminNote, 1000),
    public_note:safePublicNote,
    fulfillment_mode:'manual_review',
    manual_fulfillment_confirmed:nextStatus === 'completed' ? true : existing.manual_fulfillment_confirmed || false,
    updated_at:now(), updated_by:actorReference,
  });
  await audit('privacy.data_request_updated', actorReference, { requestId:row.request_id, status:row.status, fulfillmentMode:'manual_review' });
  return adminProjection(row);
}

module.exports = {
  REQUEST_TYPES, REQUEST_STATUSES, MAX_REQUEST_NOTE_LENGTH,
  PrivacyRequestError, normalizeType, familyProjection, adminProjection,
  createRequest, listOwnRequests, getOwnRequest, listAdminRequests, updateRequest,
};
