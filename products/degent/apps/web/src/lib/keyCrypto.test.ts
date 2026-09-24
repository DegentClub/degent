import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { checkPassphrase, decryptRevealKey, encryptRevealKey, KDF_ITERATIONS, PassphraseError } from './keyCrypto';

// Low iteration count for speed; the format records it, so decryption uses whatever was stored.
const IT = 1_000;

describe('reveal key encryption (ADR-0005)', () => {
  const privkey = schnorr.utils.randomSecretKey();
  const revealPubkey = hex.encode(schnorr.getPublicKey(privkey));
  const bind = { orderId: 'dgt_1', revealPubkey };

  it('round-trips K_e with the right passphrase; the ciphertext never contains the key', async () => {
    const e = await encryptRevealKey(privkey, 'correct horse battery', bind, IT);
    expect(e).toMatchObject({ alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: IT });
    expect(e.ciphertext).toHaveLength((32 + 16) * 2);
    expect(e.ciphertext).not.toContain(hex.encode(privkey));
    expect(await decryptRevealKey(e, 'correct horse battery', bind)).toEqual(privkey);
  });

  it('defaults to 600,000 PBKDF2 iterations', () => {
    expect(KDF_ITERATIONS).toBe(600_000);
  });

  it('refuses a wrong passphrase, another order, and a tampered ciphertext', async () => {
    const e = await encryptRevealKey(privkey, 'correct horse battery', bind, IT);
    await expect(decryptRevealKey(e, 'wrong horse battery', bind)).rejects.toBeInstanceOf(PassphraseError);
    await expect(decryptRevealKey(e, 'correct horse battery', { ...bind, orderId: 'dgt_2' })).rejects.toThrow(/another order/);
    await expect(decryptRevealKey({ ...e, aad: `degent.club/recovery|dgt_2|${revealPubkey}` }, 'correct horse battery', { ...bind, orderId: 'dgt_2' })).rejects.toThrow(/Wrong/);
    const flipped = (e.ciphertext[0] === '0' ? '1' : '0') + e.ciphertext.slice(1);
    await expect(decryptRevealKey({ ...e, ciphertext: flipped }, 'correct horse battery', bind)).rejects.toThrow(/Wrong/);
  });

  it('requires a passphrase of at least 8 characters', async () => {
    expect(checkPassphrase('short')).toMatch(/at least 8/);
    expect(checkPassphrase('long enough')).toBeNull();
    await expect(encryptRevealKey(privkey, 'short', bind, IT)).rejects.toBeInstanceOf(PassphraseError);
  });
});
