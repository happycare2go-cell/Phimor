const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

const { identify, insecureLineHeaderAllowed } = require('../backend/middleware/auth');
const { unsignedLineWebhookAllowed, createWebhookParser } = require('../backend/routes/webhook');
const { unsafeRuntimeConfiguration } = require('../backend/config/runtimeCapabilities');
const { createReadinessService } = require('../backend/services/readinessService');
const { safeErrorCode, logOperationalError } = require('../backend/utils/safeOperationalError');
const { findOneOrNull } = require('../backend/db');

async function withServer(application, action) {
  const server = http.createServer(application);
  await new Promise((resolve) => server.listen(0, resolve));
  try { return await action(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('production never accepts X-Line-User-Id even when insecure flag is true', async () => {
  const env = { NODE_ENV:'production', ALLOW_INSECURE_LINE_HEADER:'true' };
  assert.strictEqual(insecureLineHeaderAllowed(env), false);
  const req = { header:(name) => name === 'X-Line-User-Id' ? 'U-PRIVATE' : '' };
  const identity = await identify(req, { env, verify:async () => null });
  assert.strictEqual(identity, null);
  assert.strictEqual(insecureLineHeaderAllowed({ NODE_ENV:'development', ALLOW_INSECURE_LINE_HEADER:'true' }), true);
});

test('production webhook requires a valid LINE signature even when unsigned flag is true', async () => {
  const secret = 'test-production-signature-secret';
  const parser = createWebhookParser({
    NODE_ENV:'production', ALLOW_UNSIGNED_LINE_WEBHOOK:'true', LINE_CHANNEL_SECRET:secret,
  });
  const app = express();
  let handled = 0;
  app.post('/webhook', parser, (req, res) => { handled += 1; res.status(200).end(); });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(Number(error?.statusCode || error?.status) || 400).json({ error:'invalid_signature' });
  });
  const body = JSON.stringify({ events:[] });
  await withServer(app, async (baseUrl) => {
    const unsigned = await fetch(`${baseUrl}/webhook`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body,
    });
    assert.notStrictEqual(unsigned.status, 200);
    assert.strictEqual(handled, 0);
    const signature = crypto.createHmac('sha256', secret).update(body).digest('base64');
    const signed = await fetch(`${baseUrl}/webhook`, {
      method:'POST', headers:{ 'content-type':'application/json', 'x-line-signature':signature }, body,
    });
    assert.strictEqual(signed.status, 200);
    assert.strictEqual(handled, 1);
  });
  assert.strictEqual(unsignedLineWebhookAllowed({ NODE_ENV:'production', ALLOW_UNSIGNED_LINE_WEBHOOK:'true' }), false);
});

test('production insecure flags make readiness not-ready through safe issue codes only', async () => {
  const issues = unsafeRuntimeConfiguration({
    NODE_ENV:'production', ALLOW_INSECURE_LINE_HEADER:'true', ALLOW_UNSIGNED_LINE_WEBHOOK:'true',
    PDF_DOWNLOAD_SECRET:'configured-test-secret',
  });
  assert.deepEqual(issues, ['INSECURE_LINE_HEADER_ENABLED', 'UNSIGNED_LINE_WEBHOOK_ENABLED']);
  const service = createReadinessService({
    pingDatabase:async () => true,
    notificationHealth:async () => ({ pending:0 }),
    rateLimitHealth:async () => ({ available:true, shared:true }),
    plusPaymentHealth:async () => ({ available:true, configured:false }),
    configurationIssues:() => issues,
  });
  const result = await service.check();
  assert.strictEqual(result.ready, false);
  assert.deepEqual(result.configurationIssues, issues);
  assert.doesNotMatch(JSON.stringify(result), /ALLOW_INSECURE|ALLOW_UNSIGNED|test-production-signature-secret|credential/i);
});

test('readiness security configuration remains neutral in safe production and non-production modes', async () => {
  assert.deepEqual(unsafeRuntimeConfiguration({ NODE_ENV:'production', PDF_DOWNLOAD_SECRET:'configured' }), []);
  assert.deepEqual(unsafeRuntimeConfiguration({
    NODE_ENV:'production', ALLOW_INSECURE_LINE_HEADER:'false', ALLOW_UNSIGNED_LINE_WEBHOOK:'false',
    PDF_DOWNLOAD_SECRET:'configured',
  }), []);
  assert.deepEqual(unsafeRuntimeConfiguration({
    NODE_ENV:'test', ALLOW_INSECURE_LINE_HEADER:'true', ALLOW_UNSIGNED_LINE_WEBHOOK:'true',
  }), []);
  assert.deepEqual(unsafeRuntimeConfiguration({
    NODE_ENV:'development', ALLOW_INSECURE_LINE_HEADER:'true', ALLOW_UNSIGNED_LINE_WEBHOOK:'true',
  }), []);
  assert.strictEqual(insecureLineHeaderAllowed({ NODE_ENV:'test' }), true);
  assert.strictEqual(unsignedLineWebhookAllowed({ NODE_ENV:'test' }), true);
  assert.strictEqual(insecureLineHeaderAllowed({
    NODE_ENV:'development', ALLOW_INSECURE_LINE_HEADER:'true',
  }), true);
  assert.strictEqual(unsignedLineWebhookAllowed({
    NODE_ENV:'development', ALLOW_UNSIGNED_LINE_WEBHOOK:'true',
  }), true);
  const service = createReadinessService({
    pingDatabase:async () => true,
    notificationHealth:async () => ({ pending:0 }),
    rateLimitHealth:async () => ({ available:true, shared:true }),
    plusPaymentHealth:async () => ({ available:true, configured:false }),
    configurationIssues:() => unsafeRuntimeConfiguration({ NODE_ENV:'production', PDF_DOWNLOAD_SECRET:'configured' }),
  });
  const result = await service.check();
  assert.strictEqual(result.ready, true);
  assert.deepEqual(result.configurationIssues, []);
});

test('production operational logging emits bounded metadata without error message stack or PHI', () => {
  const calls = [];
  const error = Object.assign(new Error('patient บุคคลตัวอย่าง token=SECRET medication=Aspirin'), {
    code:'PROVIDER_FAILED', status:503,
  });
  error.stack = 'PRIVATE_STACK_WITH_CLINICAL_CONTENT';
  const payload = logOperationalError((...args) => calls.push(args), {
    event:'webhook_event_processing_failed', error, requestId:'req-safe-1',
    routeCategory:'line_webhook_worker',
  });
  assert.deepEqual(payload, {
    event:'webhook_event_processing_failed', errorCode:'PROVIDER_FAILED',
    httpStatus:503, requestId:'req-safe-1', routeCategory:'line_webhook_worker',
  });
  const serialized = JSON.stringify(calls);
  assert.doesNotMatch(serialized, /บุคคลตัวอย่าง|SECRET|Aspirin|PRIVATE_STACK|patient|token=/i);
});

test('operational error codes and fallback codes use a strict bounded alphabet', () => {
  assert.strictEqual(safeErrorCode({ code:'provider_timeout_2' }), 'PROVIDER_TIMEOUT_2');
  assert.strictEqual(safeErrorCode({ code:'contains-private text' }, 'safe_fallback'), 'SAFE_FALLBACK');
  assert.strictEqual(safeErrorCode({ code:'contains-private text' }, 'also unsafe text'), 'UNEXPECTED_ERROR');
  assert.strictEqual(safeErrorCode({ code:'A'.repeat(65) }), 'UNEXPECTED_ERROR');
});

test('findOne helper returns null consistently when no row matches', () => {
  assert.strictEqual(findOneOrNull([{ id:1 }], (row) => row.id === 2), null);
  assert.deepEqual(findOneOrNull([{ id:1 }], (row) => row.id === 1), { id:1 });
});
