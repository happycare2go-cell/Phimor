const { createDailyCareRepository } = require('./dailyCareRepository');

function createNotificationDeliveryPolicyService(overrides = {}) {
  const dailyCareRepository = overrides.dailyCareRepository || createDailyCareRepository();

  async function validate(notification) {
    if (notification?.kind !== 'family_daily_care_finalized'
      || notification?.meta?.resourceType !== 'daily_care') {
      return { allowed:true };
    }
    const resourceId = notification.meta.resourceId;
    if (typeof resourceId !== 'string' || !resourceId.trim()) {
      return { allowed:false, reason:'AUTHORITATIVE_RESOURCE_INVALID' };
    }
    const authoritative = await dailyCareRepository.findAuthoritativeFinalized(resourceId);
    return authoritative
      ? { allowed:true }
      : { allowed:false, reason:'AUTHORITATIVE_RESOURCE_NOT_FINALIZED' };
  }

  return { validate };
}

module.exports = { createNotificationDeliveryPolicyService };
