const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_LINE_HEADER = 'true';
process.env.LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || 'test-line-token';
process.env.LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || 'test-line-secret';
process.env.LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID || 'test-line-login-channel';
process.env.PDF_DOWNLOAD_SECRET = process.env.PDF_DOWNLOAD_SECRET || 'test-pdf-download-secret';

const { signPdfToken, verifyPdfToken } = require('../backend/utils/pdfDownloadToken');
const {
  verifyLineIdToken, lineVerifyTimeoutMs, DEFAULT_LINE_VERIFY_TIMEOUT_MS,
} = require('../backend/middleware/auth');
const { unsafeRuntimeConfiguration } = require('../backend/config/runtimeCapabilities');
const db = require('../backend/db');
const familyService = require('../backend/services/familyService');
const app = require('../backend/server');

function mutateSegment(token, index) {
  const parts = token.split('.');
  const bytes = Buffer.from(parts[index], 'base64url');
  bytes[0] ^= 0x01;
  parts[index] = bytes.toString('base64url');
  return parts.join('.');
}

test('PDF token encrypts authenticated confidential payload and rejects tampering, wrong secret, and expiry', () => {
  const secretValue = 'dedicated-pdf-secret';
  const payload = {
    careProfileId:'CP-PRIVATE-1', lineUserId:'U-PRIVATE-1', fromDate:'2026-09-01', toDate:null,
    exp:Date.now() + 60_000,
  };
  const token = signPdfToken(payload, { secretValue });
  assert.deepEqual(verifyPdfToken(token, { secretValue }), payload);
  assert.equal(token.split('.')[0], 'v1');
  for (const segment of token.split('.').slice(1)) {
    assert.doesNotMatch(Buffer.from(segment, 'base64url').toString('utf8'), /CP-PRIVATE-1|U-PRIVATE-1|2026-09-01/);
  }
  assert.equal(verifyPdfToken(mutateSegment(token, 2), { secretValue }), null);
  assert.equal(verifyPdfToken(mutateSegment(token, 3), { secretValue }), null);
  assert.equal(verifyPdfToken(token, { secretValue:'wrong-dedicated-secret' }), null);
  assert.equal(verifyPdfToken(token, { secretValue, now:() => payload.exp + 1 }), null);
});

test('PDF token never falls back to unrelated application secrets', () => {
  const prior = {
    pdf:process.env.PDF_DOWNLOAD_SECRET,
    line:process.env.LINE_CHANNEL_SECRET,
    admin:process.env.ADMIN_API_KEY,
  };
  delete process.env.PDF_DOWNLOAD_SECRET;
  process.env.LINE_CHANNEL_SECRET = 'must-not-be-used';
  process.env.ADMIN_API_KEY = 'must-not-be-used-either';
  try {
    assert.throws(() => signPdfToken({ exp:Date.now() + 1000 }), (error) => error.code === 'PDF_DOWNLOAD_SECRET_MISSING');
    assert.equal(verifyPdfToken('v1.any.cipher.tag'), null);
  } finally {
    if (prior.pdf === undefined) delete process.env.PDF_DOWNLOAD_SECRET; else process.env.PDF_DOWNLOAD_SECRET = prior.pdf;
    if (prior.line === undefined) delete process.env.LINE_CHANNEL_SECRET; else process.env.LINE_CHANNEL_SECRET = prior.line;
    if (prior.admin === undefined) delete process.env.ADMIN_API_KEY; else process.env.ADMIN_API_KEY = prior.admin;
  }
});

test('production readiness reports only a safe PDF-secret issue code', () => {
  const issues = unsafeRuntimeConfiguration({ NODE_ENV:'production' });
  assert.deepEqual(issues, ['PDF_DOWNLOAD_SECRET_MISSING']);
  assert.doesNotMatch(JSON.stringify(issues), /LINE_CHANNEL_SECRET|ADMIN_API_KEY|secret-value/i);
});

test('LINE ID-token verification preserves normal and failure semantics with cleanup', async () => {
  let cancellations = 0;
  const timer = { unref() {} };
  const common = {
    clientId:'line-client', schedule:() => timer, cancel:(value) => {
      assert.equal(value, timer); cancellations += 1;
    },
  };
  const valid = await verifyLineIdToken('valid-token', {
    ...common, fetchImpl:async (url, options) => {
      assert.match(String(url), /line\.me\/oauth2\/v2\.1\/verify/);
      assert.equal(options.signal.aborted, false);
      return new Response(JSON.stringify({ sub:'U-VALID', aud:'line-client' }), { status:200 });
    },
  });
  assert.equal(valid.lineUserId, 'U-VALID');
  assert.equal(await verifyLineIdToken('bad-token', {
    ...common, fetchImpl:async () => new Response('{}', { status:401 }),
  }), null);
  assert.equal(await verifyLineIdToken('bad-json', {
    ...common, fetchImpl:async () => new Response('{', { status:200 }),
  }), null);
  assert.equal(await verifyLineIdToken('network-failure', {
    ...common, fetchImpl:async () => { throw new Error('private provider response'); },
  }), null);
  assert.equal(cancellations, 4);
});

test('LINE ID-token verification times out safely and cancels its timer', async () => {
  let fireTimeout;
  let cancellationCount = 0;
  let signal;
  const resultPromise = verifyLineIdToken('hanging-token', {
    clientId:'line-client', timeoutMs:250,
    schedule:(callback) => { fireTimeout = callback; return { unref() {} }; },
    cancel:() => { cancellationCount += 1; },
    fetchImpl:async (url, options) => {
      signal = options.signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name:'AbortError' })));
      });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, false);
  fireTimeout();
  assert.equal(await resultPromise, null);
  assert.equal(signal.aborted, true);
  assert.equal(cancellationCount, 1);
  assert.equal(lineVerifyTimeoutMs({ LINE_VERIFY_TIMEOUT_MS:'not-a-number' }), DEFAULT_LINE_VERIFY_TIMEOUT_MS);
  assert.equal(lineVerifyTimeoutMs({ LINE_VERIFY_TIMEOUT_MS:'750' }), 750);
});

async function withBackend(action) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await action(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('route-aware JSON parser bounds ordinary routes and grants the larger limit only to exact image routes', async () => {
  assert.equal(app.usesLargeJsonBody({ method:'POST', path:'/api/care-profile/CP-1/medications/image-proposal' }), true);
  assert.equal(app.usesLargeJsonBody({ method:'POST', path:'/api/care-profile/CP-1/medications/image-proposal/extra' }), false);
  assert.equal(app.usesLargeJsonBody({ method:'GET', path:'/api/care-profile/CP-1/medications/image-proposal' }), false);
  await withBackend(async (baseUrl) => {
    const headers = { 'content-type':'application/json', 'x-line-user-id':'U-TEST' };
    const oversizedOrdinary = await fetch(`${baseUrl}/api/consent`, {
      method:'POST', headers, body:JSON.stringify({ accepted:true, padding:'x'.repeat(300 * 1024) }),
    });
    assert.equal(oversizedOrdinary.status, 413);
    assert.equal((await oversizedOrdinary.json()).error, 'payload_too_large');

    const acceptedByLargeParser = await fetch(`${baseUrl}/api/care-profile/CP-MISSING/medications/image-proposal`, {
      method:'POST', headers, body:JSON.stringify({ imageBase64:'x'.repeat(300 * 1024), imageMimeType:'image/jpeg' }),
    });
    assert.notEqual(acceptedByLargeParser.status, 413);

    const oversizedImage = await fetch(`${baseUrl}/api/care-profile/CP-MISSING/medications/image-proposal`, {
      method:'POST', headers, body:JSON.stringify({ imageBase64:'x'.repeat(10 * 1024 * 1024 + 1024), imageMimeType:'image/jpeg' }),
    });
    assert.equal(oversizedImage.status, 413);
  });
});

test('PDF download rechecks Family authorization after token issuance', async () => {
  db.resetAll();
  const profile = await familyService.createIndependentProfile({
    ownerLineId:'U-ORIGINAL-OWNER', patientName:'บุคคลทดสอบ',
  });
  const token = signPdfToken({
    careProfileId:profile.care_profile_id, lineUserId:'U-ORIGINAL-OWNER',
    fromDate:null, toDate:null, exp:Date.now() + 60_000,
  });
  await db.CareProfiles.update(
    (item) => item.care_profile_id === profile.care_profile_id,
    { owner_line_id:'U-NEW-OWNER' },
  );
  await withBackend(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/export/pdf/download?token=${encodeURIComponent(token)}`);
    assert.equal(response.status, 403);
  });
});
