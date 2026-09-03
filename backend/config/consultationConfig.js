const { parseBoolean } = require('./featureFlags');
const { parseInteger } = require('./v2Config');
const {
  CONSULTATION_PRICE_MINOR,
  CONSULTATION_CURRENCY,
  CONSULTATION_DURATION_MINUTES,
  CONSULTATION_MESSAGE_MAX_LENGTH,
} = require('../domain/consultation');

const DEFAULT_POLL_SECONDS = 5;
const DEFAULT_CHECKOUT_ATTEMPTS_PER_10_MINUTES = 3;
const DEFAULT_MESSAGE_SENDS_PER_MINUTE = 10;
const DEFAULT_PHARMACIST_ACCEPTS_PER_MINUTE = 10;
const DEFAULT_ASSISTANT_REQUESTS_PER_10_MINUTES = 5;
const DEFAULT_CLINICAL_RESEARCH_REQUESTS_PER_10_MINUTES = 3;

function approvedInteger(value, approved) {
  const parsed = parseInteger(value, approved, { min: approved, max: approved });
  return parsed === approved ? approved : approved;
}

function parseInternalLineUsers(value) {
  if (typeof value !== 'string') return Object.freeze([]);
  return Object.freeze([...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]);
}

function loadConsultationConfig(env = process.env) {
  const currency = String(env.CONSULTATION_CURRENCY || CONSULTATION_CURRENCY).trim().toUpperCase();
  return Object.freeze({
    enabled: parseBoolean(env.CONSULTATION_ENABLED, false),
    internalOnly: parseBoolean(env.CONSULTATION_INTERNAL_ONLY, true),
    internalLineUserIds: parseInternalLineUsers(env.CONSULTATION_INTERNAL_LINE_USER_IDS),
    priceMinor: approvedInteger(env.CONSULTATION_PRICE_MINOR, CONSULTATION_PRICE_MINOR),
    currency: currency === CONSULTATION_CURRENCY ? currency : CONSULTATION_CURRENCY,
    durationMinutes: approvedInteger(env.CONSULTATION_DURATION_MINUTES, CONSULTATION_DURATION_MINUTES),
    pollSeconds: parseInteger(env.CONSULTATION_POLL_SECONDS, DEFAULT_POLL_SECONDS, { min: 2, max: 60 }),
    maxMessageChars: approvedInteger(env.CONSULTATION_MAX_MESSAGE_CHARS, CONSULTATION_MESSAGE_MAX_LENGTH),
    termsVersion: String(env.CONSULTATION_TERMS_VERSION || '').trim() || null,
    rateLimits:Object.freeze({
      checkoutAttemptsPer10Minutes:parseInteger(
        env.CONSULTATION_CHECKOUT_ATTEMPTS_PER_10_MINUTES,
        DEFAULT_CHECKOUT_ATTEMPTS_PER_10_MINUTES, {min:1,max:20}
      ),
      messageSendsPerMinute:parseInteger(
        env.CONSULTATION_MESSAGE_SENDS_PER_MINUTE,
        DEFAULT_MESSAGE_SENDS_PER_MINUTE, {min:1,max:100}
      ),
      pharmacistAcceptsPerMinute:parseInteger(
        env.CONSULTATION_PHARMACIST_ACCEPTS_PER_MINUTE,
        DEFAULT_PHARMACIST_ACCEPTS_PER_MINUTE, {min:1,max:60}
      ),
      assistantRequestsPer10Minutes:parseInteger(
        env.CONSULTATION_ASSISTANT_REQUESTS_PER_10_MINUTES,
        DEFAULT_ASSISTANT_REQUESTS_PER_10_MINUTES, {min:1,max:20}
      ),
      clinicalResearchRequestsPer10Minutes:parseInteger(
        env.CLINICAL_RESEARCH_REQUESTS_PER_10_MINUTES,
        DEFAULT_CLINICAL_RESEARCH_REQUESTS_PER_10_MINUTES, {min:1,max:10}
      ),
    }),
  });
}

function isInternalConsultationUser(lineUserId, config = loadConsultationConfig()) {
  return !config.internalOnly || config.internalLineUserIds.includes(lineUserId);
}

module.exports = {
  DEFAULT_POLL_SECONDS,
  DEFAULT_CHECKOUT_ATTEMPTS_PER_10_MINUTES,
  DEFAULT_MESSAGE_SENDS_PER_MINUTE,
  DEFAULT_PHARMACIST_ACCEPTS_PER_MINUTE,
  DEFAULT_ASSISTANT_REQUESTS_PER_10_MINUTES,
  DEFAULT_CLINICAL_RESEARCH_REQUESTS_PER_10_MINUTES,
  approvedInteger,
  parseInternalLineUsers,
  loadConsultationConfig,
  isInternalConsultationUser,
};
