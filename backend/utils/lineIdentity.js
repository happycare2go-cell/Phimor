const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/i;

function normalizeLineUserId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidLineUserId(value) {
  return LINE_USER_ID_PATTERN.test(normalizeLineUserId(value));
}

module.exports = { LINE_USER_ID_PATTERN, normalizeLineUserId, isValidLineUserId };
