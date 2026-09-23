import { describe, it, expect } from 'vitest';
import { makeSchemas, parseBody, ValidationError } from '../src/validation.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({});
const s = makeSchemas(cfg);
const ID = 'a'.repeat(64) + 'i0';
const ADDR = 'bc1pmxuuzlsdklgc5x5axw4gst4acrh0aqxej95p5ng78rgxkends6jsq0a7v4';
const PUB = '02' + 'ab'.repeat(32);

describe('zod schemas', () => {
  it('accepts a well-formed listing prepare body', () => {
    expect(parseBody(s.listingPrepare, { inscriptionId: ID, sellerAddress: ADDR, sellerPublicKey: PUB, priceSats: 50_000 })).toMatchObject({ priceSats: 50_000 });
  });

  it('rejects malformed inscription ids', () => {
    for (const bad of ['abc', 'A'.repeat(64) + 'i0', 'a'.repeat(64), 'a'.repeat(64) + 'i', 'a'.repeat(63) + 'i0']) {
      expect(() => parseBody(s.listingPrepare, { inscriptionId: bad, sellerAddress: ADDR, sellerPublicKey: PUB, priceSats: 50_000 })).toThrow(ValidationError);
    }
  });

  it('enforces the price window [1000 sats, 100 BTC] and integers', () => {
    const base = { inscriptionId: ID, sellerAddress: ADDR, sellerPublicKey: PUB };
    expect(() => parseBody(s.listingPrepare, { ...base, priceSats: 999 })).toThrow(/at least 1000/);
    expect(() => parseBody(s.listingPrepare, { ...base, priceSats: 100e8 + 1 })).toThrow(/at most/);
    expect(() => parseBody(s.listingPrepare, { ...base, priceSats: 1000.5 })).toThrow(/integer/);
    expect(() => parseBody(s.listingPrepare, { ...base, priceSats: '50000' })).toThrow(ValidationError);
    expect(parseBody(s.listingPrepare, { ...base, priceSats: 1000 }).priceSats).toBe(1000);
    expect(parseBody(s.listingPrepare, { ...base, priceSats: 100e8 }).priceSats).toBe(100e8);
  });

  it('caps listing expiry at 30 days and defaults to it', () => {
    const base = { inscriptionId: ID, sellerAddress: ADDR, sellerPublicKey: PUB, priceSats: 5000, signedPsbt: 'ab'.repeat(10), nonce: 'f'.repeat(32), signature: 'x'.repeat(40) };
    expect(parseBody(s.listingCreate, base).expiresInDays).toBe(30);
    expect(parseBody(s.listingCreate, { ...base, expiresInDays: 7 }).expiresInDays).toBe(7);
    expect(() => parseBody(s.listingCreate, { ...base, expiresInDays: 31 })).toThrow(/30 days/);
    expect(() => parseBody(s.listingCreate, { ...base, expiresInDays: 0 })).toThrow(ValidationError);
  });

  it('rejects unknown fields (strict) and non-hex PSBTs', () => {
    expect(() => parseBody(s.challenge, { action: 'list', address: ADDR, inscriptionId: ID, priceSats: 5000, extra: 1 })).toThrow(ValidationError);
    expect(() => parseBody(s.buySubmit, { sessionId: 'f'.repeat(32), signedPsbt: 'zz' })).toThrow(/hex/i);
  });

  it('validates the buy prepare body with defaults', () => {
    const b = parseBody(s.buyPrepare, { inscriptionId: ID, buyerAddress: ADDR, buyerPublicKey: PUB });
    expect(b.feeTier).toBe('normal');
    expect(b.excludeOutpoints).toEqual([]);
    expect(() => parseBody(s.buyPrepare, { inscriptionId: ID, buyerAddress: ADDR, buyerPublicKey: PUB, feeTier: 'turbo' })).toThrow(ValidationError);
    expect(() => parseBody(s.buyPrepare, { inscriptionId: ID, buyerAddress: ADDR, buyerPublicKey: PUB, excludeOutpoints: ['nope'] })).toThrow(ValidationError);
  });

  it('reports the offending path', () => {
    try {
      parseBody(s.challenge, { action: 'sell', address: ADDR, inscriptionId: ID });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.status).toBe(400);
      expect(err.issues[0].path).toBe('action');
    }
  });
});
