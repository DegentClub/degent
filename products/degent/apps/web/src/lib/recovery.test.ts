import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  clearRecovery,
  isRecoveryBundle,
  loadRecovery,
  parseRecovery,
  recoveryJson,
  RECOVERY_KEY,
  saveRecovery,
  type RecoveryBundle,
} from './recovery';

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
  contentType: 'image/webp',
  contentSha256: 'bb'.repeat(32),
  contentBase64: 'UklGRg==',
  parentInscriptionId: `${'cc'.repeat(32)}i0`,
  collectionAddress: 'bc1pclub',
  parentValueSats: 10_000,
  revealPrivkey: 'dd'.repeat(32),
  revealPubkey: 'ee'.repeat(32),
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

  it('ignores garbage, v1 bundles and bundles without a token, key or content', () => {
    const s = store();
    s.setItem(RECOVERY_KEY, '{not json');
    expect(loadRecovery(s)).toBeNull();
    expect(isRecoveryBundle({ ...bundle, orderToken: undefined })).toBe(false);
    expect(isRecoveryBundle({ ...bundle, version: 1 })).toBe(false);
    expect(isRecoveryBundle({ ...bundle, revealPrivkey: 'not-hex' })).toBe(false);
    expect(isRecoveryBundle({ ...bundle, contentBase64: 1 })).toBe(false);
    expect(parseRecovery(JSON.stringify(bundle))).toEqual(bundle);
    expect(parseRecovery('[]')).toBeNull();
  });

  it('base64 helpers round-trip large byte arrays', () => {
    const bytes = new Uint8Array(200_001).map((_, i) => (i * 31) & 0xff);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
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

  it('pretty JSON includes the order token and the reveal key K_e (ADR-0005: the user keeps it)', () => {
    const json = recoveryJson(bundle);
    expect(JSON.parse(json)).toEqual(bundle);
    expect(json).toContain('"orderToken": "secret-token"');
    expect(json).toContain(`"revealPrivkey": "${'dd'.repeat(32)}"`);
  });
});
