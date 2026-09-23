import { describe, expect, it } from 'vitest';
import { bech32, bech32m } from '@scure/base';
import {
  AddressError,
  decodeMainnetAddress,
  explainTaprootRequirement,
  isTaproot,
  validateMainnetAddress,
} from '@/lib/address';

// Reference addresses from BIP 173 / BIP 350 test vectors and the Bitcoin wiki.
const P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const P2WSH = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
const P2TR = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';
const P2PKH = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const TESTNET_P2WPKH = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const TESTNET_P2PKH = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn';
const TESTNET_P2SH = '2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc';

function flipLastChar(address: string): string {
  const last = address[address.length - 1];
  const replacement = last === 'q' ? 'p' : 'q';
  return address.slice(0, -1) + replacement;
}

describe('validateMainnetAddress', () => {
  it('accepts every mainnet address type', () => {
    for (const addr of [P2WPKH, P2WSH, P2TR, P2PKH, P2SH]) {
      expect(validateMainnetAddress(addr), addr).toBe(true);
    }
  });

  it('reports the kind of each address', () => {
    expect(decodeMainnetAddress(P2WPKH)).toEqual({ network: 'mainnet', kind: 'p2wpkh', witnessVersion: 0 });
    expect(decodeMainnetAddress(P2WSH)).toEqual({ network: 'mainnet', kind: 'p2wsh', witnessVersion: 0 });
    expect(decodeMainnetAddress(P2TR)).toEqual({ network: 'mainnet', kind: 'p2tr', witnessVersion: 1 });
    expect(decodeMainnetAddress(P2PKH)).toEqual({ network: 'mainnet', kind: 'p2pkh' });
    expect(decodeMainnetAddress(P2SH)).toEqual({ network: 'mainnet', kind: 'p2sh' });
  });

  it('accepts upper-case bech32 and trims whitespace', () => {
    expect(validateMainnetAddress(P2TR.toUpperCase())).toBe(true);
    expect(validateMainnetAddress(`  ${P2TR}\n`)).toBe(true);
  });

  it('rejects the wrong network with a clear message', () => {
    for (const addr of [TESTNET_P2WPKH, TESTNET_P2PKH, TESTNET_P2SH]) {
      expect(validateMainnetAddress(addr), addr).toBe(false);
      expect(() => decodeMainnetAddress(addr)).toThrow(/testnet/i);
    }
    expect(() => decodeMainnetAddress('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080')).toThrow(AddressError);
  });

  it('rejects a bad checksum on every encoding', () => {
    for (const addr of [P2WPKH, P2TR, P2PKH, P2SH]) {
      const corrupted = flipLastChar(addr);
      expect(validateMainnetAddress(corrupted), corrupted).toBe(false);
      expect(() => decodeMainnetAddress(corrupted)).toThrow(/checksum/i);
    }
  });

  it('rejects a taproot address encoded with the bech32 (v0) checksum and vice versa', () => {
    const { words } = bech32m.decode(P2TR as `bc1${string}`);
    const wrongChecksum = bech32.encode('bc', words);
    expect(validateMainnetAddress(wrongChecksum)).toBe(false);

    const v0 = bech32.decode(P2WPKH as `bc1${string}`);
    const wrongV0 = bech32m.encode('bc', v0.words);
    expect(validateMainnetAddress(wrongV0)).toBe(false);
  });

  it('rejects mixed case, garbage and empty input', () => {
    expect(validateMainnetAddress('bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(false);
    expect(validateMainnetAddress('')).toBe(false);
    expect(validateMainnetAddress('hello world')).toBe(false);
    expect(validateMainnetAddress('bc1')).toBe(false);
    expect(validateMainnetAddress('0x52908400098527886E0F7030069857D2E4169EE7')).toBe(false);
    expect(validateMainnetAddress(undefined as unknown as string)).toBe(false);
  });

  it('rejects malformed witness programs', () => {
    // v0 with a 25-byte program is invalid per BIP 141.
    const badLength = bech32.encode('bc', [0, ...bech32.toWords(new Uint8Array(25))]);
    expect(validateMainnetAddress(badLength)).toBe(false);
    // v1 with a 20-byte program is not P2TR but still a valid future segwit address.
    const v1Short = bech32m.encode('bc', [1, ...bech32m.toWords(new Uint8Array(20))]);
    expect(validateMainnetAddress(v1Short)).toBe(true);
    expect(decodeMainnetAddress(v1Short).kind).toBe('unknown-segwit');
    expect(isTaproot(v1Short)).toBe(false);
  });
});

describe('isTaproot / explainTaprootRequirement', () => {
  it('is true only for bc1p addresses', () => {
    expect(isTaproot(P2TR)).toBe(true);
    expect(isTaproot(P2WPKH)).toBe(false);
    expect(isTaproot(P2PKH)).toBe(false);
    expect(isTaproot(P2SH)).toBe(false);
    expect(isTaproot(flipLastChar(P2TR))).toBe(false);
  });

  it('explains why an address cannot receive the inscription', () => {
    expect(explainTaprootRequirement(P2TR)).toBeNull();
    expect(explainTaprootRequirement(P2WPKH)).toMatch(/taproot/i);
    expect(explainTaprootRequirement(TESTNET_P2WPKH)).toMatch(/testnet/i);
    expect(explainTaprootRequirement(flipLastChar(P2TR))).toMatch(/checksum/i);
  });
});
