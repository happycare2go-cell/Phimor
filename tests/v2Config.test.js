const { test } = require('node:test');
const assert = require('node:assert');
const { loadV2Config, DEFAULT_AI_TIMEOUT_MS } = require('../backend/config/v2Config');
const { loadFeatureFlags } = require('../backend/config/featureFlags');

test('V2 Plus flags default safely and internal entitlement defaults true', () => {
  const flags = loadFeatureFlags({});
  assert.deepStrictEqual(flags.plus, {
    enabled: false,
    internalEntitlementOnly: true,
    paymentEnabled: false,
    aiExplanation: false,
    medicationDiff: false,
    pharmacistEscalation: false,
  });
});

test('V2 feature flags parse explicit true and false values', () => {
  const flags = loadFeatureFlags({
    PLUS_ENABLED: ' true ', PLUS_INTERNAL_ENTITLEMENT_ONLY: 'false',
    PLUS_PAYMENT_ENABLED: 'true', PLUS_AI_EXPLANATION_ENABLED: 'TRUE', PLUS_MEDICATION_DIFF_ENABLED: 'false',
    PLUS_PHARMACIST_ESCALATION_ENABLED: 'true',
  });
  assert.strictEqual(flags.plus.enabled, true);
  assert.strictEqual(flags.plus.internalEntitlementOnly, false);
  assert.strictEqual(flags.plus.paymentEnabled, true);
  assert.strictEqual(flags.plus.aiExplanation, true);
  assert.strictEqual(flags.plus.medicationDiff, false);
  assert.strictEqual(flags.plus.pharmacistEscalation, true);
});

test('invalid feature flag values fall back to safe defaults', () => {
  const flags = loadFeatureFlags({
    PLUS_ENABLED: 'yes', PLUS_INTERNAL_ENTITLEMENT_ONLY: 'no',
    PLUS_AI_EXPLANATION_ENABLED: '1', PLUS_MEDICATION_DIFF_ENABLED: '',
  });
  assert.strictEqual(flags.plus.enabled, false);
  assert.strictEqual(flags.plus.internalEntitlementOnly, true);
  assert.strictEqual(flags.plus.aiExplanation, false);
  assert.strictEqual(flags.plus.medicationDiff, false);
});

test('AI configuration parses bounded numeric timeout and retries', () => {
  const config = loadV2Config({ AI_TIMEOUT_MS: '25000', AI_MAX_RETRIES: '3' });
  assert.strictEqual(config.ai.timeoutMs, 25000);
  assert.strictEqual(config.ai.maxRetries, 3);
});

test('invalid AI numeric configuration uses safe defaults', () => {
  const config = loadV2Config({ AI_TIMEOUT_MS: '-1', AI_MAX_RETRIES: '99' });
  assert.strictEqual(config.ai.timeoutMs, DEFAULT_AI_TIMEOUT_MS);
  assert.strictEqual(config.ai.maxRetries, 1);
});

test('missing optional V2 environment preserves existing behavior defaults', () => {
  const config = loadV2Config({});
  assert.strictEqual(config.ai.provider, 'gemini');
  assert.strictEqual(config.ai.documentModel, '');
  assert.strictEqual(config.ai.explanationModel, '');
});

test('config loaders do not log environment values or secrets', () => {
  const calls = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => calls.push(args);
  console.error = (...args) => calls.push(args);
  try {
    loadV2Config({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'must-not-be-logged' });
    loadFeatureFlags({ PLUS_ENABLED: 'false', ADMIN_API_KEY: 'must-not-be-logged' });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.strictEqual(calls.length, 0);
});
