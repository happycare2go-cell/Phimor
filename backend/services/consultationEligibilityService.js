const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { loadConsultationConfig, isInternalConsultationUser } = require('../config/consultationConfig');

function createConsultationEligibilityService({
  authorize = authorizeCareProfileAccess,
  configLoader = loadConsultationConfig,
} = {}) {
  async function checkEligibility({ lineUserId, careProfileId, config: suppliedConfig = null } = {}) {
    const config = suppliedConfig || configLoader();
    if (!config.enabled) return { availability:'unavailable', reasonCode:'CONSULTATION_DISABLED' };
    if (!lineUserId || typeof lineUserId !== 'string') return { availability:'denied', reasonCode:'UNAUTHENTICATED' };
    if (!isInternalConsultationUser(lineUserId, config)) {
      return { availability:'unavailable', reasonCode:'INTERNAL_ACCESS_REQUIRED' };
    }
    try {
      await authorize({ lineUserId, careProfileId, permission:'view', requireActiveCenter:true });
    } catch (error) {
      return {
        availability:'denied',
        reasonCode: error?.code === 'UNAUTHENTICATED' ? 'UNAUTHENTICATED' : 'ACCESS_DENIED',
      };
    }
    return {
      availability:'eligible',
      price:{ amountMinor:config.priceMinor, currency:config.currency },
      durationMinutes:config.durationMinutes,
      durationHours:config.durationMinutes / 60,
      termsVersion:config.termsVersion,
      checkoutAvailable:Boolean(config.termsVersion),
      checkoutReasonCode:config.termsVersion ? null : 'CONSULTATION_TERMS_NOT_CONFIGURED',
    };
  }
  return { checkEligibility };
}

const defaultService = createConsultationEligibilityService();
module.exports = {
  createConsultationEligibilityService,
  checkConsultationEligibility: defaultService.checkEligibility,
};
