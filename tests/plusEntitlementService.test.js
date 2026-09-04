const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';

const migration = require('../backend/migrations/0002_create_plus_entitlements');
const {
  getPlusEntitlement, requirePlusFeature, canUseCapability, PLUS_CAPABILITY_REGISTRY,
} = require('../backend/services/plusEntitlementService');

const NOW = new Date('2026-08-24T10:00:00.000Z');

function flags(overrides = {}) {
  return {
    plus: {
      enabled: true, internalEntitlementOnly: true,
      aiExplanation: false, medicationDiff: false, pharmacistEscalation: false,
      ...overrides,
    },
  };
}

function entitlement(overrides = {}) {
  return {
    entitlement_id: 'PLUS-1', subject_type: 'line_user', subject_id: 'U-1', plan_code: 'family_plus',
    status: 'active', starts_at: '2026-08-01T00:00:00.000Z', expires_at: '2026-09-01T00:00:00.000Z',
    source: 'internal', features: ['care_profile_summary', 'medication_summary'], ...overrides,
  };
}

function queryRows(rows, observer = null) {
  return async (sql, params) => {
    observer?.(sql, params);
    return { rows };
  };
}

test('Plus migration creates relational entitlement columns and indexes', async () => {
  const statements = [];
  await migration.up({ async query(sql) { statements.push(String(sql)); return { rows: [] }; } });
  const sql = statements.join('\n').toLowerCase();
  assert.match(sql, /create table if not exists plus_entitlements/);
  for (const column of ['entitlement_id', 'subject_type', 'subject_id', 'plan_code', 'status', 'starts_at', 'expires_at', 'source', 'features', 'created_by', 'note']) {
    assert.match(sql, new RegExp(column));
  }
  assert.equal(migration.version, '0002');
});

test('no entitlement record means free Family Basic', async () => {
  const result = await getPlusEntitlement({ lineUserId: 'U-1', at: NOW, flags: flags(), queryFn: queryRows([]) });
  assert.deepEqual(result, { planCode: 'family_basic', plus: false, allowed: false, reasonCode: 'NO_PLUS_ENTITLEMENT', features: [] });
});

test('active internal entitlement permits an included feature', async () => {
  const result = await requirePlusFeature({
    lineUserId: 'U-1', feature: 'care_profile_summary', at: NOW, flags: flags(), queryFn: queryRows([entitlement()]),
  });
  assert.equal(result.allowed, true);
  assert.equal(result.planCode, 'family_plus');
  assert.equal(result.source, 'internal');
});

test('expired entitlement is denied', async () => {
  await assert.rejects(requirePlusFeature({
    lineUserId: 'U-1', feature: 'care_profile_summary', at: NOW, flags: flags(),
    queryFn: queryRows([entitlement({ expires_at: '2026-08-24T09:59:59.000Z' })]),
  }), (error) => error.code === 'ENTITLEMENT_EXPIRED');
});

test('explicit expired status is denied', async () => {
  const result = await getPlusEntitlement({ lineUserId: 'U-1', at: NOW, flags: flags(), queryFn: queryRows([entitlement({ status: 'expired' })]) });
  assert.equal(result.reasonCode, 'ENTITLEMENT_EXPIRED');
});

test('suspended entitlement is denied', async () => {
  await assert.rejects(requirePlusFeature({
    lineUserId: 'U-1', feature: 'care_profile_summary', at: NOW, flags: flags(), queryFn: queryRows([entitlement({ status: 'suspended' })]),
  }), (error) => error.code === 'ENTITLEMENT_SUSPENDED');
});

test('future start is denied', async () => {
  await assert.rejects(requirePlusFeature({
    lineUserId: 'U-1', feature: 'care_profile_summary', at: NOW, flags: flags(),
    queryFn: queryRows([entitlement({ starts_at: '2026-08-25T00:00:00.000Z' })]),
  }), (error) => error.code === 'ENTITLEMENT_NOT_STARTED');
});

test('PLUS_ENABLED off denies without querying entitlement data', async () => {
  let calls = 0;
  await assert.rejects(requirePlusFeature({
    lineUserId: 'U-1', feature: 'care_profile_summary', at: NOW, flags: flags({ enabled: false }),
    queryFn: async () => { calls += 1; return { rows: [entitlement()] }; },
  }), (error) => error.code === 'PLUS_DISABLED');
  assert.equal(calls, 0);
});

test('internal-only mode rejects promotion/payment entitlement', async () => {
  await assert.rejects(requirePlusFeature({
    lineUserId: 'U-1', feature: 'care_profile_summary', at: NOW, flags: flags({ internalEntitlementOnly: true }),
    queryFn: queryRows([entitlement({ source: 'promotion' })]),
  }), (error) => error.code === 'INTERNAL_ENTITLEMENT_REQUIRED');
});

test('non-internal entitlement is usable when internal-only mode is disabled', async () => {
  const result = await requirePlusFeature({
    lineUserId: 'U-1', feature: 'care_profile_summary', at: NOW, flags: flags({ internalEntitlementOnly: false }),
    queryFn: queryRows([entitlement({ source: 'promotion' })]),
  });
  assert.equal(result.allowed, true);
});

test('entitlement must include the requested feature', async () => {
  await assert.rejects(requirePlusFeature({
    lineUserId: 'U-1', feature: 'appointment_summary', at: NOW, flags: flags(), queryFn: queryRows([entitlement()]),
  }), (error) => error.code === 'PLUS_FEATURE_NOT_INCLUDED');
});

test('feature-specific server flag remains authoritative', async () => {
  await assert.rejects(requirePlusFeature({
    lineUserId: 'U-1', feature: 'ai_explanation', at: NOW, flags: flags({ aiExplanation: false }),
    queryFn: queryRows([entitlement({ features: ['*'] })]),
  }), (error) => error.code === 'PLUS_FEATURE_DISABLED');
});

test('query is parameterized by authenticated LINE user', async () => {
  let captured;
  await getPlusEntitlement({
    lineUserId: 'U-parameter', at: NOW, flags: flags(), queryFn: queryRows([], (sql, params) => { captured = { sql, params }; }),
  });
  assert.match(captured.sql, /subject_id = \$1/);
  assert.deepEqual(captured.params, ['U-parameter']);
});

test('entitlement database failure denies safely without exposing database error', async () => {
  const log=[];
  await assert.rejects(requirePlusFeature({
    lineUserId: 'U-1', feature: 'care_profile_summary', at: NOW, flags: flags(),
    queryFn: async () => { throw new Error('secret database connection details'); },
    operationalLogger:(...items)=>log.push(items.join(' ')),
  }), (error) => error.code === 'ENTITLEMENT_UNAVAILABLE' && !error.message.includes('database'));
  assert.equal(log.length,1);
  assert.match(log[0],/plus_entitlement_lookup_failed/);
  assert.match(log[0],/PLUS_ENTITLEMENT_LOOKUP_FAILED/);
  assert.doesNotMatch(log[0],/U-1|secret database|connection details|subject_id|care.profile/i);
});

test('central capability registry exposes only implemented Plus intelligence', async () => {
  assert.equal(PLUS_CAPABILITY_REGISTRY.ai_lab_explanation.status, 'LIVE');
  assert.equal(PLUS_CAPABILITY_REGISTRY.doctor_question_prep.status, 'LIVE');
  assert.equal(PLUS_CAPABILITY_REGISTRY.doctor_visit_organization.status, 'LIVE');
  assert.equal(PLUS_CAPABILITY_REGISTRY.monthly_health_summary.status, 'FUTURE');
  const decision = await canUseCapability({
    lineUserId: 'U-1', capability: 'ai_lab_explanation', at: NOW, flags: flags({ internalEntitlementOnly: false, aiExplanation: true }),
    queryFn: queryRows([entitlement({ source: 'payment', features: ['ai_explanation'] })]),
  });
  assert.equal(decision.allowed, true);
});

test('future Plus capability is denied without querying clinical or entitlement data', async () => {
  let calls = 0;
  const decision = await canUseCapability({
    lineUserId: 'U-1', capability: 'smart_reminders', flags: flags(),
    queryFn: async () => { calls += 1; return { rows: [] }; },
  });
  assert.equal(decision.allowed, false); assert.equal(decision.reasonCode, 'PLUS_CAPABILITY_NOT_AVAILABLE'); assert.equal(calls, 0);
});
