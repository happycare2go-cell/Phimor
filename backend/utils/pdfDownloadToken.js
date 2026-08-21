const crypto = require('crypto');
function secret() { return process.env.PDF_DOWNLOAD_SECRET || process.env.LINE_CHANNEL_SECRET || process.env.ADMIN_API_KEY; }
function signPdfToken(payload) {
  if (!secret()) throw new Error('PDF download secret is not configured');
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret()).update(encoded).digest('base64url');
  return encoded + '.' + signature;
}
function verifyPdfToken(token) {
  if (!token || !secret()) return null;
  const parts = String(token).split('.'); const encoded = parts[0]; const supplied = parts[1];
  if (!encoded || !supplied) return null;
  const expected = crypto.createHmac('sha256', secret()).update(encoded).digest('base64url');
  const left = Buffer.from(supplied); const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try { const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); return payload.exp > Date.now() ? payload : null; } catch (_) { return null; }
}
module.exports = { signPdfToken, verifyPdfToken };
