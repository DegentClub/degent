/** zod request schemas (ported from the legacy validation suite). */
import { describe, expect, it } from 'vitest';
import { makeSchemas, parseBody } from '../src/domain/validation.js';
import { INSCRIPTION_ID, keyFromSeed } from './fakes/keys.js';

const s = makeSchemas({ priceMinSats: 1000, priceMaxSats: 100 * 1e8, listingMaxDays: 30 });
const seller = keyFromSeed('seller');
const prepare = { inscriptionId: INSCRIPTION_ID, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: 50_000 };

describe('zod schemas', () => {
  it('accepts a well-formed listing prepare body', () => {
    expect(parseBody(s.listingPrepare, prepare)).toEqual(prepare);
  });

  it('rejects malformed inscription ids', () => {
    for (const id of ['nope', `${'A'.repeat(64)}i0`, `${'a'.repeat(63)}i0`, `${'a'.repeat(64)}`, `${'a'.repeat(64)}i1234567`])
      expect(() => parseBody(s.listingPrepare, { ...prepare, inscriptionId: id })).toThrow(/inscriptionId/);
  });

  it('enforces the price window [1 000 sats, 100 BTC] and integers', () => {
    expect(() => parseBody(s.listingPrepare, { ...prepare, priceSats: 999 })).toThrow(/at least 1000/);
    expect(() => parseBody(s.listingPrepare, { ...prepare, priceSats: 100 * 1e8 + 1 })).toThrow(/at most/);
    expect(() => parseBody(s.listingPrepare, { ...prepare, priceSats: 1000.5 })).toThrow(/integer/);
    expect(() => parseBody(s.listingPrepare, { ...prepare, priceSats: '1000' })).toThrow();
    expect(parseBody(s.listingPrepare, { ...prepare, priceSats: 100 * 1e8 }).priceSats).toBe(100 * 1e8);
  });

  it('caps listing expiry at 30 days and defaults to it', () => {
    const create = { ...prepare, signedPsbt: '70736274ff'.repeat(4), message: 'x'.repeat(40), signature: 'A'.repeat(88) };
    expect(parseBody(s.listingCreate, create).expiresInDays).toBe(30);
    expect(parseBody(s.listingCreate, { ...create, expiresInDays: 7 }).expiresInDays).toBe(7);
    expect(() => parseBody(s.listingCreate, { ...create, expiresInDays: 31 })).toThrow(/30 days/);
  });

  it('rejects unknown fields (strict) and PSBTs that are neither hex nor base64', () => {
    expect(() => parseBody(s.listingPrepare, { ...prepare, extra: 1 })).toThrow();
    const create = { ...prepare, message: 'x'.repeat(40), signature: 'A'.repeat(88) };
    expect(() => parseBody(s.listingCreate, { ...create, signedPsbt: 'not a psbt!!!!!!!!!!!' })).toThrow(/hex or base64/);
    expect(parseBody(s.listingCreate, { ...create, signedPsbt: 'cHNidP8BAHECAAAAAQ==' }).signedPsbt).toBe('cHNidP8BAHECAAAAAQ==');
  });

  it('validates the buy prepare body with defaults', () => {
    const b = parseBody(s.buyPrepare, { inscriptionId: INSCRIPTION_ID, buyerAddress: seller.tr.address, buyerPublicKey: seller.publicKeyHex });
    expect(b.feeTier).toBe('normal');
    expect(b.excludeOutpoints).toEqual([]);
    expect(() => parseBody(s.buyPrepare, { ...b, feeTier: 'ludicrous' })).toThrow();
    expect(() => parseBody(s.buyPrepare, { ...b, excludeOutpoints: ['nope'] })).toThrow(/outpoint/);
  });

  it('a list challenge needs a price; reports the offending path and a 422', () => {
    try {
      parseBody(s.challenge, { action: 'list', address: seller.tr.address, inscriptionId: INSCRIPTION_ID });
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'validation_failed', status: 422 });
      expect((e as Error).message).toMatch(/^priceSats:/);
    }
    expect(parseBody(s.challenge, { action: 'cancel', address: seller.tr.address, inscriptionId: INSCRIPTION_ID }).action).toBe('cancel');
  });
});
