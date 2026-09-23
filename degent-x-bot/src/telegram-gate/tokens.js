// Minimal HS256 JWT for the /verify link token. The token only carries the
// Telegram user id and an expiry; it is opaque to the web page, which passes
// it straight back to /gate/challenge and /gate/verify.

const crypto = require('node:crypto');

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * @param {object} claims  e.g. { tg: 12345 }
 * @param {object} opts    { secret, ttlMs, now? }
 * @returns {string} compact JWT
 */
function signLinkToken(claims, { secret, ttlMs, now = Date.now }) {
  if (!secret) throw new Error('signLinkToken: secret required');
  const issued = Math.floor(now() / 1000);
  const payload = {
    ...claims,
    iat: issued,
    exp: issued + Math.ceil(ttlMs / 1000),
    jti: crypto.randomBytes(8).toString('hex'),
  };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = hmac(secret, `${head}.${body}`);
  return `${head}.${body}.${sig}`;
}

/**
 * @returns {{ ok: true, claims: object } | { ok: false, reason: string }}
 */
function verifyLinkToken(token, { secret, now = Date.now }) {
  if (typeof token !== 'string') return { ok: false, reason: 'missing token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [head, body, sig] = parts;

  const expected = hmac(secret, `${head}.${body}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad signature' };
  }

  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed token' };
  }
  if (header.alg !== 'HS256') return { ok: false, reason: 'unsupported alg' };
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now()) {
    return { ok: false, reason: 'token expired' };
  }
  if (typeof claims.tg !== 'number' || !Number.isInteger(claims.tg) || claims.tg <= 0) {
    return { ok: false, reason: 'token has no telegram id' };
  }
  return { ok: true, claims };
}

module.exports = { signLinkToken, verifyLinkToken };
