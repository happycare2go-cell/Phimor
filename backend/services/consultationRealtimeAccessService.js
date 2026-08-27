const crypto = require('node:crypto');
const { randomUUID } = crypto;
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { createConsultationRepository } = require('./consultationRepository');
const { createPharmacistAccountService } = require('./pharmacistAccountService');
const { createConsultationRealtimeTicketService } = require('./consultationRealtimeTicketService');
const {
  ConsultationDomainError,
  assertProvisionedConsultationCase,
  effectiveConsultationState,
} = require('../domain/consultation');

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function assertRealtimeOpen(row) {
  const state = effectiveConsultationState(row, new Date(row.database_now || Date.now()));
  if (state !== 'closed') return;
  const expired = row.close_reason === 'expired'
    || (row.expires_at && new Date(row.database_now || Date.now()).getTime() >= new Date(row.expires_at).getTime());
  throw new ConsultationDomainError(expired ? 'CONSULTATION_EXPIRED' : 'CONSULTATION_CLOSED', 409);
}

function createConsultationRealtimeAccessService({
  repository = createConsultationRepository(),
  authorize = authorizeCareProfileAccess,
  pharmacistAccounts = null,
  tickets = createConsultationRealtimeTicketService(),
} = {}) {
  const accounts = pharmacistAccounts || createPharmacistAccountService({ repository });

  async function authorizeFamily(row, lineUserId) {
    if (!row || row.customer_line_user_id !== lineUserId) {
      throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED', 403);
    }
    assertProvisionedConsultationCase(row);
    assertRealtimeOpen(row);
    await authorize({
      lineUserId,
      careProfileId: row.care_profile_id,
      permission: 'view',
      requireActiveCenter: true,
    });
    return row;
  }

  async function authorizePharmacist(row, pharmacistLineUserId) {
    if (!row) throw new ConsultationDomainError('CASE_NOT_FOUND', 404);
    assertProvisionedConsultationCase(row);
    assertRealtimeOpen(row);
    const pharmacist = await accounts.requireActive(pharmacistLineUserId);
    if (!row.assigned_pharmacist_id || row.assigned_pharmacist_id !== pharmacist.pharmacistId
        || row.state === 'queued') {
      throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED', 403);
    }
    return { row, pharmacist };
  }

  async function issueFamilyTicket({ caseId, lineUserId } = {}) {
    const row = await repository.findCaseForRead(caseId);
    await authorizeFamily(row, lineUserId);
    return tickets.issue({ caseId: row.case_id, role: 'customer', actorId: lineUserId });
  }

  async function issuePharmacistTicket({ caseId, pharmacistLineUserId } = {}) {
    const row = await repository.findCaseForRead(caseId);
    const { pharmacist } = await authorizePharmacist(row, pharmacistLineUserId);
    return tickets.issue({ caseId: row.case_id, role: 'pharmacist', actorId: pharmacist.pharmacistId });
  }

  async function authorizeTicket(ticket) {
    const payload = typeof ticket === 'string' ? tickets.verify(ticket) : ticket;
    const row = await repository.findCaseForRead(payload.caseId);
    if (!row) throw new ConsultationDomainError('CASE_NOT_FOUND', 404);
    assertProvisionedConsultationCase(row);
    assertRealtimeOpen(row);
    if (payload.role === 'customer') {
      const expected = tickets.actorReference('customer', row.customer_line_user_id);
      if (!safeEqual(expected, payload.actorRef)) {
        throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED', 403);
      }
      await authorize({
        lineUserId: row.customer_line_user_id,
        careProfileId: row.care_profile_id,
        permission: 'view',
        requireActiveCenter: true,
      });
      return { payload, row, role: 'customer' };
    }
    if (payload.role === 'pharmacist') {
      if (!row.assigned_pharmacist_id || row.state === 'queued') {
        throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED', 403);
      }
      const expected = tickets.actorReference('pharmacist', row.assigned_pharmacist_id);
      if (!safeEqual(expected, payload.actorRef)) {
        throw new ConsultationDomainError('CONSULTATION_ACCESS_DENIED', 403);
      }
      await accounts.requireActiveById(row.assigned_pharmacist_id);
      return { payload, row, role: 'pharmacist' };
    }
    throw new ConsultationDomainError('INVALID_REALTIME_ROLE', 401);
  }

  async function consumeTicket(ticket) {
    const authorization = await authorizeTicket(ticket);
    let consumed;
    try {
      consumed = await repository.insertEvent({
        event_id:`CRE-${randomUUID()}`,
        case_id:authorization.payload.caseId,
        event_type:'realtime_ticket_consumed',
        actor_type:authorization.payload.role,
        actor_id:null,
        metadata:{ ticketVersion:authorization.payload.version },
        idempotency_key:`realtime-ticket:${authorization.payload.ticketId}`,
      });
    } catch (_) {
      throw new ConsultationDomainError('CONSULTATION_REALTIME_UNAVAILABLE', 503);
    }
    if (!consumed) throw new ConsultationDomainError('REALTIME_TICKET_REPLAYED', 401);
    return authorization;
  }

  return {
    authorizeFamily,
    authorizePharmacist,
    issueFamilyTicket,
    issuePharmacistTicket,
    authorizeTicket,
    consumeTicket,
  };
}

module.exports = { assertRealtimeOpen, createConsultationRealtimeAccessService };
