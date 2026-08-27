process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bearerToken, createRequireIntegration } = require('../backend/middleware/integrationAuth');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('integration bearer parser accepts only an Authorization Bearer token', () => {
  assert.equal(bearerToken({ header: () => 'Bearer pim_int_0123456789abcdef.secret' }), 'pim_int_0123456789abcdef.secret');
  assert.equal(bearerToken({ header: () => 'Basic legacy-secret' }), null);
  assert.equal(bearerToken({ header: () => '' }), null);
});

test('integration middleware fails closed when credential is absent', async () => {
  const middleware = createRequireIntegration({ tenantResolver: { resolveIntegrationCredential: async () => assert.fail('resolver must not run') } });
  const response = responseRecorder();
  let nextCalled = false;
  await middleware({ header: () => '' }, response, () => { nextCalled = true; });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.status, 'rejected');
  assert.equal(response.body.error.code, 'INVALID_CREDENTIAL');
  assert.equal(response.body.error.retryable, false);
  assert.equal(nextCalled, false);
});

test('integration middleware attaches server-resolved tenant identity', async () => {
  const identity = { integrationClientId:'IC-1', organizationId:'ORG-1', sourceSystem:'trusted_vendor' };
  const middleware = createRequireIntegration({ tenantResolver: { resolveIntegrationCredential: async () => identity } });
  const request = { header: () => 'Bearer opaque-token' };
  let nextCalled = false;
  await middleware(request, responseRecorder(), () => { nextCalled = true; });
  assert.deepEqual(request.integration, identity);
  assert.equal(nextCalled, true);
});

test('integration middleware returns a sanitized response for revoked or invalid credentials', async () => {
  const error = Object.assign(new Error('raw credential details'), { status:401, code:'INTEGRATION_CREDENTIAL_REVOKED' });
  const middleware = createRequireIntegration({ tenantResolver: { resolveIntegrationCredential: async () => { throw error; } } });
  const response = responseRecorder();
  await middleware({ header: () => 'Bearer revoked-token' }, response, () => assert.fail('next must not run'));
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error.code, 'INVALID_CREDENTIAL');
  assert.equal(response.body.error.retryable, false);
  assert.doesNotMatch(JSON.stringify(response.body), /raw credential details|revoked-token/);
});

test('integration authentication infrastructure failure is retryable and never logs credential/error detail', async () => {
  const original = console.error; const logs = []; console.error = (...args) => logs.push(args);
  try {
    const middleware = createRequireIntegration({ tenantResolver: { resolveIntegrationCredential: async () => { throw new Error('database password and bearer private-token'); } } });
    const response = responseRecorder();
    await middleware({ header: () => 'Bearer private-token' }, response, () => assert.fail('next must not run'));
    assert.equal(response.statusCode, 500); assert.equal(response.body.status, 'retrying');
    assert.equal(response.body.error.code, 'TEMPORARY_PROCESSING_UNAVAILABLE'); assert.equal(response.body.error.retryable, true);
    assert.doesNotMatch(JSON.stringify({ response:response.body, logs }), /database password|private-token/);
  } finally { console.error = original; }
});
