const FULL_RUNTIME_REQUIRED_ENV = Object.freeze([
  'DATABASE_URL',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'LINE_LOGIN_CHANNEL_ID',
  'LIFF_ID_CENTER_ADMIN',
  'LIFF_ID_FAMILY',
  'LIFF_ID_REGISTER',
  'ADMIN_API_KEY',
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
  return isMinimalFamilyPlusStaging(env)
    ? [...MINIMAL_FAMILY_PLUS_REQUIRED_ENV]
    : [...FULL_RUNTIME_REQUIRED_ENV];
}

function missingRuntimeEnvironment(env = process.env) {
  return requiredRuntimeEnvironment(env).filter((key) => !hasValue(env[key]));
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
  buildPublicLiffConfig,
};
