const crypto = require('node:crypto');
const { randomUUID } = crypto;
const { ConsultationDomainError } = require('../domain/consultation');
const { loadConsultationRealtimeConfig } = require('../config/consultationRealtimeConfig');

const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ACTOR_ROLES = Object.freeze(['customer', 'pharmacist']);

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signature(secret, encoded) {
  return crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createConsultationRealtimeTicketService({
  config = loadConsultationRealtimeConfig(),
  clock = () => Date.now(),
  ticketId = randomUUID,
} = {}) {
  function requireSecret() {
    if (!config.configured || !config.ticketSecret) {
      throw new ConsultationDomainError('CONSULTATION_REALTIME_UNAVAILABLE', 503);
    }
    return config.ticketSecret;
  }

  function actorReference(role, actorId) {
    if (!ACTOR_ROLES.includes(role) || typeof actorId !== 'string' || !actorId.trim()) {
      throw new ConsultationDomainError('INVALID_REALTIME_ACTOR');
    }
    return crypto.createHmac('sha256', requireSecret())
      .update(`consultation-realtime-actor:${role}:${actorId.trim()}`)
      .digest('base64url');
  }

  function issue({ caseId, role, actorId } = {}) {
    if (!CASE_ID_PATTERN.test(caseId || '')) throw new ConsultationDomainError('INVALID_CASE_ID');
    if (!ACTOR_ROLES.includes(role)) throw new ConsultationDomainError('INVALID_REALTIME_ROLE');
    const issuedAt = Math.floor(clock() / 1000);
    const payload = Object.freeze({
      version: 1,
      ticketId: ticketId(),
      caseId,
      role,
      actorRef: actorReference(role, actorId),
      issuedAt,
      expiresAt: issuedAt + config.ticketTtlSeconds,
    });
    const encoded = encode(payload);
    return Object.freeze({
      ticket: `${encoded}.${signature(requireSecret(), encoded)}`,
      expiresAt: new Date(payload.expiresAt * 1000).toISOString(),
      websocketPath: config.websocketPath,
    });
  }

  function verify(ticket) {
    if (typeof ticket !== 'string' || ticket.length > 2048) {
      throw new ConsultationDomainError('REALTIME_TICKET_INVALID', 401);
    }
    const [encoded, provided, extra] = ticket.split('.');
    if (!encoded || !provided || extra || !safeEqual(signature(requireSecret(), encoded), provided)) {
      throw new ConsultationDomainError('REALTIME_TICKET_INVALID', 401);
    }
    let payload;
    try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
    catch (_) { throw new ConsultationDomainError('REALTIME_TICKET_INVALID', 401); }
    const nowSeconds = Math.floor(clock() / 1000);
    if (payload?.version !== 1 || !CASE_ID_PATTERN.test(payload.caseId || '')
        || !ACTOR_ROLES.includes(payload.role) || typeof payload.actorRef !== 'string'
        || typeof payload.ticketId !== 'string' || !Number.isSafeInteger(payload.issuedAt)
        || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= nowSeconds
        || payload.issuedAt > nowSeconds + 5
        || payload.expiresAt - payload.issuedAt !== config.ticketTtlSeconds) {
      throw new ConsultationDomainError(
        Number.isSafeInteger(payload?.expiresAt) && payload.expiresAt <= nowSeconds
          ? 'REALTIME_TICKET_EXPIRED' : 'REALTIME_TICKET_INVALID',
        401
      );
    }
    return Object.freeze(payload);
  }

  return { issue, verify, actorReference };
}

module.exports = {
  CASE_ID_PATTERN,
  ACTOR_ROLES,
  createConsultationRealtimeTicketService,
};
