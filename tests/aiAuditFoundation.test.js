const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const migration = require('../backend/migrations/0001_create_ai_interaction_audit');
const { AI_VERSIONS } = require('../backend/config/aiVersions');
const {
  safeOptionalCount, sanitizeAIInteractionMetadata, recordAIInteractionMetadata,
} = require('../backend/services/aiAuditService');

test('AI audit migration creates a relational metadata-only table', async () => {
  const statements = [];
  await migration.up({ async query(sql) { statements.push(String(sql)); return { rows: [] }; } });
  const sql = statements.join('\n').toLowerCase();
  assert.match(sql, /create table if not exists ai_interaction_audit/);
  assert.match(sql, /requester_line_id/);
  assert.match(sql, /care_profile_id/);
  assert.match(sql, /prompt_version/);
  assert.doesNotMatch(sql, /raw_prompt|raw_response|image_base64|clinical_context|jsonb/);
  assert.equal(migration.version, '0001');
});

test('AI audit migration has an explicit rollback', async () => {
  const statements = [];
  await migration.down({ async query(sql) { statements.push(String(sql)); } });
  assert.match(statements[0], /DROP TABLE IF EXISTS ai_interaction_audit/i);
});

test('audit sanitizer keeps only approved metadata and discards raw health content', () => {
  const record = sanitizeAIInteractionMetadata({
    requesterLineId: 'U123', careProfileId: 'CP-1', purpose: 'medication_summary', intent: 'retrieve',
    provider: 'gemini', model: 'gemini-test', promptVersion: AI_VERSIONS.intentClassifierPrompt,
    contextVersion: AI_VERSIONS.careProfileContext, resultStatus: 'success',
    inputCharacterCount: 42, outputCharacterCount: 18,
    rawPrompt: 'ผู้ป่วยเป็นโรค...', rawResponse: 'ข้อมูลสุขภาพ...', clinicalContext: { secret: true }, imageBase64: 'private-image',
  });
  assert.equal(record.requesterLineId, 'U123');
  assert.equal(record.inputCharacterCount, 42);
  assert.equal(Object.hasOwn(record, 'rawPrompt'), false);
  assert.equal(Object.hasOwn(record, 'rawResponse'), false);
  assert.equal(Object.hasOwn(record, 'clinicalContext'), false);
  assert.equal(Object.hasOwn(record, 'imageBase64'), false);
});

test('audit service inserts metadata fields in the expected order', async () => {
  let captured;
  const result = await recordAIInteractionMetadata({
    interactionId: 'AI-test', requesterLineId: 'U123', careProfileId: 'CP-1',
    purpose: 'medication_summary', intent: 'retrieve', provider: 'gemini', model: 'gemini-test',
    promptVersion: 'prompt-v1', contextVersion: 'context-v1', requestedAt: '2026-08-24T01:00:00.000Z',
    completedAt: '2026-08-24T01:00:01.000Z', resultStatus: 'success', escalation: false,
    providerRequestId: 'provider-request-1', inputCharacterCount: 20, outputCharacterCount: 10,
  }, { queryFn: async (sql, params) => { captured = { sql, params }; } });
  assert.deepEqual(result, { recorded: true, interactionId: 'AI-test' });
  assert.match(captured.sql, /INSERT INTO ai_interaction_audit/);
  assert.equal(captured.params.length, 27);
  assert.equal(captured.params[0], 'AI-test');
  assert.equal(captured.params[3], 'medication_summary');
  assert.equal(captured.params[11], 'success');
  assert.equal(captured.params[15], 20);
  assert.match(captured.sql, /consultation_case_id, requester_type/);
  assert.deepEqual(captured.params.slice(19), [null, null, null, null, null, null, null, false]);
});

test('optional AI usage counts preserve null versus reported zero semantics', () => {
  assert.equal(safeOptionalCount(undefined), null);
  assert.equal(safeOptionalCount(null), null);
  assert.equal(safeOptionalCount(-1), null);
  assert.equal(safeOptionalCount('not-a-count'), null);
  assert.equal(safeOptionalCount(0), 0);
  assert.equal(safeOptionalCount(42), 42);
  const missing = sanitizeAIInteractionMetadata({ purpose:'legacy', resultStatus:'success' });
  assert.equal(missing.inputTokens, null);
  assert.equal(missing.webSearchCalls, null);
  assert.equal(missing.researchPerformed, false);
});

test('AI audit persists bounded research usage and prefers provider total tokens', async () => {
  let captured;
  await recordAIInteractionMetadata({
    interactionId:'AI-research', purpose:'pharmacist_clinical_research', resultStatus:'success',
    researchPlanVersion:'p'.repeat(80), inputTokens:120, outputTokens:30, totalTokens:155,
    reasoningTokens:5, webSearchCalls:0, sourceCount:0, researchPerformed:true,
  }, { queryFn:async (sql,params)=>{ captured={sql,params}; } });
  assert.match(captured.sql, /research_plan_version, input_tokens, output_tokens, total_tokens/);
  assert.equal(captured.params[19].length, 64);
  assert.deepEqual(captured.params.slice(20), [120,30,155,5,0,0,true]);

  const derived = sanitizeAIInteractionMetadata({ inputTokens:7, outputTokens:3 });
  assert.equal(derived.totalTokens, 10);
});

test('audit insert failure is fail-open and logs no health data or secrets', async () => {
  const logs = [];
  const sensitive = 'ผู้ป่วยแพ้ยาและมีข้อมูลลับ';
  const result = await recordAIInteractionMetadata({
    interactionId: 'AI-fail', requesterLineId: 'U-secret', purpose: 'explain', resultStatus: 'error',
    rawPrompt: sensitive, rawResponse: 'secret-response', apiKey: 'secret-api-key',
  }, {
    queryFn: async () => { throw new Error(`database failed: ${sensitive}`); },
    logger: (event) => logs.push(event),
  });
  assert.equal(result.recorded, false);
  assert.equal(result.errorCode, 'AI_AUDIT_WRITE_FAILED');
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, new RegExp(sensitive));
  assert.doesNotMatch(serialized, /secret-api-key|secret-response|U-secret/);
  assert.deepEqual(logs[0], { event: 'ai_audit_insert_failed', errorCode: 'AI_AUDIT_WRITE_FAILED', interactionId: 'AI-fail' });
});

test('invalid audit values are bounded and safely normalized', () => {
  const record = sanitizeAIInteractionMetadata({
    purpose: '', resultStatus: 'unknown', requestedAt: 'not-a-date',
    inputCharacterCount: -100, outputCharacterCount: Number.MAX_SAFE_INTEGER,
    model: 'x'.repeat(500),
  });
  assert.equal(record.purpose, 'unspecified');
  assert.equal(record.resultStatus, 'error');
  assert.equal(record.inputCharacterCount, 0);
  assert.equal(record.outputCharacterCount, 10_000_000);
  assert.equal(record.model.length, 128);
  assert.match(record.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
});
