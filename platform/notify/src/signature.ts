import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures (Stripe-style, versioned scheme):
 *
 *   Bsh-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>[,v1=<...>]
 *
 * Several `v1` entries may be present during secret rotation; a receiver accepts if any matches. Binding the
 * timestamp into the MAC lets receivers reject replays outside a tolerance window; inside the window they
 * de-duplicate on the `Idempotency-Key` header.
 */
export const SIGNATURE_HEADER = 'Bsh-Signature';
export const DEFAULT_TOLERANCE_SEC = 300;

type Body = string | Uint8Array;

const toBuf = (b: Body): Buffer => (typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b.buffer, b.byteOffset, b.byteLength));

export function computeSignature(body: Body, secret: string, timestampSec: number): string {
  return createHmac('sha256', secret).update(`${timestampSec}.`).update(toBuf(body)).digest('hex');
}

/** Header value for `body`, signed with each secret (first = current, rest = still-valid previous secrets). */
export function signWebhookPayload(body: Body, secrets: string | readonly string[], timestampSec: number): string {
  const list = typeof secrets === 'string' ? [secrets] : secrets;
  if (list.length === 0 || list.some((s) => !s)) throw new Error('webhook secret must be non-empty');
  if (!Number.isInteger(timestampSec) || timestampSec <= 0) throw new Error('timestamp must be positive unix seconds');
  return [`t=${timestampSec}`, ...list.map((s) => `v1=${computeSignature(body, s, timestampSec)}`)].join(',');
}

export type VerifyFailure = 'malformed_header' | 'no_v1_signature' | 'signature_mismatch' | 'timestamp_too_old' | 'timestamp_in_future';

export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: VerifyFailure };

export function parseSignatureHeader(header: string): { t: number; v1: string[] } | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) return null;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') {
      if (!/^\d{1,12}$/.test(v) || t !== null) return null;
      t = Number(v);
    } else if (k === 'v1') {
      if (/^[0-9a-f]{64}$/.test(v)) v1.push(v);
    } // unknown schemes (v0, v2, ...) are ignored for forward compatibility
  }
  return t === null ? null : { t, v1 };
}

/**
 * Verify a received webhook. Pass the RAW request body (bytes or the exact string received), never a
 * re-serialised JSON object. `toleranceSec` bounds both age and future skew.
 * Accepts a single secret or several (rotation). Comparison is constant-time.
 */
export function verifyWebhookSignature(
  body: Body,
  header: string | null | undefined,
  secret: string | readonly string[],
  toleranceSec: number = DEFAULT_TOLERANCE_SEC,
  nowSec: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!header) return { ok: false, reason: 'malformed_header' };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: 'malformed_header' };
  if (parsed.v1.length === 0) return { ok: false, reason: 'no_v1_signature' };
  const secrets = typeof secret === 'string' ? [secret] : secret;
  let match = false;
  for (const s of secrets) {
    if (!s) continue;
    const expected = Buffer.from(computeSignature(body, s, parsed.t), 'hex');
    for (const sig of parsed.v1) if (timingSafeEqual(expected, Buffer.from(sig, 'hex'))) match = true; // no early exit
  }
  if (!match) return { ok: false, reason: 'signature_mismatch' };
  if (parsed.t < nowSec - toleranceSec) return { ok: false, reason: 'timestamp_too_old' };
  if (parsed.t > nowSec + toleranceSec) return { ok: false, reason: 'timestamp_in_future' };
  return { ok: true, timestamp: parsed.t };
}
