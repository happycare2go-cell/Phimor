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
const { buildPublicLiffConfig } = require('../backend/config/runtimeCapabilities');

const root = path.resolve(__dirname, '..');
const familyHtml = fs.readFileSync(path.join(root, 'liff-app', 'family', 'index.html'), 'utf8');
const centerHtml = fs.readFileSync(path.join(root, 'liff-app', 'center-admin', 'index.html'), 'utf8');
const registerHtml = fs.readFileSync(path.join(root, 'liff-app', 'register', 'index.html'), 'utf8');
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

test('/config/liff reports public backend and pharmacist LIFF configuration without secrets', async () => {
  const keys = ['PUBLIC_BACKEND_URL', 'LIFF_ID_PHARMACIST', 'OMISE_SECRET_KEY', 'GEMINI_API_KEY'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.PUBLIC_BACKEND_URL = 'https://phimor-backend-staging.onrender.com';
  process.env.LIFF_ID_PHARMACIST = 'pharmacist-liff';
  process.env.OMISE_SECRET_KEY = 'secret-payment-key';
  process.env.GEMINI_API_KEY = 'secret-ai-key';
  const app = require('../backend/server');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/config/liff`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.publicBackendUrl, process.env.PUBLIC_BACKEND_URL);
    assert.equal(body.pharmacistLiffId, process.env.LIFF_ID_PHARMACIST);
    assert.doesNotMatch(JSON.stringify(body), /secret-payment|secret-ai/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('public LIFF config exposes the pharmacist ID without changing existing LIFF IDs', () => {
  const config = buildPublicLiffConfig({
    PUBLIC_BACKEND_URL: 'https://phimor-backend-staging.onrender.com',
    LIFF_ID_FAMILY: 'family-liff',
    LIFF_ID_CENTER_ADMIN: 'center-liff',
    LIFF_ID_REGISTER: 'register-liff',
    LIFF_ID_SYSTEM_ADMIN: 'system-admin-liff',
    LIFF_ID_PHARMACIST: 'pharmacist-liff',
    DATABASE_URL: 'postgresql://secret',
    GEMINI_API_KEY: 'secret-ai-key',
    OMISE_SECRET_KEY: 'secret-payment-key',
  });
  assert.deepEqual(config, {
    publicBackendUrl: 'https://phimor-backend-staging.onrender.com',
    familyLiffId: 'family-liff',
    centerAdminLiffId: 'center-liff',
    registerLiffId: 'register-liff',
    systemAdminLiffId: 'system-admin-liff',
    pharmacistLiffId: 'pharmacist-liff',
  });
  assert.doesNotMatch(JSON.stringify(config), /postgresql|secret-ai|secret-payment/);
});

test('missing pharmacist LIFF ID is omitted safely from public runtime config', () => {
  const config = buildPublicLiffConfig({
    PUBLIC_BACKEND_URL: 'https://phimor-backend-staging.onrender.com',
    LIFF_ID_FAMILY: 'family-liff',
  });
  assert.deepEqual(config, {
    publicBackendUrl: 'https://phimor-backend-staging.onrender.com',
    familyLiffId: 'family-liff',
  });
  assert.equal(config.pharmacistLiffId, undefined);
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
  assert.match(productionBlueprint, /key:\s*LIFF_ID_PHARMACIST\s*\n\s*sync:\s*false/);
  assert.match(productionBlueprint, /key:\s*CONSULTATION_REALTIME_TICKET_SECRET\s*\n\s*sync:\s*false/);
  assert.match(productionBlueprint, /key:\s*CONSULTATION_REALTIME_ALLOWED_ORIGINS\s*\n\s*value:\s*"https:\/\/phimor-liff\.onrender\.com"/);
  assert.doesNotMatch(productionBlueprint, /CONSULTATION_REALTIME_TICKET_SECRET\s*\n\s*value:/);
  assert.match(productionBlueprint, /preDeployCommand:\s*npm run migrate/);
  assert.match(productionBlueprint, /key:\s*AI_PROVIDER\s*\n\s*value:\s*["']gemini["']/);
  assert.match(productionBlueprint, /key:\s*AI_PROVIDER_CLINICAL_RESEARCH\s*\n\s*value:\s*["']openai["']/);
  assert.match(productionBlueprint, /key:\s*OPENAI_API_KEY\s*\n\s*sync:\s*false/);
  assert.match(productionBlueprint, /key:\s*PHARMACIST_AI_RESEARCH_ENABLED\s*\n\s*value:\s*["']false["']/);
  assert.match(productionBlueprint, /key:\s*PHARMACIST_AI_RESEARCH_MODE\s*\n\s*value:\s*["']disabled["']/);
  assert.match(productionBlueprint, /key:\s*PDF_DOWNLOAD_SECRET\s*\n\s*sync:\s*false/);
  assert.doesNotMatch(productionBlueprint, /key:\s*OPENAI_API_KEY\s*\n\s*value:/);
});

test('Center LIFF obtains backend and LIFF ID from the authoritative runtime projection', () => {
  assert.match(centerHtml, /<script src="\.\.\/environment\.js"><\/script>/);
  assert.match(centerHtml, /<script src="\.\.\/runtime-config\.js"><\/script>/);
  assert.match(centerHtml, /requireBackendUrl\(window\.PHIMOR_PUBLIC_BACKEND_URL\)/);
  assert.match(centerHtml, /fetch\(BACKEND_URL \+ '\/config\/liff'/);
  assert.match(centerHtml, /assertBackendConfig\(BACKEND_URL, config\)/);
  assert.match(centerHtml, /liff\.init\(\{ liffId: config\.centerAdminLiffId \}\)/);
  assert.doesNotMatch(centerHtml, /2011043561-Dyp03JGR|const BACKEND_URL\s*=\s*['"]https:\/\//);
});

test('Register LIFF obtains backend and registration LIFF ID from the authoritative runtime projection', () => {
  assert.match(registerHtml, /<script src="\.\.\/environment\.js"><\/script>/);
  assert.match(registerHtml, /<script src="\.\.\/runtime-config\.js"><\/script>/);
  assert.match(registerHtml, /requireBackendUrl\(window\.PHIMOR_PUBLIC_BACKEND_URL\)/);
  assert.match(registerHtml, /assertBackendConfig\(BACKEND_URL, config\)/);
  assert.match(registerHtml, /liff\.init\(\{ liffId: config\.registerLiffId \}\)/);
  assert.doesNotMatch(registerHtml, /const BACKEND_URL\s*=\s*['"]https:\/\//);
  assert.doesNotMatch(registerHtml, /2011043561-cC9jBw5t|YOUR_LIFF_ID/);
});

test('staging blueprint declares the pharmacist LIFF ID without a repository value', () => {
  assert.match(stagingBlueprint, /key:\s*LIFF_ID_PHARMACIST\s*\n\s*sync:\s*false/);
  assert.doesNotMatch(stagingBlueprint, /key:\s*LIFF_ID_PHARMACIST\s*\n\s*value:/);
});

test('normalizer rejects path, query and hash injection', () => {
  assert.equal(normalizeBackendUrl('https://example.com/api'), null);
  assert.equal(normalizeBackendUrl('https://example.com?next=production'), null);
  assert.equal(normalizeBackendUrl('https://example.com/#token'), null);
});
