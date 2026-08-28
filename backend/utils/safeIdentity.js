function cleanText(value, limit = 160) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function maskedLineReference(lineUserId) {
  const value = cleanText(lineUserId, 256);
  if (!value) return 'บัญชี LINE ที่ยืนยันแล้ว';
  const compact = value.replace(/[^A-Za-z0-9]/g, '');
  const suffix = compact.slice(-4) || '••••';
  return `บัญชี LINE ••••${suffix}`;
}

function displayIdentity({ displayName, lineUserId, fallbackLabel } = {}) {
  return cleanText(displayName) || cleanText(fallbackLabel) || maskedLineReference(lineUserId);
}

function maskedInternalReference(value, label = 'รายการ') {
  const compact = cleanText(value, 256).replace(/[^A-Za-z0-9]/g, '');
  if (!compact) return `${label}ที่ยืนยันแล้ว`;
  return `${label} ••••${compact.slice(-6)}`;
}

module.exports = { cleanText, maskedLineReference, displayIdentity, maskedInternalReference };
