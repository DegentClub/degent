import { describe, it, expect } from 'vitest';
import { buildMessage, parseMessage, verifySignature, looksLikeBitcoinAddress, MESSAGE_HEADER } from '../src/telegram-gate/message';
import { makeWallet } from './helpers/wallet';

const NONCE = 'a'.repeat(32);
const EXPIRES = new Date('2030-01-01T00:00:00.000Z');

describe('buildMessage / parseMessage', () => {
  it('produces the exact five-line format', () => {
    const msg = buildMessage({ telegramUserId: 42, address: 'bc1qxyz', nonce: NONCE, expires: EXPIRES });
    expect(msg).toBe(
      `${MESSAGE_HEADER}\ntelegram:42\naddress:bc1qxyz\nnonce:${NONCE}\nexpires:2030-01-01T00:00:00.000Z`,
    );
    expect(msg.endsWith('\n')).toBe(false);
  });

  it('round-trips through parseMessage', () => {
    const msg = buildMessage({ telegramUserId: 42, address: 'bc1qxyz', nonce: NONCE, expires: EXPIRES });
    expect(parseMessage(msg)).toEqual({
      telegramUserId: 42,
      address: 'bc1qxyz',
      nonce: NONCE,
      expires: '2030-01-01T00:00:00.000Z',
    });
  });

  it('rejects malformed messages', () => {
    expect(parseMessage('hello')).toBeNull();
    expect(parseMessage(`other\ntelegram:1\naddress:a\nnonce:b\nexpires:c`)).toBeNull();
    expect(parseMessage(`${MESSAGE_HEADER}\ntelegram:x\naddress:a\nnonce:b\nexpires:c`)).toBeNull();
    expect(parseMessage(`${MESSAGE_HEADER}\ntelegram:1\naddress:a\nnonce:b`)).toBeNull();
    expect(parseMessage(null)).toBeNull();
  });

  it('validates inputs', () => {
    expect(() => buildMessage({ telegramUserId: 0, address: 'a', nonce: NONCE, expires: EXPIRES })).toThrow();
    expect(() => buildMessage({ telegramUserId: 1, address: '', nonce: NONCE, expires: EXPIRES })).toThrow();
    expect(() => buildMessage({ telegramUserId: 1, address: 'a', nonce: 'not hex', expires: EXPIRES })).toThrow();
    expect(() => buildMessage({ telegramUserId: 1, address: 'a', nonce: NONCE, expires: 'never' })).toThrow();
  });
});

describe('BIP-322 round-trip with an in-test key', () => {
  it.each(['p2wpkh', 'p2tr'])('%s: sign and verify', (kind) => {
    const w = makeWallet(kind);
    const msg = buildMessage({ telegramUserId: 7, address: w.address, nonce: NONCE, expires: EXPIRES });
    const sig = w.sign(msg);
    expect(verifySignature(w.address, msg, sig)).toBe(true);
  });

  it('fails when the message is altered', () => {
    const w = makeWallet();
    const msg = buildMessage({ telegramUserId: 7, address: w.address, nonce: NONCE, expires: EXPIRES });
    const sig = w.sign(msg);
    const altered = buildMessage({ telegramUserId: 8, address: w.address, nonce: NONCE, expires: EXPIRES });
    expect(verifySignature(w.address, altered, sig)).toBe(false);
  });

  it('fails for a different address', () => {
    const a = makeWallet();
    const b = makeWallet();
    const msg = buildMessage({ telegramUserId: 7, address: a.address, nonce: NONCE, expires: EXPIRES });
    expect(verifySignature(b.address, msg, a.sign(msg))).toBe(false);
  });

  it('never throws on garbage', () => {
    expect(verifySignature('bc1qgarbage', 'x', 'not-base64')).toBe(false);
    expect(verifySignature('', '', '')).toBe(false);
  });
});

describe('looksLikeBitcoinAddress', () => {
  it('accepts bech32, taproot, P2SH, P2PKH shapes and rejects junk', () => {
    expect(looksLikeBitcoinAddress(makeWallet().address)).toBe(true);
    expect(looksLikeBitcoinAddress(makeWallet('p2tr').address)).toBe(true);
    expect(looksLikeBitcoinAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);
    expect(looksLikeBitcoinAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe(true);
    expect(looksLikeBitcoinAddress('0x1234')).toBe(false);
    expect(looksLikeBitcoinAddress('bc1')).toBe(false);
    expect(looksLikeBitcoinAddress(42)).toBe(false);
  });
});
