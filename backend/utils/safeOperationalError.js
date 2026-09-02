function safeErrorCode(error, fallback = 'UNEXPECTED_ERROR') {
  const value = String(error?.code || '').trim().toUpperCase();
  const fallbackValue = String(fallback || '').trim().toUpperCase();
  const safeFallback = /^[A-Z0-9_]{2,64}$/.test(fallbackValue)
    ? fallbackValue : 'UNEXPECTED_ERROR';
  return /^[A-Z0-9_]{2,64}$/.test(value) ? value : safeFallback;
}

function safeHttpStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

function safeRequestId(value) {
  const requestId = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{1,160}$/.test(requestId) ? requestId : null;
}

function logOperationalError(logger, {
  event,
  error,
  errorCode,
  httpStatus,
  requestId,
  routeCategory,
} = {}) {
  if (typeof logger !== 'function') return null;
  const payload = {
    event:/^[a-z0-9_.:-]{2,80}$/i.test(String(event || '')) ? String(event) : 'operation_failed',
    errorCode:safeErrorCode(errorCode ? { code:errorCode } : error),
  };
  const status = safeHttpStatus(httpStatus ?? error?.status ?? error?.statusCode);
  const reference = safeRequestId(requestId);
  if (status) payload.httpStatus = status;
  if (reference) payload.requestId = reference;
  if (/^[a-z0-9_.:-]{2,80}$/i.test(String(routeCategory || ''))) payload.routeCategory = String(routeCategory);
  try { logger('[Operational Error]', JSON.stringify(payload)); } catch (_) { /* logging is best effort */ }
  return payload;
}

module.exports = { safeErrorCode, safeHttpStatus, safeRequestId, logOperationalError };
