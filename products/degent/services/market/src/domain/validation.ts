/**
 * Request validation (zod). Every mutating route parses its body through one of these strict schemas
 * before touching storage or the network; unknown fields are rejected. Deep address validity (network,
 * key derivation) is checked by the settlement engine.
 */
import { z } from 'zod';
import { DomainError } from './errors.js';

export const INSCRIPTION_ID_RE = /^[0-9a-f]{64}i\d{1,6}$/;
export const OUTPOINT_RE = /^[0-9a-f]{64}:\d{1,5}$/;
export const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;
/** bech32 / bech32m (bc1…, tb1…, bcrt1…). */
export const ADDRESS_RE = /^(bc|tb|bcrt)1[02-9ac-hj-np-z]{6,90}$/;
/** Hex or base64 PSBT. */
export const PSBT_RE = /^(?:(?:[0-9a-f]{2})+|[A-Za-z0-9+/]+={0,2})$/;

const inscriptionId = z.string().regex(INSCRIPTION_ID_RE, 'invalid inscription id');
const outpoint = z.string().regex(OUTPOINT_RE, 'invalid outpoint (txid:vout)');
const address = z.string().min(14).max(100).regex(ADDRESS_RE, 'invalid bech32 address');
const publicKey = z.string().regex(PUBKEY_RE, 'invalid compressed public key');
const psbt = z.string().min(20).max(400_000).regex(PSBT_RE, 'PSBT must be hex or base64');
const message = z.string().min(20).max(4_000);
const signature = z.string().min(20).max(1_000);

export interface SchemaLimits {
  priceMinSats: number;
  priceMaxSats: number;
  listingMaxDays: number;
}

export function makeSchemas(cfg: SchemaLimits) {
  const priceSats = z
    .number()
    .int('price must be an integer number of sats')
    .min(cfg.priceMinSats, `price must be at least ${cfg.priceMinSats} sats`)
    .max(cfg.priceMaxSats, `price must be at most ${cfg.priceMaxSats} sats`);
  const expiresInDays = z.number().int().min(1).max(cfg.listingMaxDays, `listings may last at most ${cfg.listingMaxDays} days`).default(cfg.listingMaxDays);
  return {
    priceSats,
    challenge: z
      .object({ action: z.enum(['list', 'cancel']), address, inscriptionId, priceSats: priceSats.optional() })
      .strict()
      .refine((b) => b.action !== 'list' || b.priceSats !== undefined, { message: 'priceSats is required for a list challenge', path: ['priceSats'] }),
    listingPrepare: z.object({ inscriptionId, sellerAddress: address, sellerPublicKey: publicKey, priceSats }).strict(),
    listingCreate: z
      .object({ inscriptionId, sellerAddress: address, sellerPublicKey: publicKey, priceSats, expiresInDays, signedPsbt: psbt, message, signature })
      .strict(),
    listingCancel: z.object({ sellerAddress: address, message, signature }).strict(),
    buyPrepare: z
      .object({
        inscriptionId,
        buyerAddress: address,
        buyerPublicKey: publicKey,
        feeTier: z.enum(['economy', 'normal', 'fast']).default('normal'),
        excludeOutpoints: z.array(outpoint).max(5000).default([]),
      })
      .strict(),
    buySubmit: z.object({ sessionId: z.string().regex(/^[0-9a-f]{32}$/, 'invalid session id'), signedPsbt: psbt }).strict(),
  };
}

export type Schemas = ReturnType<typeof makeSchemas>;

/** Parse or throw 422 `validation_failed` naming the offending path first. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
  const first = issues[0];
  throw new DomainError('validation_failed', 422, first ? `${first.path || 'body'}: ${first.message}` : 'invalid request', { issues });
}
