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

  function enforce(result) {
    if (result.allowed) return result;
    const error=new ConsultationDomainError('CONSULTATION_RATE_LIMITED',429);
    error.retryAfterMs=result.retryAfterMs;
    throw error;
  }

  function limits(config) {
    return config?.rateLimits || configLoader().rateLimits;
  }

  function checkMessage(input,config=configLoader()) {
    const rateLimits=limits(config);
    return check(`consultation:message:${input.caseId}:${input.actorType}:${input.actorId}`,
      rateLimits.messageSendsPerMinute,60*1000);
  }

  function checkPharmacistAccept(pharmacistId,config=configLoader()) {
    return check(`consultation:accept:${pharmacistId}`,limits(config).pharmacistAcceptsPerMinute,60*1000);
  }

  return {
    checkCheckout(lineUserId, config = configLoader()) {
      return check(`consultation:checkout:${lineUserId}`, limits(config).checkoutAttemptsPer10Minutes, 10*60*1000);
    },
    checkMessage({caseId,actorType,actorId}, config = configLoader()) {
      return checkMessage({caseId,actorType,actorId},config);
    },
    checkPharmacistAccept(pharmacistId, config = configLoader()) {
      return checkPharmacistAccept(pharmacistId,config);
    },
    requireMessage(input,config=configLoader()) { return enforce(checkMessage(input,config)); },
    requirePharmacistAccept(pharmacistId,config=configLoader()) {
      return enforce(checkPharmacistAccept(pharmacistId,config));
    },
  };
}

module.exports = { createConsultationRateLimitService };
