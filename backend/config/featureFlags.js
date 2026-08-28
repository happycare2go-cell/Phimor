function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

function loadFeatureFlags(env = process.env) {
  return Object.freeze({
    plus: Object.freeze({
      enabled: parseBoolean(env.PLUS_ENABLED, false),
      internalEntitlementOnly: parseBoolean(env.PLUS_INTERNAL_ENTITLEMENT_ONLY, true),
      paymentEnabled: parseBoolean(env.PLUS_PAYMENT_ENABLED, false),
      aiExplanation: parseBoolean(env.PLUS_AI_EXPLANATION_ENABLED, false),
      medicationDiff: parseBoolean(env.PLUS_MEDICATION_DIFF_ENABLED, false),
      pharmacistEscalation: parseBoolean(env.PLUS_PHARMACIST_ESCALATION_ENABLED, false),
    }),
    consultation: Object.freeze({
      enabled: parseBoolean(env.CONSULTATION_ENABLED, false),
      internalOnly: parseBoolean(env.CONSULTATION_INTERNAL_ONLY, true),
    }),
  });
}

module.exports = { loadFeatureFlags, parseBoolean };
