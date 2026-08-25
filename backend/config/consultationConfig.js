const { parseBoolean } = require('./featureFlags');
const { parseInteger } = require('./v2Config');
const {
  CONSULTATION_PRICE_MINOR,
  CONSULTATION_CURRENCY,
  CONSULTATION_DURATION_MINUTES,
  CONSULTATION_MESSAGE_MAX_LENGTH,
} = require('../domain/consultation');

const DEFAULT_POLL_SECONDS = 5;

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
  });
}

function isInternalConsultationUser(lineUserId, config = loadConsultationConfig()) {
  return !config.internalOnly || config.internalLineUserIds.includes(lineUserId);
}

module.exports = {
  DEFAULT_POLL_SECONDS,
  approvedInteger,
  parseInternalLineUsers,
  loadConsultationConfig,
  isInternalConsultationUser,
};
