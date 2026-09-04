const PLUS_PAYMENT_REVERSAL_MODES = Object.freeze({
  MANUAL_REVIEW: 'manual_review',
});

function paymentEnabled(env = process.env) {
  return String(env.PLUS_PAYMENT_ENABLED || '').trim().toLowerCase() === 'true';
}

function normalizePlusPaymentReversalMode(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function getPlusPaymentReversalConfigurationIssue(env = process.env) {
  if (!paymentEnabled(env)) return null;
  const mode = normalizePlusPaymentReversalMode(env.PLUS_PAYMENT_REVERSAL_MODE);
  if (!mode) return 'PLUS_PAYMENT_REVERSAL_MODE_MISSING';
  if (!Object.values(PLUS_PAYMENT_REVERSAL_MODES).includes(mode)) {
    return 'PLUS_PAYMENT_REVERSAL_MODE_INVALID';
  }
  return null;
}

module.exports = {
  PLUS_PAYMENT_REVERSAL_MODES,
  paymentEnabled,
  normalizePlusPaymentReversalMode,
  getPlusPaymentReversalConfigurationIssue,
};
