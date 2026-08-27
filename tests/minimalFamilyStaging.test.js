const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.NODE_ENV = 'test';

const db = require('../backend/db');
const app = require('../backend/server');
const { createPlusRouter } = require('../backend/routes/plus');
const {
  FULL_RUNTIME_REQUIRED_ENV,
  MINIMAL_FAMILY_PLUS_REQUIRED_ENV,
  messagingConfigured,
  missingRuntimeEnvironment,
  buildPublicLiffConfig,
} = require('../backend/config/runtimeCapabilities');

const stagingBlueprint = fs.readFileSync(path.resolve(__dirname, '..', 'render.staging.yaml'), 'utf8');

function minimalEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    STAGING_MODE: 'true',
    STAGING_FAMILY_PLUS_ONLY: 'true',
    DATABASE_URL: 'postgresql://staging.invalid/phimor',
    PUBLIC_BACKEND_URL: 'https://phimor-backend-staging.onrender.com',
    LINE_LOGIN_CHANNEL_ID: 'staging-login-channel',
    LIFF_ID_FAMILY: 'staging-family-liff',
    GEMINI_API_KEY: 'staging-gemini-key',
    ...overrides,
  };
}

async function withServer(application, fn) {
  const server = http.createServer(application);
  await new Promise((resolve) => server.listen(0, resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('minimal Family Plus staging readiness excludes unrelated full-stack credentials', () => {
  assert.deepEqual(MINIMAL_FAMILY_PLUS_REQUIRED_ENV, [
    'DATABASE_URL', 'PUBLIC_BACKEND_URL', 'LINE_LOGIN_CHANNEL_ID', 'LIFF_ID_FAMILY', 'GEMINI_API_KEY',
  ]);
  assert.deepEqual(missingRuntimeEnvironment(minimalEnvironment()), []);
  for (const key of ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'LIFF_ID_CENTER_ADMIN', 'LIFF_ID_REGISTER', 'LIFF_ID_SYSTEM_ADMIN', 'ADMIN_API_KEY', 'CARE2GO_GROUP_BIND_CODE']) {
    assert.equal(MINIMAL_FAMILY_PLUS_REQUIRED_ENV.includes(key), false);
  }
});

test('production readiness retains the existing full-stack requirements', () => {
  const env = minimalEnvironment({ STAGING_MODE: 'false', STAGING_FAMILY_PLUS_ONLY: 'false' });
  const missing = missingRuntimeEnvironment(env);
  for (const key of ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'LIFF_ID_CENTER_ADMIN', 'LIFF_ID_REGISTER', 'LIFF_ID_SYSTEM_ADMIN', 'ADMIN_API_KEY']) {
    assert.equal(FULL_RUNTIME_REQUIRED_ENV.includes(key), true);
    assert.equal(missing.includes(key), true);
  }
});

test('production readiness requires Pharmacist LIFF only when consultation is enabled', () => {
  const base = Object.fromEntries(FULL_RUNTIME_REQUIRED_ENV.map((key) => [key, `${key}-configured`]));
  base.NODE_ENV = 'production';
  base.STAGING_MODE = 'false';
  base.STAGING_FAMILY_PLUS_ONLY = 'false';
  assert.equal(missingRuntimeEnvironment({ ...base, CONSULTATION_ENABLED:'false' }).includes('LIFF_ID_PHARMACIST'), false);
  assert.equal(missingRuntimeEnvironment({ ...base, CONSULTATION_ENABLED:'true' }).includes('LIFF_ID_PHARMACIST'), true);
  assert.deepEqual(missingRuntimeEnvironment({ ...base, CONSULTATION_ENABLED:'true', LIFF_ID_PHARMACIST:'pharmacist-liff' }), []);
});

test('Family LIFF public config works with only Family fields and never leaks secrets', () => {
  const config = buildPublicLiffConfig(minimalEnvironment({
    LINE_CHANNEL_ACCESS_TOKEN: 'PRIVATE-TOKEN', LINE_CHANNEL_SECRET: 'PRIVATE-SECRET', ADMIN_API_KEY: 'PRIVATE-ADMIN',
  }));
  assert.deepEqual(config, {
    publicBackendUrl: 'https://phimor-backend-staging.onrender.com',
    familyLiffId: 'staging-family-liff',
  });
  assert.doesNotMatch(JSON.stringify(config), /PRIVATE|TOKEN|SECRET|ADMIN_API_KEY|GEMINI/);
});

test('/config/liff omits missing Center, Register, System Admin and Pharmacist IDs safely', async () => {
  const keys = ['PUBLIC_BACKEND_URL', 'LIFF_ID_FAMILY', 'LIFF_ID_CENTER_ADMIN', 'LIFF_ID_REGISTER', 'LIFF_ID_SYSTEM_ADMIN', 'LIFF_ID_PHARMACIST'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.PUBLIC_BACKEND_URL = 'https://phimor-backend-staging.onrender.com';
  process.env.LIFF_ID_FAMILY = 'staging-family-liff';
  delete process.env.LIFF_ID_CENTER_ADMIN;
  delete process.env.LIFF_ID_REGISTER;
  delete process.env.LIFF_ID_SYSTEM_ADMIN;
  delete process.env.LIFF_ID_PHARMACIST;
  try {
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/config/liff`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        publicBackendUrl: process.env.PUBLIC_BACKEND_URL,
        familyLiffId: process.env.LIFF_ID_FAMILY,
      });
    });
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('missing Messaging credentials fail-close webhook without storing an event', async () => {
  const previousToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const previousSecret = process.env.LINE_CHANNEL_SECRET;
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_CHANNEL_SECRET;
  await db.resetAll();
  try {
    assert.equal(messagingConfigured(), false);
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/webhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [{ webhookEventId: 'SHOULD-NOT-BE-STORED', type: 'message' }] }),
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, 'line_messaging_unavailable');
      assert.equal((await db.WebhookInbox.findAll()).length, 0);
    });
  } finally {
    if (previousToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    else process.env.LINE_CHANNEL_ACCESS_TOKEN = previousToken;
    if (previousSecret === undefined) delete process.env.LINE_CHANNEL_SECRET;
    else process.env.LINE_CHANNEL_SECRET = previousSecret;
  }
});

test('Plus API remains available without LINE Messaging credentials', async () => {
  const previousToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const previousSecret = process.env.LINE_CHANNEL_SECRET;
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_CHANNEL_SECRET;
  const plusApp = express();
  plusApp.use(express.json());
  plusApp.use('/api/plus', createPlusRouter({
    requireAuth(req, res, next) { req.user = { lineUserId: 'U-STAGING' }; next(); },
    flags: { plus: { enabled: true, internalEntitlementOnly: true, aiExplanation: true, medicationDiff: true, pharmacistEscalation: false } },
    getPlusEntitlement: async () => ({
      allowed: true, planCode: 'family_plus', source: 'internal', status: 'active',
      startsAt: '2026-08-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', features: ['*'],
    }),
    rateLimiter: { checkAndRecord: () => ({ allowed: true, remaining: 9, retryAfterMs: 0 }) },
  }));
  try {
    await withServer(plusApp, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/plus/entitlement`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, 'active');
    });
  } finally {
    if (previousToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    else process.env.LINE_CHANNEL_ACCESS_TOKEN = previousToken;
    if (previousSecret === undefined) delete process.env.LINE_CHANNEL_SECRET;
    else process.env.LINE_CHANNEL_SECRET = previousSecret;
  }
});

test('staging Blueprint prompts only for minimal Family Plus and Pharmacist LIFF configuration', () => {
  const prompted = [...stagingBlueprint.matchAll(/- key:\s*([A-Z0-9_]+)\s*\r?\n\s*sync:\s*false/g)].map((match) => match[1]).sort();
  assert.deepEqual(prompted, ['DATABASE_URL', 'GEMINI_API_KEY', 'LIFF_ID_FAMILY', 'LIFF_ID_PHARMACIST', 'LINE_LOGIN_CHANNEL_ID']);
  assert.match(stagingBlueprint, /key:\s*STAGING_FAMILY_PLUS_ONLY\s*\r?\n\s*value:\s*"true"/);
  assert.doesNotMatch(stagingBlueprint, /key:\s*(ADMIN_API_KEY|LINE_CHANNEL_ACCESS_TOKEN|LINE_CHANNEL_SECRET|LIFF_ID_CENTER_ADMIN|LIFF_ID_REGISTER|LIFF_ID_SYSTEM_ADMIN|CARE2GO_GROUP_BIND_CODE)\s*\r?\n\s*sync:\s*false/);
});
