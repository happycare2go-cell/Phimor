const rateLimiter = require('../utils/rateLimiter');
const { loadConsultationConfig } = require('../config/consultationConfig');
const { ConsultationDomainError } = require('../domain/consultation');

// This adapter intentionally reuses the current in-memory limiter. It is safe
// only for a single backend instance and must move to a shared store before
// multi-instance consultation traffic is enabled.
function createConsultationRateLimitService({ limiter = rateLimiter, configLoader = loadConsultationConfig } = {}) {
  function check(key, limit, windowMs) {
    if (!key) throw new ConsultationDomainError('RATE_LIMIT_IDENTITY_REQUIRED');
    return limiter.checkAndRecord(key, limit, windowMs);
  }

  return {
    checkCheckout(lineUserId, config = configLoader()) {
      return check(`consultation:checkout:${lineUserId}`, config.rateLimits.checkoutAttemptsPer10Minutes, 10*60*1000);
    },
    checkMessage({caseId,actorType,actorId}, config = configLoader()) {
      return check(`consultation:message:${caseId}:${actorType}:${actorId}`, config.rateLimits.messageSendsPerMinute, 60*1000);
    },
    checkPharmacistAccept(pharmacistId, config = configLoader()) {
      return check(`consultation:accept:${pharmacistId}`, config.rateLimits.pharmacistAcceptsPerMinute, 60*1000);
    },
  };
}

module.exports = { createConsultationRateLimitService };
