const { randomUUID } = require('node:crypto');

const DATABASE_ERROR_CATEGORIES = Object.freeze({
  schema: new Set(['42P01', '42703']),
  constraint: new Set(['23502', '23503', '23505', '23514']),
  concurrency: new Set(['40001', '40P01', '55P03']),
});

function databaseFailureCategory(error) {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  if (DATABASE_ERROR_CATEGORIES.schema.has(code)) return 'database_schema';
  if (DATABASE_ERROR_CATEGORIES.constraint.has(code)) return 'database_constraint';
  if (DATABASE_ERROR_CATEGORIES.concurrency.has(code)) return 'database_concurrency';
  if (code.startsWith('08') || code === '57P01') return 'database_connection';
  return 'consultation_write';
}

function defaultOperationalLogger(event) {
  console.error('[Consultation Operation]', JSON.stringify(event));
}

function recordConsultationWriteFailure(error, {
  action,
  logger = defaultOperationalLogger,
  correlationIdFactory = () => `CREF-${randomUUID()}`,
} = {}) {
  const correlationId = correlationIdFactory();
  const event = Object.freeze({
    event: 'consultation_write_failed',
    action,
    correlationId,
    failureCategory: databaseFailureCategory(error),
    safeErrorCode: 'CONSULTATION_UNAVAILABLE',
  });
  try {
    if (typeof logger === 'function') logger(event);
  } catch (_) {
    // Diagnostics must never replace or expose the original safe failure response.
  }
  return correlationId;
}

module.exports = { databaseFailureCategory, recordConsultationWriteFailure };
