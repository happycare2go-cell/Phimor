const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

process.env.NODE_ENV = 'test';

const {
  normalizeBackendUrl, requireBackendUrl, assertBackendConfig,
} = require('../liff-app/runtime-config');
const { buildRuntimeConfigSource } = require('../liff-app/scripts/write-runtime-config');

const root = path.resolve(__dirname, '..');
const familyHtml = fs.readFileSync(path.join(root, 'liff-app', 'family', 'index.html'), 'utf8');
const stagingBlueprint = fs.readFileSync(path.join(root, 'render.staging.yaml'), 'utf8');
const productionBlueprint = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');

test('runtime backend config resolves an isolated staging backend', () => {
  const url = 'https://phimor-backend-staging.onrender.com';
  assert.equal(requireBackendUrl(url), url);
  assert.equal(assertBackendConfig(url, { publicBackendUrl: url }), url);
});

test('runtime backend config resolves the configured production backend', () => {
  const url = 'https://phimor-backend.onrender.com';
  assert.equal(requireBackendUrl(`${url}/`), url);
  assert.equal(assertBackendConfig(url, { publicBackendUrl: url }), url);
});

test('missing or unsafe runtime config fails closed without a production fallback', () => {
  for (const value of [undefined, '', 'javascript:alert(1)', 'http://phimor-backend.onrender.com', 'https://user:pass@example.com']) {
    assert.throws(() => requireBackendUrl(value), (error) => error.code === 'PUBLIC_BACKEND_URL_MISSING');
  }
  assert.doesNotMatch(familyHtml, /const BACKEND_URL\s*=\s*['"]https:\/\/phimor-backend\.onrender\.com/);
  assert.match(familyHtml, /requireBackendUrl\(window\.PHIMOR_PUBLIC_BACKEND_URL\)/);
});

test('runtime URL and backend-reported URL must match', () => {
  assert.throws(
    () => assertBackendConfig('https://phimor-backend-staging.onrender.com', { publicBackendUrl: 'https://phimor-backend.onrender.com' }),
    (error) => error.code === 'BACKEND_URL_MISMATCH',
  );
});

test('deploy-time config generator emits only the validated public backend URL', () => {
  const source = buildRuntimeConfigSource('https://phimor-backend-staging.onrender.com');
  assert.match(source, /window\.PHIMOR_PUBLIC_BACKEND_URL = "https:\/\/phimor-backend-staging\.onrender\.com"/);
  assert.doesNotMatch(source, /TOKEN|SECRET|DATABASE_URL/);
});

test('/config/liff reports PUBLIC_BACKEND_URL for environment consistency checks', async () => {
  const previous = process.env.PUBLIC_BACKEND_URL;
  process.env.PUBLIC_BACKEND_URL = 'https://phimor-backend-staging.onrender.com';
  const app = require('../backend/server');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/config/liff`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).publicBackendUrl, process.env.PUBLIC_BACKEND_URL);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.PUBLIC_BACKEND_URL;
    else process.env.PUBLIC_BACKEND_URL = previous;
  }
});

test('staging blueprint has isolated branch, controlled deploy and safe Plus defaults', () => {
  assert.match(stagingBlueprint, /branch:\s*feature\/phimor-v2-foundation/g);
  assert.match(stagingBlueprint, /autoDeploy:\s*false/g);
  assert.match(stagingBlueprint, /PUBLIC_BACKEND_URL\s*\n\s*value:\s*https:\/\/phimor-backend-staging\.onrender\.com/g);
  for (const [key, value] of [
    ['PLUS_ENABLED', 'false'], ['PLUS_INTERNAL_ENTITLEMENT_ONLY', 'true'],
    ['PLUS_AI_EXPLANATION_ENABLED', 'false'], ['PLUS_MEDICATION_DIFF_ENABLED', 'false'],
    ['PLUS_PHARMACIST_ESCALATION_ENABLED', 'false'], ['PLUS_RATE_LIMIT_PER_5_MINUTES', '10'],
    ['AI_PROVIDER', 'gemini'], ['AI_TIMEOUT_MS', '15000'], ['AI_MAX_RETRIES', '1'],
  ]) {
    assert.match(stagingBlueprint, new RegExp(`key:\\s*${key}\\s*\\n\\s*value:\\s*["']?${value}["']?`));
  }
  assert.match(stagingBlueprint, /key:\s*GEMINI_API_KEY\s*\n\s*sync:\s*false/);
  assert.match(stagingBlueprint, /key:\s*DATABASE_URL\s*\n\s*sync:\s*false/);
  assert.doesNotMatch(stagingBlueprint, /databases:|phimor-db-staging|fromDatabase:/);
});

test('production blueprint generates runtime config without enabling Plus', () => {
  assert.match(productionBlueprint, /key:\s*PUBLIC_BACKEND_URL\s*\n\s*value:\s*"https:\/\/phimor-backend\.onrender\.com"/);
  assert.match(productionBlueprint, /buildCommand:\s*node scripts\/write-runtime-config\.js/);
  assert.doesNotMatch(productionBlueprint, /key:\s*PLUS_ENABLED/);
});

test('normalizer rejects path, query and hash injection', () => {
  assert.equal(normalizeBackendUrl('https://example.com/api'), null);
  assert.equal(normalizeBackendUrl('https://example.com?next=production'), null);
  assert.equal(normalizeBackendUrl('https://example.com/#token'), null);
});
