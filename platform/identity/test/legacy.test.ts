import { describe, expect, it } from 'vitest';
import { p2pkh, p2sh, p2wpkh, NETWORK } from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { legacyMessageHash, signLegacyMessage, verifyLegacyMessage } from '../src/index.js';
import { sha256d } from '../src/bip322.js';
import { concatBytes, utf8 } from '../src/bytes.js';
import { addr, flipBase64Byte, key } from './helpers.js';

const p2shP2wpkh = (priv: Uint8Array) => p2sh(p2wpkh(secp256k1.getPublicKey(priv, true)), NETWORK).address!;

describe('legacy "Bitcoin Signed Message"', () => {
  it('digest is sha256d(varstr(magic) || varstr(message))', () => {
    const magic = utf8('Bitcoin Signed Message:\n');
    const expected = sha256d(concatBytes(Uint8Array.of(24), magic, Uint8Array.of(11), utf8('Hello World')));
    expect(hex.encode(legacyMessageHash('Hello World'))).toBe(hex.encode(expected));
    // long messages use a 0xfd CompactSize prefix
    const long = 'a'.repeat(300);
    const exp2 = sha256d(concatBytes(Uint8Array.of(24), magic, Uint8Array.of(0xfd, 0x2c, 0x01), utf8(long)));
    expect(hex.encode(legacyMessageHash(long))).toBe(hex.encode(exp2));
  });

  it.each([
    ['p2pkh (compressed, header 31-34)', 'p2pkh', () => addr('pkh', key(31))],
    ['p2pkh (uncompressed, header 27-30)', 'p2pkh-uncompressed', () => p2pkh(secp256k1.getPublicKey(key(31), false), NETWORK).address!],
    ['p2wpkh (header 39-42)', 'p2wpkh', () => addr('wpkh', key(31))],
    ['p2sh-p2wpkh (header 35-38)', 'p2sh-p2wpkh', () => p2shP2wpkh(key(31))],
  ] as const)('round-trips %s', (_n, kind, address) => {
    const sig = signLegacyMessage(key(31), 'hello', kind);
    const header = Buffer.from(sig, 'base64')[0]!;
    const base = { 'p2pkh-uncompressed': 27, p2pkh: 31, 'p2sh-p2wpkh': 35, p2wpkh: 39 }[kind];
    expect(header - base).toBeGreaterThanOrEqual(0);
    expect(header - base).toBeLessThan(4);
    expect(verifyLegacyMessage(address(), 'mainnet', 'hello', sig).valid).toBe(true);
  });

  it('accepts the common "header 31 for bc1q" wallet behaviour', () => {
    const sig = signLegacyMessage(key(32), 'hello', 'p2pkh');
    expect(verifyLegacyMessage(addr('wpkh', key(32)), 'mainnet', 'hello', sig).valid).toBe(true);
  });

  it('rejects wrong message, wrong address, tampered signature', () => {
    const a = addr('wpkh', key(33));
    const sig = signLegacyMessage(key(33), 'hello');
    expect(verifyLegacyMessage(a, 'mainnet', 'hello!', sig).valid).toBe(false);
    expect(verifyLegacyMessage(addr('wpkh', key(34)), 'mainnet', 'hello', sig).valid).toBe(false);
    for (const i of [1, 20, 33, 50, 64]) expect(verifyLegacyMessage(a, 'mainnet', 'hello', flipBase64Byte(sig, i)).valid).toBe(false);
  });

  it('rejects an uncompressed key for segwit addresses', () => {
    const sig = signLegacyMessage(key(35), 'hello', 'p2pkh-uncompressed');
    expect(verifyLegacyMessage(addr('wpkh', key(35)), 'mainnet', 'hello', sig).valid).toBe(false);
  });

  it('never accepts legacy signatures for taproot addresses', () => {
    const sig = signLegacyMessage(key(36), 'hello');
    expect(verifyLegacyMessage(addr('tr', key(36)), 'mainnet', 'hello', sig)).toMatchObject({ valid: false });
  });

  it('rejects wrong lengths and headers', () => {
    const a = addr('wpkh', key(37));
    const raw = Buffer.from(signLegacyMessage(key(37), 'hello'), 'base64');
    expect(verifyLegacyMessage(a, 'mainnet', 'hello', raw.subarray(0, 64).toString('base64')).valid).toBe(false);
    const badHeader = Buffer.from(raw);
    badHeader[0] = 43;
    expect(verifyLegacyMessage(a, 'mainnet', 'hello', badHeader.toString('base64')).valid).toBe(false);
  });
});
