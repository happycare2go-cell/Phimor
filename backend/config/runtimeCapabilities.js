const { loadClinicalResearchPilotConfig, CLINICAL_RESEARCH_MODES } = require('./clinicalResearchPilot');
const { getPlusPaymentReversalConfigurationIssue } = require('./plusPaymentReversal');

const FULL_RUNTIME_REQUIRED_ENV = Object.freeze([
  'DATABASE_URL',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'LINE_LOGIN_CHANNEL_ID',
  'LIFF_ID_CENTER_ADMIN',
  'LIFF_ID_FAMILY',
  'LIFF_ID_REGISTER',
  'LIFF_ID_SYSTEM_ADMIN',
  'ADMIN_API_KEY',
  'ALLOWED_ORIGINS',
  'CONSULTATION_REALTIME_TICKET_SECRET',
]);

const MINIMAL_FAMILY_PLUS_REQUIRED_ENV = Object.freeze([
  'DATABASE_URL',
  'PUBLIC_BACKEND_URL',
  'LINE_LOGIN_CHANNEL_ID',
  'LIFF_ID_FAMILY',
  'GEMINI_API_KEY',
]);

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isMinimalFamilyPlusStaging(env = process.env) {
  return env.STAGING_MODE === 'true' && env.STAGING_FAMILY_PLUS_ONLY === 'true';
}

function messagingConfigured(env = process.env) {
  return hasValue(env.LINE_CHANNEL_ACCESS_TOKEN) && hasValue(env.LINE_CHANNEL_SECRET);
}

function requiredRuntimeEnvironment(env = process.env) {
  if (env.NODE_ENV === 'test') return [];
  const required = isMinimalFamilyPlusStaging(env)
    ? [...MINIMAL_FAMILY_PLUS_REQUIRED_ENV]
    : [...FULL_RUNTIME_REQUIRED_ENV];
  // Pharmacist LIFF is required only when the paid consultation product is
  // enabled. System Admin is part of the full production operations surface.
  if (!isMinimalFamilyPlusStaging(env) && String(env.CONSULTATION_ENABLED || '').trim().toLowerCase() === 'true') {
    required.push('LIFF_ID_PHARMACIST');
  }
  if (String(env.PLUS_PAYMENT_ENABLED || '').trim().toLowerCase() === 'true') {
    required.push('CONSULTATION_PAYMENT_PROVIDER', 'OMISE_PUBLIC_KEY', 'OMISE_SECRET_KEY', 'OMISE_WEBHOOK_SECRET');
  }
  return required;
}

function missingRuntimeEnvironment(env = process.env) {
  return requiredRuntimeEnvironment(env).filter((key) => !hasValue(env[key]));
}

function unsafeRuntimeConfiguration(env = process.env) {
  if (env.NODE_ENV !== 'production') return [];
  const issues = [];
  if (env.ALLOW_INSECURE_LINE_HEADER === 'true') issues.push('INSECURE_LINE_HEADER_ENABLED');
  if (env.ALLOW_UNSIGNED_LINE_WEBHOOK === 'true') issues.push('UNSIGNED_LINE_WEBHOOK_ENABLED');
  if (!hasValue(env.PDF_DOWNLOAD_SECRET)) issues.push('PDF_DOWNLOAD_SECRET_MISSING');
  const paymentReversalIssue = getPlusPaymentReversalConfigurationIssue(env);
  if (paymentReversalIssue) issues.push(paymentReversalIssue);
  const ordinaryProvider = String(env.AI_PROVIDER || 'gemini').trim().toLowerCase();
  const pharmacistProvider = String(env.AI_PROVIDER_PHARMACIST || ordinaryProvider).trim().toLowerCase();
  if ([ordinaryProvider, pharmacistProvider].includes('openai') && !hasValue(env.OPENAI_API_KEY)) {
    issues.push('OPENAI_API_KEY_MISSING');
  }
  const researchPilot = loadClinicalResearchPilotConfig(env);
  if (researchPilot.mode !== CLINICAL_RESEARCH_MODES.DISABLED) {
    const researchProvider = String(
      env.AI_PROVIDER_CLINICAL_RESEARCH || env.AI_PROVIDER || 'gemini',
    ).trim().toLowerCase();
    const providerReady = researchProvider === 'openai' ? hasValue(env.OPENAI_API_KEY)
      : researchProvider === 'gemini' ? hasValue(env.GEMINI_API_KEY) : false;
    if (!providerReady) issues.push('PHARMACIST_AI_RESEARCH_CONFIGURATION_MISSING');
    if (researchPilot.mode === CLINICAL_RESEARCH_MODES.CONTROLLED_LIVE
      && researchPilot.controlledLiveUsers.length === 0) {
      issues.push('CLINICAL_RESEARCH_CONTROLLED_LIVE_ALLOWLIST_EMPTY');
    }
  }
  return issues;
}

function buildPublicLiffConfig(env = process.env) {
  const configured = {
    publicBackendUrl: env.PUBLIC_BACKEND_URL,
    familyLiffId: env.LIFF_ID_FAMILY,
    centerAdminLiffId: env.LIFF_ID_CENTER_ADMIN,
    registerLiffId: env.LIFF_ID_REGISTER,
    systemAdminLiffId: env.LIFF_ID_SYSTEM_ADMIN,
    pharmacistLiffId: env.LIFF_ID_PHARMACIST,
  };
  return Object.fromEntries(Object.entries(configured).filter(([, value]) => hasValue(value)));
}

module.exports = {
  FULL_RUNTIME_REQUIRED_ENV,
  MINIMAL_FAMILY_PLUS_REQUIRED_ENV,
  isMinimalFamilyPlusStaging,
  messagingConfigured,
  requiredRuntimeEnvironment,
  missingRuntimeEnvironment,
  unsafeRuntimeConfiguration,
  buildPublicLiffConfig,
};
