const { randomUUID } = require('node:crypto');
const { databaseQuery } = require('../db');

const RESULT_STATUSES = new Set(['started', 'success', 'error', 'escalated', 'needs_review', 'denied']);
const REQUESTER_TYPES = new Set(['family', 'pharmacist', 'system']);

function safeString(value, maxLength) {
  if (value === undefined || value === null) return null;
  return String(value).trim().slice(0, maxLength) || null;
}

function safeCount(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 10_000_000);
}

function safeTimestamp(value, fallback = null) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function sanitizeAIInteractionMetadata(input = {}) {
  const requestedAt = safeTimestamp(input.requestedAt, new Date().toISOString());
  const resultStatus = RESULT_STATUSES.has(input.resultStatus) ? input.resultStatus : 'error';
  return Object.freeze({
    interactionId: safeString(input.interactionId, 80) || `AI-${randomUUID()}`,
    requesterLineId: safeString(input.requesterLineId, 128),
    careProfileId: safeString(input.careProfileId, 80),
    consultationCaseId: safeString(input.consultationCaseId, 80),
    requesterType: REQUESTER_TYPES.has(input.requesterType) ? input.requesterType : null,
    purpose: safeString(input.purpose, 64) || 'unspecified',
    intent: safeString(input.intent, 64),
    provider: safeString(input.provider, 32),
    model: safeString(input.model, 128),
    promptVersion: safeString(input.promptVersion, 64),
    contextVersion: safeString(input.contextVersion, 64),
    requestedAt,
    completedAt: safeTimestamp(input.completedAt),
    resultStatus,
    errorCode: safeString(input.errorCode, 64),
    escalation: input.escalation === true,
    providerRequestId: safeString(input.providerRequestId, 160),
    inputCharacterCount: safeCount(input.inputCharacterCount),
    outputCharacterCount: safeCount(input.outputCharacterCount),
  });
}

function defaultAuditLogger(event) {
  console.error('[AI Audit]', JSON.stringify(event));
}

async function recordAIInteractionMetadata(input, { queryFn = databaseQuery, logger = defaultAuditLogger } = {}) {
  const record = sanitizeAIInteractionMetadata(input);
  try {
    await queryFn(
      `INSERT INTO ai_interaction_audit (
        interaction_id, requester_line_id, care_profile_id, purpose, intent,
        provider, model, prompt_version, context_version, requested_at,
        completed_at, result_status, error_code, escalation, provider_request_id,
        input_character_count, output_character_count, consultation_case_id, requester_type
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19
      )`,
      [
        record.interactionId, record.requesterLineId, record.careProfileId, record.purpose, record.intent,
        record.provider, record.model, record.promptVersion, record.contextVersion, record.requestedAt,
        record.completedAt, record.resultStatus, record.errorCode, record.escalation, record.providerRequestId,
        record.inputCharacterCount, record.outputCharacterCount,
        record.consultationCaseId, record.requesterType,
      ]
    );
    return { recorded: true, interactionId: record.interactionId };
  } catch (_) {
    // Plus MVP policy is fail-open for metadata audit availability: clinical retrieval
    // remains available, while an operational signal is emitted without PHI.
    if (typeof logger === 'function') {
      logger({ event: 'ai_audit_insert_failed', errorCode: 'AI_AUDIT_WRITE_FAILED', interactionId: record.interactionId });
    }
    return { recorded: false, interactionId: record.interactionId, errorCode: 'AI_AUDIT_WRITE_FAILED' };
  }
}

module.exports = {
  RESULT_STATUSES, REQUESTER_TYPES, sanitizeAIInteractionMetadata, recordAIInteractionMetadata, defaultAuditLogger,
};
