/**
 * The one-time /verify link token. It carries only the Telegram user id, an expiry and a random id (jti),
 * authenticated with HMAC-SHA256 under GATE_LINK_SECRET. The web page treats it as opaque and passes it back.
 *
 * Wire form: base64url( version(1) || tg(8, uint64 BE) || exp(4, uint32 BE, unix seconds) || jti(8) || mac(16) ),
 * 50 characters of [A-Za-z0-9_-] — the shape the /verify page accepts (`readGateToken`: 8..128 of that alphabet).
 * No dots, no JSON, no algorithm field to confuse: there is exactly one format and one MAC.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const LINK_TOKEN_VERSION = 1;
const BODY_LEN = 1 + 8 + 4 + 8;
const MAC_LEN = 16;
export const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

export interface LinkClaims {
  tg: number;
  /** Expiry, unix seconds. */
  exp: number;
  /** Random id (hex), used to make the link single-use. */
  jti: string;
}

export type LinkTokenResult = { ok: true; claims: LinkClaims } | { ok: false; reason: 'malformed' | 'bad_mac' | 'expired' | 'bad_telegram_id' };

function mac(secret: string, body: Buffer): Buffer {
  return createHmac('sha256', secret).update(body).digest().subarray(0, MAC_LEN);
}

export function isTelegramUserId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

export function signLinkToken(tg: number, opts: { secret: string; ttlSeconds: number; now: number; jti?: Buffer }): string {
  if (!opts.secret) throw new Error('signLinkToken: secret required');
  if (!isTelegramUserId(tg)) throw new Error('signLinkToken: telegram user id must be a positive safe integer');
  const body = Buffer.alloc(BODY_LEN);
  body.writeUInt8(LINK_TOKEN_VERSION, 0);
  body.writeBigUInt64BE(BigInt(tg), 1);
  body.writeUInt32BE(Math.floor(opts.now / 1000) + Math.ceil(opts.ttlSeconds), 9);
  (opts.jti ?? randomBytes(8)).copy(body, 13, 0, 8);
  return Buffer.concat([body, mac(opts.secret, body)]).toString('base64url');
}

export function verifyLinkToken(token: unknown, opts: { secret: string; now: number }): LinkTokenResult {
  if (typeof token !== 'string' || !LINK_TOKEN_RE.test(token)) return { ok: false, reason: 'malformed' };
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== BODY_LEN + MAC_LEN || raw.toString('base64url') !== token) return { ok: false, reason: 'malformed' };
  const body = raw.subarray(0, BODY_LEN);
  const given = raw.subarray(BODY_LEN);
  if (!timingSafeEqual(given, mac(opts.secret, body))) return { ok: false, reason: 'bad_mac' };
  if (body.readUInt8(0) !== LINK_TOKEN_VERSION) return { ok: false, reason: 'malformed' };
  const tgBig = body.readBigUInt64BE(1);
  const tg = Number(tgBig);
  if (tgBig > BigInt(Number.MAX_SAFE_INTEGER) || !isTelegramUserId(tg)) return { ok: false, reason: 'bad_telegram_id' };
  const exp = body.readUInt32BE(9);
  if (exp * 1000 <= opts.now) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { tg, exp, jti: body.subarray(13, 21).toString('hex') } };
}
