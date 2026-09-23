/**
 * Sign in with Bitcoin (SIWB): an EIP-4361-style challenge adapted to Bitcoin, verified with
 * BIP-322 simple signatures (P2TR key path, P2WPKH) or legacy signmessage (P2PKH, P2WPKH,
 * P2SH-P2WPKH).
 *
 *   example.com wants you to sign in with your Bitcoin account:
 *   bc1q...
 *
 *   Sign in to Blockspace ID.
 *
 *   URI: https://example.com
 *   Version: 1
 *   Network: mainnet
 *   Nonce: 3f9c...
 *   Issued At: 2026-09-23T12:00:00.000Z
 *   Expiration Time: 2026-09-23T12:05:00.000Z
 *
 * The message grammar is strict and canonical: `parseSiwbMessage` re-serialises the parsed fields
 * and rejects anything that does not round-trip byte-for-byte.
 */
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { decodeAddress, type DecodedAddress } from './address.js';
import { verifyBip322SimpleDecoded } from './bip322.js';
import { decodeBase64 } from './bytes.js';
import { isLegacySignature, verifyLegacyDecoded } from './legacy.js';
import { isBitcoinNetwork, type BitcoinNetwork } from './network.js';
import type { NonceStore } from './nonce.js';

export const SIWB_VERSION = '1';
export const MAX_TTL_SECONDS = 3600;
const HEADER_SUFFIX = ' wants you to sign in with your Bitcoin account:';

export interface SiwbFields {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: typeof SIWB_VERSION;
  network: BitcoinNetwork;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

export interface CreateChallengeParams {
  domain: string;
  address: string;
  network: BitcoinNetwork;
  /** Server-generated if omitted (128 bits, hex). Supplying your own is for tests / deterministic flows. */
  nonce?: string;
  ttlSeconds: number;
  statement?: string;
  /** Defaults to `https://<domain>`. Its host must equal `domain`. */
  uri?: string;
  requestId?: string;
  resources?: string[];
  notBefore?: Date;
  now?: Date | number;
}

export interface SiwbChallenge {
  message: string;
  fields: SiwbFields;
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;
const NONCE_RE = /^[A-Za-z0-9]{16,64}$/;
const REQUEST_ID_RE = /^[\x21-\x7e]{1,128}$/;
// Printable, single line; no control characters (so the grammar cannot be smuggled).
const STATEMENT_RE = /^[^\x00-\x1f\x7f]{1,280}$/u;

export class SiwbError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SiwbError';
  }
}

const toMs = (t: Date | number | undefined): number => (t === undefined ? Date.now() : typeof t === 'number' ? t : t.getTime());

function isCanonicalIso(s: string): boolean {
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString() === s;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function validateFields(f: SiwbFields): void {
  if (f.domain.length > 259 || !DOMAIN_RE.test(f.domain)) throw new SiwbError('invalid_domain', 'domain must be a lower-case host[:port]');
  if (!STATEMENT_RE.test(f.statement)) throw new SiwbError('invalid_statement', 'statement must be one printable line (1-280 chars)');
  let url: URL;
  try {
    url = new URL(f.uri);
  } catch {
    throw new SiwbError('invalid_uri', 'uri is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
    throw new SiwbError('invalid_uri', 'uri must be https (http only for loopback)');
  if (url.host !== f.domain) throw new SiwbError('invalid_uri', 'uri host must equal domain');
  if (/\s/.test(f.uri)) throw new SiwbError('invalid_uri', 'uri must not contain whitespace');
  if (f.version !== SIWB_VERSION) throw new SiwbError('invalid_version', 'unsupported version');
  if (!isBitcoinNetwork(f.network)) throw new SiwbError('invalid_network', 'unknown network');
  if (!NONCE_RE.test(f.nonce)) throw new SiwbError('invalid_nonce', 'nonce must be 16-64 alphanumerics');
  for (const [k, v] of [['issuedAt', f.issuedAt], ['expirationTime', f.expirationTime], ['notBefore', f.notBefore]] as const)
    if (v !== undefined && !isCanonicalIso(v)) throw new SiwbError('invalid_time', `${k} must be a canonical ISO-8601 UTC timestamp`);
  if (Date.parse(f.expirationTime) <= Date.parse(f.issuedAt)) throw new SiwbError('invalid_time', 'expirationTime must follow issuedAt');
  if (f.requestId !== undefined && !REQUEST_ID_RE.test(f.requestId)) throw new SiwbError('invalid_request_id', 'invalid requestId');
  for (const r of f.resources ?? []) {
    try {
      new URL(r);
    } catch {
      throw new SiwbError('invalid_resource', 'resources must be URIs');
    }
    if (/\s/.test(r)) throw new SiwbError('invalid_resource', 'resources must not contain whitespace');
  }
  try {
    decodeAddress(f.address, f.network);
  } catch (e) {
    throw new SiwbError('invalid_address', (e as Error).message);
  }
}

/** Serialise fields into the exact text the wallet signs. */
export function formatSiwbMessage(f: SiwbFields): string {
  const lines = [
    `${f.domain}${HEADER_SUFFIX}`,
    f.address,
    '',
    f.statement,
    '',
    `URI: ${f.uri}`,
    `Version: ${f.version}`,
    `Network: ${f.network}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expirationTime}`,
  ];
  if (f.notBefore !== undefined) lines.push(`Not Before: ${f.notBefore}`);
  if (f.requestId !== undefined) lines.push(`Request ID: ${f.requestId}`);
  if (f.resources && f.resources.length > 0) {
    lines.push('Resources:');
    for (const r of f.resources) lines.push(`- ${r}`);
  }
  return lines.join('\n');
}

/** Strictly parse a SIWB message. Throws SiwbError('malformed_message' | field code). */
export function parseSiwbMessage(message: string): SiwbFields {
  if (typeof message !== 'string' || message.length > 4096) throw new SiwbError('malformed_message', 'message too long');
  const lines = message.split('\n');
  const bad = (why: string): never => {
    throw new SiwbError('malformed_message', why);
  };
  let i = 0;
  const next = (): string => lines[i++] ?? bad('unexpected end of message');
  const tagged = (label: string): string => {
    const l = next();
    if (!l.startsWith(`${label}: `)) bad(`expected "${label}:"`);
    return l.slice(label.length + 2);
  };
  const header = next();
  if (!header.endsWith(HEADER_SUFFIX)) bad('bad header line');
  const domain = header.slice(0, -HEADER_SUFFIX.length);
  const address = next();
  if (next() !== '') bad('expected blank line after address');
  const statement = next();
  if (next() !== '') bad('expected blank line after statement');
  const uri = tagged('URI');
  const version = tagged('Version');
  const network = tagged('Network');
  const nonce = tagged('Nonce');
  const issuedAt = tagged('Issued At');
  const expirationTime = tagged('Expiration Time');
  const f: SiwbFields = {
    domain,
    address,
    statement,
    uri,
    version: version as typeof SIWB_VERSION,
    network: network as BitcoinNetwork,
    nonce,
    issuedAt,
    expirationTime,
  };
  if (lines[i]?.startsWith('Not Before: ')) f.notBefore = tagged('Not Before');
  if (lines[i]?.startsWith('Request ID: ')) f.requestId = tagged('Request ID');
  if (lines[i] === 'Resources:') {
    i++;
    f.resources = [];
    while (i < lines.length && lines[i]!.startsWith('- ')) f.resources.push(next().slice(2));
    if (f.resources.length === 0) bad('empty Resources list');
  }
  if (i !== lines.length) bad('unexpected trailing content');
  validateFields(f);
  if (formatSiwbMessage(f) !== message) bad('message is not canonical');
  return f;
}

export function generateNonce(): string {
  return bytesToHex(randomBytes(16));
}

/** Build a challenge (pure). Use `issueChallenge` to also register the nonce. */
export function createChallenge(p: CreateChallengeParams): SiwbChallenge {
  if (!Number.isInteger(p.ttlSeconds) || p.ttlSeconds < 1 || p.ttlSeconds > MAX_TTL_SECONDS)
    throw new SiwbError('invalid_ttl', `ttlSeconds must be an integer in [1, ${MAX_TTL_SECONDS}]`);
  const now = toMs(p.now);
  const fields: SiwbFields = {
    domain: p.domain,
    address: p.address,
    statement: p.statement ?? 'Sign in with your Bitcoin wallet. This request will not trigger a transaction or cost any fees.',
    uri: p.uri ?? `https://${p.domain}`,
    version: SIWB_VERSION,
    network: p.network,
    nonce: p.nonce ?? generateNonce(),
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(now + p.ttlSeconds * 1000).toISOString(),
  };
  if (p.notBefore) fields.notBefore = p.notBefore.toISOString();
  if (p.requestId !== undefined) fields.requestId = p.requestId;
  if (p.resources && p.resources.length > 0) fields.resources = [...p.resources];
  validateFields(fields);
  return { message: formatSiwbMessage(fields), fields };
}

/** Create a challenge and register its nonce (bound to domain + address) in the store. */
export async function issueChallenge(store: NonceStore, p: CreateChallengeParams): Promise<SiwbChallenge> {
  const ch = createChallenge(p);
  await store.issue({
    nonce: ch.fields.nonce,
    expiresAt: Date.parse(ch.fields.expirationTime),
    domain: ch.fields.domain,
    address: ch.fields.address,
  });
  return ch;
}

export interface VerifySignInInput {
  message: string;
  /** base64: BIP-322 simple witness, or a 65-byte legacy signmessage signature. */
  signature: string;
  /** The address the client claims; must equal the message's address. */
  address: string;
}

export interface VerifySignInOptions {
  /** Domain(s) this server accepts sign-ins for (exact match, lower-case host[:port]). */
  domain: string | readonly string[];
  /** Replay protection is mandatory: the nonce must have been issued by this store. */
  nonces: NonceStore;
  /** Expected network; defaults to accepting what the message says. */
  network?: BitcoinNetwork;
  now?: Date | number;
  /** Tolerated clock skew for issuedAt / notBefore (default 60s). Expiry gets no leeway. */
  clockSkewSeconds?: number;
  /** Accept legacy signmessage signatures (default true). */
  allowLegacy?: boolean;
}

export type SignInErrorCode =
  | 'malformed_message'
  | 'domain_mismatch'
  | 'address_mismatch'
  | 'network_mismatch'
  | 'invalid_address'
  | 'not_yet_valid'
  | 'expired'
  | 'invalid_signature'
  | 'nonce_unknown'
  | 'nonce_replayed';

export type SignInResult =
  | { ok: true; address: string; network: BitcoinNetwork; method: 'bip322-simple' | 'legacy'; fields: SiwbFields }
  | { ok: false; error: SignInErrorCode; detail: string };

/**
 * Verify a SIWB sign-in. Checks, in order: grammar, domain binding, address binding, network,
 * validity window, signature, and finally consumes the nonce (only a valid signature can burn a
 * nonce, so an observer cannot invalidate someone else's challenge). Never throws for bad input.
 */
export async function verifySignIn(input: VerifySignInInput, opts: VerifySignInOptions): Promise<SignInResult> {
  const fail = (error: SignInErrorCode, detail: string): SignInResult => ({ ok: false, error, detail });
  let f: SiwbFields;
  try {
    f = parseSiwbMessage(input.message);
  } catch (e) {
    return fail('malformed_message', (e as Error).message);
  }
  const domains = typeof opts.domain === 'string' ? [opts.domain] : opts.domain;
  if (!domains.includes(f.domain)) return fail('domain_mismatch', `message is for ${f.domain}`);
  if (input.address !== f.address) return fail('address_mismatch', 'address differs from the signed message');
  if (opts.network !== undefined && opts.network !== f.network) return fail('network_mismatch', `expected ${opts.network}`);
  let decoded: DecodedAddress;
  try {
    decoded = decodeAddress(f.address, f.network);
  } catch (e) {
    return fail('invalid_address', (e as Error).message);
  }
  const now = toMs(opts.now);
  const skew = (opts.clockSkewSeconds ?? 60) * 1000;
  if (now + skew < Date.parse(f.issuedAt)) return fail('not_yet_valid', 'issuedAt is in the future');
  if (f.notBefore !== undefined && now + skew < Date.parse(f.notBefore)) return fail('not_yet_valid', 'before notBefore');
  if (now >= Date.parse(f.expirationTime)) return fail('expired', 'challenge expired');

  let method: 'bip322-simple' | 'legacy';
  let raw: Uint8Array;
  try {
    raw = decodeBase64(input.signature);
  } catch {
    return fail('invalid_signature', 'signature is not base64');
  }
  if (isLegacySignature(raw)) {
    if (opts.allowLegacy === false) return fail('invalid_signature', 'legacy signatures disabled');
    const r = verifyLegacyDecoded(decoded, input.message, input.signature);
    if (!r.valid) return fail('invalid_signature', r.reason);
    method = 'legacy';
  } else {
    const r = verifyBip322SimpleDecoded(decoded, input.message, input.signature);
    if (!r.valid) return fail('invalid_signature', r.reason);
    method = 'bip322-simple';
  }

  const consumed = await opts.nonces.consume(f.nonce, { domain: f.domain, address: f.address }, now);
  if (consumed === 'replayed') return fail('nonce_replayed', 'nonce already used');
  if (consumed === 'expired') return fail('expired', 'nonce expired');
  if (consumed !== 'ok') return fail('nonce_unknown', 'nonce was not issued for this domain and address');
  return { ok: true, address: f.address, network: f.network, method, fields: f };
}
