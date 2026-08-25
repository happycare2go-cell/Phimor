const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { createConsultationRepository } = require('./consultationRepository');
const { createPharmacistAccountService } = require('./pharmacistAccountService');
const { classifyConsultationSafety } = require('./consultationSafetyService');
const {
  ConsultationDomainError, effectiveConsultationState, assertProvisionedConsultationCase,
} = require('../domain/consultation');

const DEFAULT_MESSAGE_LIMIT = 20;
const MAX_MESSAGE_LIMIT = 50;

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

function projectCase(row, { includeQuestion = false } = {}) {
  const state = effectiveConsultationState(row, row.database_now || new Date());
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

  async function listFamilyCases({ lineUserId } = {}) {
    if (!lineUserId) throw new ConsultationDomainError('UNAUTHENTICATED', 401);
    const rows = await repository.listCasesForCustomer(lineUserId);
    const allowed = [];
    for (const row of rows) {
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

  async function listQueue({ pharmacistLineUserId } = {}) {
    await accounts.requireActive(pharmacistLineUserId);
    const rows = await repository.listQueuedCases();
    return {
      items:rows.map((row) => {
        const triage = classifyConsultationSafety(row.initial_question);
        return {
          caseId:row.case_id,
          queuedAt:row.queued_at,
          topicCategory:triage.category,
          triageCategory:triage.action,
        };
      }),
    };
  }

  async function listPharmacistCases({ pharmacistLineUserId } = {}) {
    const pharmacist = await accounts.requireActive(pharmacistLineUserId);
    const rows = await repository.listActiveCasesForPharmacist(pharmacist.pharmacistId);
    return { items:rows.map((row) => projectCase(row)).filter((item) => item.state !== 'closed') };
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
  projectCase, projectMessage, createConsultationReadService,
  listFamilyConsultations:defaultService.listFamilyCases,
  getFamilyConsultation:defaultService.getFamilyCase,
  listPharmacistQueue:defaultService.listQueue,
  listActivePharmacistConsultations:defaultService.listPharmacistCases,
  getPharmacistConsultation:defaultService.getPharmacistCase,
  listConsultationMessages:defaultService.listCaseMessages,
};
