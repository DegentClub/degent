import { describe, expect, it } from 'vitest';
import { clearRecovery, isRecoveryBundle, loadRecovery, recoveryJson, RECOVERY_KEY, saveRecovery, type RecoveryBundle } from './recovery';

const bundle: RecoveryBundle = {
  kind: 'degent.club/recovery',
  version: 2,
  orderId: 'ord_1',
  network: 'mainnet',
  mintApiUrl: 'https://mint.test',
  savedAt: '2026-09-23T00:00:00.000Z',
  commitTxid: 'aa'.repeat(32),
  commitVout: 0,
  commitValueSats: 250_546,
  recipientAddress: 'bc1pme',
  postageSats: 546,
  feeRate: 2,
  contentType: 'image/webp',
  contentSha256: 'bb'.repeat(32),
  parentInscriptionId: 'cc'.repeat(32) + 'i0',
  revealPubkey: 'dd'.repeat(32),
  revealKey: {
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: 600_000,
    salt: '00'.repeat(16),
    iv: '11'.repeat(12),
    ciphertext: '22'.repeat(48),
    aad: `degent.club/recovery|ord_1|${'dd'.repeat(32)}`,
  },
  orderToken: 'secret-token',
  note: 'n',
  warning: 'w',
};

function store() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe('recovery bundle storage', () => {
  it('round-trips through storage', () => {
    const s = store();
    expect(saveRecovery(bundle, s)).toBe(true);
    expect(loadRecovery(s)).toEqual(bundle);
    clearRecovery(s);
    expect(loadRecovery(s)).toBeNull();
  });

  it('ignores garbage, bundles without a token or encrypted key, and version-1 (0x83) bundles', () => {
    const s = store();
    s.setItem(RECOVERY_KEY, '{not json');
    expect(loadRecovery(s)).toBeNull();
    expect(isRecoveryBundle({ ...bundle, orderToken: undefined })).toBe(false);
    expect(isRecoveryBundle({ ...bundle, revealKey: undefined })).toBe(false);
    expect(isRecoveryBundle({ ...bundle, version: 1, halfSignedRevealPsbt: 'cHNidP8=' })).toBe(false);
  });

  it('survives a storage that throws', () => {
    const bad = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    expect(saveRecovery(bundle, bad)).toBe(false);
    expect(loadRecovery(bad)).toBeNull();
    expect(saveRecovery(bundle, null)).toBe(false);
  });

  it('pretty JSON includes the order token and the ENCRYPTED key only (no plaintext key field)', () => {
    const json = recoveryJson(bundle);
    expect(JSON.parse(json)).toEqual(bundle);
    expect(json).toContain('"orderToken": "secret-token"');
    expect(json).toContain('"ciphertext"');
    expect(json).not.toMatch(/priv|secretKey|halfSigned/i);
  });
});
