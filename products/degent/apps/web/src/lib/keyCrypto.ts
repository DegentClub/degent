/**
 * The ephemeral reveal key K_e, encrypted for the recovery bundle (ADR-0005).
 *
 * Since the reveal is signed SIGHASH_ALL|ANYONECANPAY (0x81), self-rescue is a fresh [commit] -> [child]
 * transaction re-signed with K_e, so the key must outlive the payment. It is kept only in this form:
 * AES-256-GCM under a key derived from the user's recovery passphrase with PBKDF2-SHA256 (WebCrypto), with the
 * order id and the reveal public key as additional data. The plaintext never leaves the tab and is wiped after
 * use; the passphrase is never stored or sent. Standard primitives on purpose: the bundle can be decrypted with
 * any WebCrypto/OpenSSL tooling if this site is gone.
 */
import { hex } from '@scure/base';

export const KDF_ITERATIONS = 600_000;
/** A bundle (possibly re-selected from a file) asking for more than this is refused rather than freezing the tab. */
export const MAX_KDF_ITERATIONS = 10_000_000;
export const MIN_PASSPHRASE_LENGTH = 8;

export interface EncryptedRevealKey {
  alg: 'AES-256-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  /** hex, 16 bytes */
  salt: string;
  /** hex, 12 bytes */
  iv: string;
  /** hex: 32-byte key + 16-byte GCM tag */
  ciphertext: string;
  /** Additional authenticated data, as UTF-8 text: `degent.club/recovery|<orderId>|<revealPubkey>`. */
  aad: string;
}

export class PassphraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PassphraseError';
  }
}

const enc = new TextEncoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('This browser has no WebCrypto; the reveal key cannot be protected. Use a current browser.');
  return s;
}

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto rejects views over other realms' buffers in some hosts). */
const buf = (b: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(b.length));
  out.set(b);
  return out;
};

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', buf(enc.encode(passphrase.normalize('NFKC'))), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function aadFor(orderId: string, revealPubkey: string): string {
  return `degent.club/recovery|${orderId}|${revealPubkey}`;
}

export function checkPassphrase(passphrase: string): string | null {
  if (passphrase.normalize('NFKC').length < MIN_PASSPHRASE_LENGTH)
    return `Choose a recovery passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  return null;
}

export async function encryptRevealKey(
  privkey: Uint8Array,
  passphrase: string,
  bind: { orderId: string; revealPubkey: string },
  iterations: number = KDF_ITERATIONS,
): Promise<EncryptedRevealKey> {
  const problem = checkPassphrase(passphrase);
  if (problem) throw new PassphraseError(problem);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = aadFor(bind.orderId, bind.revealPubkey);
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(enc.encode(aad)) }, key, buf(privkey));
  return {
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: hex.encode(salt),
    iv: hex.encode(iv),
    ciphertext: hex.encode(new Uint8Array(ct)),
    aad,
  };
}

/** Decrypts K_e. Throws PassphraseError on a wrong passphrase (or a bundle bound to another order/key). */
export async function decryptRevealKey(
  enc_: EncryptedRevealKey,
  passphrase: string,
  bind: { orderId: string; revealPubkey: string },
): Promise<Uint8Array> {
  if (enc_.alg !== 'AES-256-GCM' || enc_.kdf !== 'PBKDF2-SHA256') throw new Error(`unsupported key encryption ${enc_.alg}/${enc_.kdf}`);
  if (enc_.aad !== aadFor(bind.orderId, bind.revealPubkey)) throw new PassphraseError('This encrypted key belongs to another order.');
  if (!Number.isSafeInteger(enc_.iterations) || enc_.iterations < 1 || enc_.iterations > MAX_KDF_ITERATIONS)
    throw new Error(`unsupported PBKDF2 iteration count in the recovery bundle (${enc_.iterations})`);
  const key = await deriveKey(passphrase, hex.decode(enc_.salt), enc_.iterations);
  try {
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: buf(hex.decode(enc_.iv)), additionalData: buf(enc.encode(enc_.aad)) },
      key,
      buf(hex.decode(enc_.ciphertext)),
    );
    return new Uint8Array(pt);
  } catch {
    throw new PassphraseError('Wrong recovery passphrase.');
  }
}
