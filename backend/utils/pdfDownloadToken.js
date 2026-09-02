const crypto = require('node:crypto');

const TOKEN_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

function configuredSecret(env = process.env) {
  const value = env.PDF_DOWNLOAD_SECRET;
  return typeof value === 'string' && value.trim() ? value : null;
}

function encryptionKey(secretValue) {
  return crypto.createHash('sha256').update(secretValue, 'utf8').digest();
}

function signPdfToken(payload, { secretValue = configuredSecret(), randomBytes = crypto.randomBytes } = {}) {
  if (!secretValue) throw Object.assign(new Error('PDF download secret is not configured'), {
    code:'PDF_DOWNLOAD_SECRET_MISSING',
  });
  const iv = randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(secretValue), iv);
  cipher.setAAD(Buffer.from(TOKEN_VERSION, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [TOKEN_VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
}

function verifyPdfToken(token, { secretValue = configuredSecret(), now = Date.now } = {}) {
  if (!token || !secretValue) return null;
  const [version, encodedIv, encodedCiphertext, encodedTag, extra] = String(token).split('.');
  if (version !== TOKEN_VERSION || !encodedIv || !encodedCiphertext || !encodedTag || extra !== undefined) return null;
  try {
    const iv = Buffer.from(encodedIv, 'base64url');
    const ciphertext = Buffer.from(encodedCiphertext, 'base64url');
    const tag = Buffer.from(encodedTag, 'base64url');
    if (iv.length !== IV_BYTES || !ciphertext.length || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(secretValue), iv);
    decipher.setAAD(Buffer.from(TOKEN_VERSION, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const payload = JSON.parse(plaintext);
    return Number(payload?.exp) > Number(now()) ? payload : null;
  } catch (_) {
    return null;
  }
}

module.exports = { signPdfToken, verifyPdfToken, configuredSecret, TOKEN_VERSION };
