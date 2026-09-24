/**
 * Price, royalty and fee maths of the marketplace: the ONE implementation used by the service
 * (coin selection, summaries) and by any front end (previews). Pure, `bigint` for money.
 *
 * Settlement layout constants live here too, because the front end must tell the wallet which
 * input to sign and explain where the inscription goes (docs/SETTLEMENT.md).
 */
import type { FeesResponse, SettlementLayout } from './types.js';

/** Seller signs input #2 with SIGHASH_SINGLE|ANYONECANPAY; the price is output #2. */
export const INSCRIPTION_INPUT_INDEX = 2;
export const PRICE_OUTPUT_INDEX = 2;
/** Output #1 (postage, to the buyer) receives the inscription under ord's FIFO rule. */
export const INSCRIPTION_OUTPUT_INDEX = 1;
export const DUMMY_MERGE_OUTPUT_INDEX = 0;
/** Two buyer padding inputs ahead of the inscription. */
export const DUMMY_COUNT = 2;
/** Smallest padding UTXO accepted (and the value the dummy round creates by default). */
export const MIN_DUMMY_VALUE = 600;
/** Largest UTXO the service treats as a padding candidate. */
export const MAX_DUMMY_VALUE = 1000;
export const SIGHASH_SINGLE_ANYONECANPAY = 0x83;
export const MAX_PAYMENT_INPUTS = 20;
export const MAX_ROYALTY_BPS = 5000;

export const SETTLEMENT_LAYOUT: SettlementLayout = Object.freeze({
  dummyCount: DUMMY_COUNT,
  inscriptionInput: INSCRIPTION_INPUT_INDEX,
  priceOutput: PRICE_OUTPUT_INDEX,
  inscriptionOutput: INSCRIPTION_OUTPUT_INDEX,
  sellerSighash: SIGHASH_SINGLE_ANYONECANPAY,
  minDummyValue: MIN_DUMMY_VALUE,
}) as SettlementLayout;

export type ScriptType = 'tr' | 'wpkh' | 'wsh' | 'pkh' | 'sh';

const big = (v: bigint | number, name: string): bigint => {
  if (typeof v === 'bigint') return v;
  if (!Number.isSafeInteger(v)) throw new RangeError(`${name} must be an integer number of sats`);
  return BigInt(v);
};

/** Validate a royalty rate: an integer in 0..5000 basis points (0..50 %). */
export function assertRoyaltyBps(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_ROYALTY_BPS)
    throw new RangeError(`royalty must be an integer in 0..${MAX_ROYALTY_BPS} basis points, got ${bps}`);
  return bps;
}

/** Royalty on a sale: floor(price × bps / 10 000). Never more than the rate, never negative. */
export function royaltyFor(priceSats: bigint | number, royaltyBps: number): bigint {
  const price = big(priceSats, 'price');
  if (price < 0n) throw new RangeError('price must be non-negative');
  const bps = BigInt(assertRoyaltyBps(royaltyBps));
  return (price * bps) / 10_000n;
}

/** What the buyer pays in total: price (to the seller) + royalty (to the treasury) + network fee. */
export function buyerCost(priceSats: bigint | number, royaltySats: bigint | number, feeSats: bigint | number): bigint {
  return big(priceSats, 'price') + big(royaltySats, 'royalty') + big(feeSats, 'fee');
}

/** Dust threshold per output type (Bitcoin Core policy at the default dust relay fee). */
export function dustFor(type: ScriptType): bigint {
  return type === 'tr' || type === 'wsh' ? 330n : type === 'wpkh' ? 294n : 546n;
}

/**
 * Virtual sizes, worst case: taproot key-path input with a 65-byte signature (sighash byte
 * present), P2WPKH with a 72-byte DER signature. Tests compare this estimate with real signed
 * transactions (never under, within a few vbytes).
 */
export const INPUT_VBYTES: Readonly<Record<ScriptType, number>> = Object.freeze({ tr: 57.75, wpkh: 68, wsh: 104, pkh: 148, sh: 91 });
export const OUTPUT_VBYTES: Readonly<Record<ScriptType, number>> = Object.freeze({ tr: 43, wpkh: 31, wsh: 43, pkh: 34, sh: 32 });
/** version + locktime + counts + segwit marker/flag. */
export const TX_OVERHEAD_VBYTES = 10.5;

export function estimateVsize(inputs: readonly ScriptType[], outputs: readonly ScriptType[]): number {
  let v = TX_OVERHEAD_VBYTES;
  for (const t of inputs) {
    const s = INPUT_VBYTES[t];
    if (s === undefined) throw new RangeError(`no size estimate for input type ${String(t)}`);
    v += s;
  }
  for (const t of outputs) {
    const s = OUTPUT_VBYTES[t];
    if (s === undefined) throw new RangeError(`no size estimate for output type ${String(t)}`);
    v += s;
  }
  return Math.ceil(v);
}

/**
 * ceil(vsize × feeRate) in exact decimal (feeRate up to 3 decimals), so 1.1 sat/vB × 1000 vB is
 * 1100, not 1101 as binary floating point would give.
 */
export function feeForVsize(vsize: number, feeRate: number): bigint {
  if (!Number.isSafeInteger(vsize) || vsize < 0) throw new RangeError('vsize must be a non-negative integer');
  if (!Number.isFinite(feeRate) || feeRate <= 0) throw new RangeError('feeRate must be a positive number');
  const milli = BigInt(Math.round(feeRate * 1000));
  const num = BigInt(vsize) * milli;
  return (num + 999n) / 1000n;
}

/** Map mempool.space `/v1/fees/recommended` to the three tiers offered in the UI (≥ minimum, ≥ 1). */
export function presetsFromMempool(rec: Partial<Record<'fastestFee' | 'halfHourFee' | 'hourFee' | 'economyFee' | 'minimumFee', unknown>> | null | undefined): FeesResponse {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const minimum = Math.max(1, n(rec?.minimumFee) ?? 1);
  const pick = (v: unknown, fallback: number) => Math.max(minimum, n(v) ?? fallback);
  return { economy: pick(rec?.economyFee, 2), normal: pick(rec?.halfHourFee, 5), fast: pick(rec?.fastestFee, 10), minimum };
}

/** Exact sats → BTC string with 8 decimals ("0.00050000"). */
export function satsToBtc(sats: bigint | number): string {
  const s = big(sats, 'sats');
  const neg = s < 0n;
  const a = neg ? -s : s;
  return `${neg ? '-' : ''}${a / 100_000_000n}.${(a % 100_000_000n).toString().padStart(8, '0')}`;
}

export function priceInWindow(priceSats: number, window: { priceMinSats: number; priceMaxSats: number }): boolean {
  return Number.isSafeInteger(priceSats) && priceSats >= window.priceMinSats && priceSats <= window.priceMaxSats;
}
