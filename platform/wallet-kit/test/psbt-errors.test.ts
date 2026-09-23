import { describe, expect, it } from 'vitest';
import {
  UnsupportedAddressTypeError,
  UnsupportedNetworkError,
  UserRejectedError,
  WalletError,
  WalletNotInstalledError,
  isUserRejection,
  isWalletError,
  normalizePsbtBase64,
  psbtBase64ToHex,
  psbtHexToBase64,
  toWalletError,
} from '../src/index.js';
import { SIGNED_B64, SIGNED_HEX, UNSIGNED_B64, UNSIGNED_HEX } from './helpers.js';

describe('PSBT codec', () => {
  it('round-trips base64 ↔ hex', () => {
    expect(psbtBase64ToHex(UNSIGNED_B64)).toBe(UNSIGNED_HEX);
    expect(psbtHexToBase64(UNSIGNED_HEX)).toBe(UNSIGNED_B64);
    expect(psbtHexToBase64(psbtBase64ToHex(SIGNED_B64))).toBe(SIGNED_B64);
  });

  it('accepts uppercase and 0x-prefixed hex from wallets', () => {
    expect(psbtHexToBase64(SIGNED_HEX.toUpperCase())).toBe(SIGNED_B64);
    expect(psbtHexToBase64('0x' + SIGNED_HEX)).toBe(SIGNED_B64);
  });

  it('rejects non-PSBT payloads with INVALID_PSBT', () => {
    for (const bad of [() => psbtBase64ToHex('aGVsbG8gd29ybGQ='), () => psbtHexToBase64('deadbeef'), () => psbtHexToBase64('zz'), () => psbtBase64ToHex('!!!')]) {
      try {
        bad();
        expect.unreachable();
      } catch (e) {
        expect((e as WalletError).code).toBe('INVALID_PSBT');
      }
    }
  });

  it('normalizes whitespace in base64', () => {
    expect(normalizePsbtBase64(` ${UNSIGNED_B64}\n`)).toBe(UNSIGNED_B64);
  });
});

describe('errors', () => {
  it('have stable codes and names', () => {
    const cases: Array<[WalletError, string, string]> = [
      [new WalletNotInstalledError('xverse'), 'WALLET_NOT_INSTALLED', 'WalletNotInstalledError'],
      [new UserRejectedError('unisat'), 'USER_REJECTED', 'UserRejectedError'],
      [new UnsupportedNetworkError('okx', 'regtest'), 'UNSUPPORTED_NETWORK', 'UnsupportedNetworkError'],
      [new UnsupportedAddressTypeError('1abc', 'p2pkh'), 'UNSUPPORTED_ADDRESS_TYPE', 'UnsupportedAddressTypeError'],
    ];
    for (const [err, code, name] of cases) {
      expect(err.code).toBe(code);
      expect(err.name).toBe(name);
      expect(err).toBeInstanceOf(WalletError);
      expect(err).toBeInstanceOf(Error);
      expect(isWalletError(err)).toBe(true);
    }
    expect(new WalletNotInstalledError('xverse').walletId).toBe('xverse');
    expect(new UnsupportedNetworkError('okx', 'regtest').network).toBe('regtest');
  });

  it.each([
    ['EIP-1193 4001', { code: 4001, message: 'whatever' }],
    ['sats-connect -32000', { code: -32000, message: 'x' }],
    ['nested envelope', { error: { code: 4001, message: 'x' } }],
    ['string code', { code: 'USER_REJECTION' }],
    ['UniSat message', new Error('User rejected the request.')],
    ['Leather message', { error: { message: 'User denied request' } }],
    ['cancel message', new Error('User canceled')],
    ['plain string', 'Request rejected by user'],
  ])('isUserRejection: %s', (_l, e) => {
    expect(isUserRejection(e)).toBe(true);
  });

  it.each([
    ['network error', new Error('Failed to fetch')],
    ['insufficient funds', { code: -32603, message: 'Insufficient balance' }],
    ['null', null],
  ])('isUserRejection false: %s', (_l, e) => {
    expect(isUserRejection(e)).toBe(false);
  });

  it('toWalletError maps rejections, wraps others, passes WalletErrors through', () => {
    const rejected = toWalletError({ code: 4001 }, 'okx');
    expect(rejected).toBeInstanceOf(UserRejectedError);
    expect(rejected.walletId).toBe('okx');
    const other = toWalletError(new Error('boom'), 'leather');
    expect(other.code).toBe('WALLET_ERROR');
    expect(other.message).toContain('boom');
    expect((other as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    const pass = new UnsupportedNetworkError('xverse', 'signet');
    expect(toWalletError(pass, 'xverse')).toBe(pass);
  });
});
