const SECRET_CENTER_FIELDS = new Set([
  'external_api_key', 'externalApiKey', 'api_key', 'apiKey',
]);

function projectCenter(center, extra = {}) {
  if (!center) return null;
  const safe = {};
  for (const [key, value] of Object.entries(center)) {
    if (!SECRET_CENTER_FIELDS.has(key)) safe[key] = value;
  }
  return { ...safe, ...extra };
}

module.exports = { projectCenter, SECRET_CENTER_FIELDS };
