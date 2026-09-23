// Request validation with zod. Every mutating route parses its body through one
// of these schemas before touching the database or the network.
import { z } from 'zod';

export const INSCRIPTION_ID_RE = /^[0-9a-f]{64}i\d{1,6}$/;
export const OUTPOINT_RE = /^[0-9a-f]{64}:\d{1,5}$/;
export const TXID_RE = /^[0-9a-f]{64}$/;
export const HEX_RE = /^(?:[0-9a-f]{2})+$/;
export const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;
// bech32 / bech32m (bc1…, tb1…, bcrt1…); deep validity is checked by the address helpers.
export const ADDRESS_RE = /^(bc|tb|bcrt)1[02-9ac-hj-np-z]{6,90}$/;

export const inscriptionId = z.string().regex(INSCRIPTION_ID_RE, 'Invalid inscription id');
export const outpoint = z.string().regex(OUTPOINT_RE, 'Invalid outpoint (txid:vout)');
export const txid = z.string().regex(TXID_RE, 'Invalid txid');
export const address = z.string().min(14).max(100).regex(ADDRESS_RE, 'Invalid bech32 address');
export const publicKey = z.string().regex(PUBKEY_RE, 'Invalid compressed public key');
export const hexBlob = z.string().min(2).max(200_000).regex(HEX_RE, 'Invalid hex');
export const nonce = z.string().regex(/^[0-9a-f]{32}$/, 'Invalid nonce');
export const signature = z.string().min(20).max(1000);
export const feeTier = z.enum(['economy', 'normal', 'fast']);

export function makeSchemas(cfg) {
  const priceSats = z
    .number()
    .int('Price must be an integer number of sats')
    .min(cfg.priceMinSats, `Price must be at least ${cfg.priceMinSats} sats`)
    .max(cfg.priceMaxSats, `Price must be at most ${cfg.priceMaxSats} sats`);

  const expiresInDays = z
    .number()
    .int()
    .min(1)
    .max(cfg.listingMaxDays, `Listings may last at most ${cfg.listingMaxDays} days`)
    .default(cfg.listingMaxDays);

  return {
    priceSats,
    expiresInDays,

    challenge: z.object({
      action: z.enum(['list', 'cancel']),
      address,
      inscriptionId,
      priceSats: priceSats.optional(),
    }).strict(),

    listingPrepare: z.object({
      inscriptionId,
      sellerAddress: address,
      sellerPublicKey: publicKey,
      priceSats,
    }).strict(),

    listingCreate: z.object({
      inscriptionId,
      sellerAddress: address,
      sellerPublicKey: publicKey,
      priceSats,
      expiresInDays,
      signedPsbt: hexBlob,
      nonce,
      signature,
    }).strict(),

    listingCancel: z.object({
      sellerAddress: address,
      nonce,
      signature,
    }).strict(),

    buyPrepare: z.object({
      inscriptionId,
      buyerAddress: address,
      buyerPublicKey: publicKey,
      feeTier: feeTier.default('normal'),
      // outpoints the wallet reports as carrying inscriptions; never spent as payment
      excludeOutpoints: z.array(outpoint).max(5000).default([]),
    }).strict(),

    buySubmit: z.object({
      sessionId: z.string().regex(/^[0-9a-f]{32}$/),
      signedPsbt: hexBlob,
    }).strict(),
  };
}

export class ValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.issues = issues;
  }
}

export function parseBody(schema, body) {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new ValidationError(issues[0] ? `${issues[0].path || 'body'}: ${issues[0].message}` : 'Invalid request', issues);
  }
  return result.data;
}
