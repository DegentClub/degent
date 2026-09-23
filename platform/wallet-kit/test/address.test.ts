import { describe, expect, it } from 'vitest';
import {
  UnsupportedAddressTypeError,
  addressMatchesNetwork,
  detectAddressNetwork,
  detectAddressType,
  isSegwit,
  requireSegwitPayment,
  type WalletAccount,
} from '../src/index.js';
import { ADDR, segwitAddr } from './helpers.js';

describe('detectAddressType', () => {
  const table: Array<[string, string, string]> = [
    // label, address, expected type
    ['BIP-86 mainnet p2tr vector', 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', 'p2tr'],
    ['BIP-173 mainnet p2wpkh vector', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'p2wpkh'],
    ['BIP-173 uppercase p2wpkh', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'p2wpkh'],
    ['BIP-173 testnet p2wpkh vector', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'p2wpkh'],
    ['mainnet p2tr (generated)', ADDR.main.p2tr, 'p2tr'],
    ['mainnet p2wpkh (generated)', ADDR.main.p2wpkh, 'p2wpkh'],
    ['testnet p2tr', ADDR.test.p2tr, 'p2tr'],
    ['testnet p2wpkh', ADDR.test.p2wpkh, 'p2wpkh'],
    ['regtest p2tr', ADDR.regtest.p2tr, 'p2tr'],
    ['regtest p2wpkh', ADDR.regtest.p2wpkh, 'p2wpkh'],
    ['mainnet p2sh (3…)', ADDR.main.p2sh, 'p2sh-p2wpkh'],
    ['testnet p2sh (2…)', ADDR.test.p2sh, 'p2sh-p2wpkh'],
    ['mainnet p2pkh (1…)', ADDR.main.p2pkh, 'p2pkh'],
    ['testnet p2pkh (m…)', ADDR.test.p2pkh, 'p2pkh'],
    ['testnet p2pkh (n…)', 'n3GNqMveyvaPvUbH469vDRadqpJMPc84JA', 'p2pkh'],
    ['p2wsh is not an account type', segwitAddr('bc', 0, 32), 'unknown'],
    ['segwit v1 with 20-byte program', segwitAddr('bc', 1, 20), 'unknown'],
    ['bc1p encoded with bech32 (not bech32m)', 'bc1p' + ADDR.main.p2wpkh.slice(4), 'unknown'],
    ['p2tr with broken checksum', ADDR.main.p2tr.slice(0, -1) + (ADDR.main.p2tr.endsWith('q') ? 'p' : 'q'), 'unknown'],
    ['mixed-case bech32', 'bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'unknown'],
    ['wrong hrp (litecoin)', 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9', 'unknown'],
    ['empty string', '', 'unknown'],
    ['garbage', 'not-an-address', 'unknown'],
    ['base58 with bad alphabet (0)', '10zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'unknown'],
    ['ethereum address', '0x52908400098527886E0F7030069857D2E4169EE7', 'unknown'],
  ];
  it.each(table)('%s', (_label, address, expected) => {
    expect(detectAddressType(address)).toBe(expected);
  });

  it('trims surrounding whitespace', () => {
    expect(detectAddressType(`  ${ADDR.main.p2tr}\n`)).toBe('p2tr');
  });
});

describe('detectAddressNetwork / addressMatchesNetwork', () => {
  it.each([
    [ADDR.main.p2tr, 'mainnet'],
    [ADDR.main.p2pkh, 'mainnet'],
    [ADDR.main.p2sh, 'mainnet'],
    [ADDR.test.p2wpkh, 'testnet-or-signet'],
    [ADDR.test.p2pkh, 'testnet-or-signet'],
    [ADDR.test.p2sh, 'testnet-or-signet'],
    [ADDR.regtest.p2tr, 'regtest'],
  ])('%s → %s', (addr, net) => {
    expect(detectAddressNetwork(addr)).toBe(net);
  });

  it('returns undefined for garbage', () => {
    expect(detectAddressNetwork('nope')).toBeUndefined();
  });

  it('matches mainnet only to bc1/1/3', () => {
    expect(addressMatchesNetwork(ADDR.main.p2tr, 'mainnet')).toBe(true);
    expect(addressMatchesNetwork(ADDR.main.p2tr, 'testnet')).toBe(false);
    expect(addressMatchesNetwork(ADDR.main.p2tr, 'regtest')).toBe(false);
  });

  it('treats testnet and signet as the same address space', () => {
    expect(addressMatchesNetwork(ADDR.test.p2tr, 'testnet')).toBe(true);
    expect(addressMatchesNetwork(ADDR.test.p2tr, 'signet')).toBe(true);
    expect(addressMatchesNetwork(ADDR.test.p2tr, 'mainnet')).toBe(false);
    expect(addressMatchesNetwork(ADDR.test.p2tr, 'regtest')).toBe(false);
  });

  it('keeps regtest (bcrt1) separate from testnet (tb1)', () => {
    expect(addressMatchesNetwork(ADDR.regtest.p2wpkh, 'regtest')).toBe(true);
    expect(addressMatchesNetwork(ADDR.regtest.p2wpkh, 'testnet')).toBe(false);
  });

  it('never matches an unparseable address', () => {
    expect(addressMatchesNetwork('garbage', 'mainnet')).toBe(false);
  });
});

describe('requireSegwitPayment', () => {
  const acct = (address: string, addressType: WalletAccount['addressType']): WalletAccount => ({
    address,
    publicKey: '02' + '00'.repeat(32),
    purpose: 'payment',
    addressType,
  });

  it.each([
    ['p2tr', ADDR.main.p2tr],
    ['p2wpkh', ADDR.main.p2wpkh],
    ['p2sh-p2wpkh', ADDR.main.p2sh],
  ] as const)('accepts %s', (type, address) => {
    const a = acct(address, type);
    expect(requireSegwitPayment(a)).toBe(a);
  });

  it('rejects legacy p2pkh with a stable code and a helpful message', () => {
    let err: unknown;
    try {
      requireSegwitPayment(acct(ADDR.main.p2pkh, 'p2pkh'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnsupportedAddressTypeError);
    const e = err as UnsupportedAddressTypeError;
    expect(e.code).toBe('UNSUPPORTED_ADDRESS_TYPE');
    expect(e.addressType).toBe('p2pkh');
    expect(e.address).toBe(ADDR.main.p2pkh);
    expect(e.message).toMatch(/funding txid/);
  });

  it('re-detects when the account says unknown', () => {
    expect(() => requireSegwitPayment(acct(ADDR.test.p2pkh, 'unknown'))).toThrow(UnsupportedAddressTypeError);
    expect(requireSegwitPayment(acct(ADDR.test.p2wpkh, 'unknown')).address).toBe(ADDR.test.p2wpkh);
  });

  it('rejects unrecognised addresses', () => {
    expect(() => requireSegwitPayment(acct('garbage', 'unknown'))).toThrow(UnsupportedAddressTypeError);
  });

  it('isSegwit truth table', () => {
    expect(['p2tr', 'p2wpkh', 'p2sh-p2wpkh', 'p2pkh', 'unknown'].map((t) => isSegwit(t as never))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});
