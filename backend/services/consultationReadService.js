const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { createConsultationRepository } = require('./consultationRepository');
const { createPharmacistAccountService } = require('./pharmacistAccountService');
const { classifyConsultationSafety } = require('./consultationSafetyService');
const {
  ConsultationDomainError, effectiveConsultationState, assertProvisionedConsultationCase,
} = require('../domain/consultation');

const DEFAULT_MESSAGE_LIMIT = 20;
const MAX_MESSAGE_LIMIT = 50;
const DEFAULT_QUEUE_LIMIT = 20;
const MAX_QUEUE_LIMIT = 50;
const MAX_QUEUE_SCAN = 500;
const QUEUE_CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function parseSequence(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ConsultationDomainError('INVALID_AFTER_SEQUENCE');
  return parsed;
}

function parseLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MESSAGE_LIMIT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_MESSAGE_LIMIT) {
    throw new ConsultationDomainError('INVALID_MESSAGE_LIMIT');
  }
  return parsed;
}

function parseQueueLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_QUEUE_LIMIT;
  const parsed=Number(value);
  if (!Number.isSafeInteger(parsed) || parsed<1 || parsed>MAX_QUEUE_LIMIT) {
    throw new ConsultationDomainError('INVALID_QUEUE_LIMIT');
  }
  return parsed;
}

function parseQueueAge(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed=Number(value);
  if (!Number.isSafeInteger(parsed) || parsed<0 || parsed>10_080) {
    throw new ConsultationDomainError('INVALID_QUEUE_AGE');
  }
  return parsed;
}

function parseCategory(value, errorCode) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !QUEUE_CATEGORY_PATTERN.test(value)) {
    throw new ConsultationDomainError(errorCode);
  }
  return value;
}

function encodeQueueCursor(row) {
  return Buffer.from(JSON.stringify({queuedAt:row.queued_at,caseId:row.case_id})).toString('base64url');
}

function parseQueueCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    const parsed=JSON.parse(Buffer.from(String(value),'base64url').toString('utf8'));
    if (!parsed || typeof parsed.caseId!=='string' || !parsed.caseId
        || Number.isNaN(new Date(parsed.queuedAt).getTime())) throw new Error('invalid');
    return {queuedAt:new Date(parsed.queuedAt).toISOString(),caseId:parsed.caseId};
  } catch (_) { throw new ConsultationDomainError('INVALID_QUEUE_CURSOR'); }
}

function projectCase(row, { includeQuestion = false } = {}) {
  const now=new Date(row.database_now || Date.now());
  const state = effectiveConsultationState(row, now);
  const expiresAt=row.expires_at ? new Date(row.expires_at) : null;
  const remainingSeconds=expiresAt && state!=='closed'
    ? Math.max(0,Math.floor((expiresAt.getTime()-now.getTime())/1000)) : 0;
  const result = {
    caseId:row.case_id,
    state,
    waitingOn:state === 'closed' ? 'none' : row.waiting_on,
    queuedAt:row.queued_at,
    acceptedAt:row.accepted_at || null,
    expiresAt:row.expires_at || null,
    resolvedAt:row.resolved_at || null,
    closedAt:row.closed_at || (state === 'closed' ? row.expires_at : null),
    closeReason:row.close_reason || (state === 'closed' ? 'expired' : null),
    effectiveClosed:state==='closed',
    remainingSeconds,
    messageCursor:{lastSequence:Number(row.last_message_sequence || 0)},
  };
  if (includeQuestion) result.initialQuestion = row.initial_question;
  return result;
}

function projectMessage(row) {
  return {
    messageId:row.message_id,
    sequence:Number(row.message_sequence),
    senderType:row.sender_type,
    body:row.body,
    createdAt:row.created_at,
  };
}

function createConsultationReadService({
  repository = createConsultationRepository(),
  authorize = authorizeCareProfileAccess,
  pharmacistAccounts = null,
} = {}) {
  const accounts = pharmacistAccounts || createPharmacistAccountService({ repository });

  async function authorizeFamilyCase(row, lineUserId) {
    if (!row || row.customer_line_user_id !== lineUserId) {
      throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED', 403);
    }
    assertProvisionedConsultationCase(row);
    await authorize({
      lineUserId, careProfileId:row.care_profile_id,
      permission:'view', requireActiveCenter:true,
    });
    return row;
  }

  async function authorizePharmacistCase(row, pharmacistLineUserId) {
    if (!row) throw new ConsultationDomainError('CASE_NOT_FOUND', 404);
    assertProvisionedConsultationCase(row);
    const pharmacist = await accounts.requireActive(pharmacistLineUserId);
    if (row.assigned_pharmacist_id !== pharmacist.pharmacistId) {
      throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED', 403);
    }
    return { row, pharmacist };
  }

  async function listFamilyCases({ lineUserId, careProfileId = null } = {}) {
    if (!lineUserId) throw new ConsultationDomainError('UNAUTHENTICATED', 401);
    const rows = await repository.listCasesForCustomer(lineUserId);
    const allowed = [];
    for (const row of rows) {
      if (careProfileId && row.care_profile_id !== careProfileId) continue;
      try {
        await authorizeFamilyCase(row, lineUserId);
        allowed.push(projectCase(row));
      } catch (_) {
        // A revoked relationship must not leak a case through a collection response.
      }
    }
    return { items:allowed };
  }

  async function getFamilyCase({ caseId, lineUserId } = {}) {
    const row = await repository.findCaseForRead(caseId);
    await authorizeFamilyCase(row, lineUserId);
    return projectCase(row, { includeQuestion:true });
  }

  async function listQueue({
    pharmacistLineUserId, cursor = null, limit = DEFAULT_QUEUE_LIMIT,
    minQueuedMinutes = 0, topicCategory = null, triageCategory = null,
  } = {}) {
    await accounts.requireActive(pharmacistLineUserId);
    const boundedLimit=parseQueueLimit(limit);
    const queueAge=parseQueueAge(minQueuedMinutes);
    const topic=parseCategory(topicCategory,'INVALID_TOPIC_CATEGORY');
    const triageFilter=parseCategory(triageCategory,'INVALID_TRIAGE_CATEGORY');
    const parsedCursor=parseQueueCursor(cursor);
    const rows = await repository.listQueuedCases({
      cursorQueuedAt:parsedCursor?.queuedAt || null,
      cursorCaseId:parsedCursor?.caseId || null,
      minQueuedMinutes:queueAge,
      limit:MAX_QUEUE_SCAN,
    });
    const projected=rows.map((row) => {
      const triage = classifyConsultationSafety(row.initial_question);
      const now=new Date(row.database_now || Date.now()).getTime();
      return {
        caseId:row.case_id, queuedAt:row.queued_at,
        topicCategory:triage.category, triageCategory:triage.action,
        waitingSeconds:Math.max(0,Math.floor((now-new Date(row.queued_at).getTime())/1000)),
        _row:row,
      };
    }).filter((item)=>(!topic || item.topicCategory===topic)
      && (!triageFilter || item.triageCategory===triageFilter));
    const hasMore=projected.length>boundedLimit;
    const visible=projected.slice(0,boundedLimit);
    return {
      items:visible.map(({_row,...item})=>item),
      nextCursor:hasMore ? encodeQueueCursor(visible.at(-1)._row) : null,
      hasMore,
    };
  }

  async function listPharmacistCases({ pharmacistLineUserId, collection='active' } = {}) {
    if (!['active','resolved','closed'].includes(collection)) {
      throw new ConsultationDomainError('INVALID_CASE_COLLECTION');
    }
    const pharmacist = await accounts.requireActive(pharmacistLineUserId);
    const rows = repository.listCasesForPharmacist
      ? await repository.listCasesForPharmacist(pharmacist.pharmacistId,{collection})
      : await repository.listActiveCasesForPharmacist(pharmacist.pharmacistId);
    return {items:rows.map((row)=>projectCase(row)).filter((item)=>item.state===collection)};
  }

  async function getPharmacistCase({ caseId, pharmacistLineUserId } = {}) {
    const row = await repository.findCaseForRead(caseId);
    await authorizePharmacistCase(row, pharmacistLineUserId);
    return projectCase(row, { includeQuestion:true });
  }

  async function listCaseMessages({
    caseId, lineUserId = null, pharmacistLineUserId = null,
    afterSequence = 0, limit = DEFAULT_MESSAGE_LIMIT,
  } = {}) {
    const row = await repository.findCaseForRead(caseId);
    if (pharmacistLineUserId) await authorizePharmacistCase(row, pharmacistLineUserId);
    else await authorizeFamilyCase(row, lineUserId);
    const after = parseSequence(afterSequence);
    const boundedLimit = parseLimit(limit);
    const rows = await repository.listMessages(caseId, { afterSequence:after, limit:boundedLimit + 1 });
    const hasMore = rows.length > boundedLimit;
    const visible = hasMore ? rows.slice(0, boundedLimit) : rows;
    const items = visible.map(projectMessage);
    return {
      items,
      afterSequence:after,
      nextSequence:items.length ? items.at(-1).sequence : after,
      hasMore,
    };
  }

  return {
    listFamilyCases, getFamilyCase, listQueue, listPharmacistCases,
    getPharmacistCase, listCaseMessages,
  };
}

const defaultService = createConsultationReadService();
module.exports = {
  DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT, parseSequence, parseLimit,
  DEFAULT_QUEUE_LIMIT, MAX_QUEUE_LIMIT, parseQueueLimit, parseQueueAge,
  parseQueueCursor, encodeQueueCursor,
  projectCase, projectMessage, createConsultationReadService,
  listFamilyConsultations:defaultService.listFamilyCases,
  getFamilyConsultation:defaultService.getFamilyCase,
  listPharmacistQueue:defaultService.listQueue,
  listActivePharmacistConsultations:defaultService.listPharmacistCases,
  getPharmacistConsultation:defaultService.getPharmacistCase,
  listConsultationMessages:defaultService.listCaseMessages,
};
