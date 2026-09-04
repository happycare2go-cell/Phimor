const { parseBoolean } = require('./featureFlags');

const CLINICAL_RESEARCH_MODES = Object.freeze({
  DISABLED: 'disabled',
  DEIDENTIFIED_PILOT: 'deidentified_pilot',
  CONTROLLED_LIVE: 'controlled_live',
});

const VALID_MODES = new Set(Object.values(CLINICAL_RESEARCH_MODES));

function parseIdentityAllowlist(value) {
  if (typeof value !== 'string' || !value.trim()) return Object.freeze([]);
  return Object.freeze([...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))].slice(0, 200));
}

const parsePilotUsers = parseIdentityAllowlist;

function loadClinicalResearchPilotConfig(env = process.env) {
  const emergencyEnabled = parseBoolean(env.PHARMACIST_AI_RESEARCH_ENABLED, false) === true;
  const requestedMode = String(env.PHARMACIST_AI_RESEARCH_MODE || '').trim().toLowerCase();
  const configuredMode = VALID_MODES.has(requestedMode) ? requestedMode : CLINICAL_RESEARCH_MODES.DISABLED;
  const mode = emergencyEnabled ? configuredMode : CLINICAL_RESEARCH_MODES.DISABLED;
  return Object.freeze({
    emergencyEnabled,
    mode,
    pilotUsers:parsePilotUsers(env.PHARMACIST_AI_RESEARCH_PILOT_USERS),
    controlledLiveUsers:parseIdentityAllowlist(env.PHARMACIST_AI_RESEARCH_CONTROLLED_LIVE_USERS),
  });
}

function clinicalResearchAccess(config, lineUserId) {
  if (!config?.emergencyEnabled || config.mode === CLINICAL_RESEARCH_MODES.DISABLED) {
    return Object.freeze({
      status:'disabled', mode:CLINICAL_RESEARCH_MODES.DISABLED, allowed:false,
      requiresDeidentifiedInput:false, requiresAcknowledgment:false,
    });
  }
  const identity = typeof lineUserId === 'string' ? lineUserId.trim() : '';
  const allowed = config.mode === CLINICAL_RESEARCH_MODES.CONTROLLED_LIVE
    ? Boolean(identity) && Array.isArray(config.controlledLiveUsers)
      && config.controlledLiveUsers.includes(identity)
    : Boolean(identity) && config.pilotUsers.includes(identity);
  if (!allowed) {
    return Object.freeze({
      status:'not_allowed', mode:config.mode, allowed:false,
      requiresDeidentifiedInput:config.mode === CLINICAL_RESEARCH_MODES.DEIDENTIFIED_PILOT,
      requiresAcknowledgment:true,
    });
  }
  return Object.freeze({
    status:'available', mode:config.mode, allowed:true,
    requiresDeidentifiedInput:config.mode === CLINICAL_RESEARCH_MODES.DEIDENTIFIED_PILOT,
    requiresAcknowledgment:true,
  });
}

function publicClinicalResearchCapability(config, lineUserId) {
  return Object.freeze({
    featureName:'พี่หมอ Clinical Research',
    description:'ผู้ช่วยค้นคว้าข้อมูลประกอบการดูแลสำหรับเภสัชกร',
    ...clinicalResearchAccess(config, lineUserId),
  });
}

module.exports = {
  CLINICAL_RESEARCH_MODES, parseIdentityAllowlist, parsePilotUsers, loadClinicalResearchPilotConfig,
  clinicalResearchAccess, publicClinicalResearchCapability,
};
