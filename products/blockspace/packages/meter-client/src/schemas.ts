/**
 * Runtime guards for every Meter API response. Each schema is asserted (at compile time) to prove
 * exactly the interface in `types.ts`, so the two cannot drift apart silently.
 */
import { arr, bool, literal, nullable, num, obj, opt, str, type Guard, type Infer, type Same } from './guards.js';
import type * as T from './types.js';

const book = literal('a', 'b', 'c');
const denom = literal('bytes', 'vbytes');

const modeInfo = obj({ book: opt(book), denom: opt(denom), ladder: opt(arr(str)) });

export const tokenRow = obj({
  rn: num,
  token_id: num,
  protocol: str,
  ref: str,
  created_height: num,
  attributed: num,
  op_count: num,
  burned_height: opt(nullable(num)),
  a_bytes: opt(num),
  a_vbytes: opt(num),
  a_fees: opt(num),
  b_bytes: opt(num),
  b_vbytes: opt(num),
  c_bytes: opt(num),
  c_vbytes: opt(num),
  last_height: opt(num),
  current_supply: opt(nullable(num)),
  coverage: opt(str),
  op_mint: opt(num),
  op_transfer: opt(num),
  op_inscribe: opt(num),
});

export const tokenDetailRow = obj({
  token_id: num,
  protocol: str,
  ref: str,
  name: opt(nullable(str)),
  created_height: nullable(num),
  burned_height: nullable(num),
  a_bytes: num,
  a_vbytes: num,
  a_fees: num,
  b_bytes: num,
  b_vbytes: num,
  c_bytes: num,
  c_vbytes: num,
  op_count: num,
  last_height: num,
  current_supply: nullable(num),
  coverage: str,
  protocol_books: opt(str),
  protocol_note: opt(nullable(str)),
  claims: opt(num),
  attempts: opt(num),
});

export const tokensResponse = obj({
  total: num,
  rows: arr(tokenRow),
  book: opt(book),
  denom: opt(denom),
  sort: opt(str),
  protocol: opt(nullable(str)),
  q: opt(nullable(str)),
  limit: opt(num),
  offset: opt(num),
  mode: opt(modeInfo),
});

export const protocolRow = obj({
  protocol: str,
  tokens: num,
  attributed: num,
  books: opt(str),
  note: opt(str),
  book_measured: opt(str),
  attributed_vb: opt(num),
  a_bytes: opt(num),
  b_bytes: opt(num),
  c_bytes: opt(num),
});

export const protocolsResponse = obj({ rows: arr(protocolRow), book: opt(book), denom: opt(denom), mode: opt(modeInfo) });

export const blockDetail = obj({
  ledger: obj({
    height: num,
    time: num,
    n_tx: num,
    total_bytes: num,
    total_vbytes: num,
    total_weight: num,
    total_fees: num,
    block_hash: str,
  }),
  attributed: obj({
    claimed_bytes: num,
    carriage_bytes: num,
    burned_bytes: num,
    unclaimed_bytes: num,
    content_bytes: num,
    a_claimed_bytes: opt(num),
    b_claimed_bytes: opt(num),
    c_claimed_bytes: opt(num),
  }),
  protocols: arr(
    obj({
      protocol: str,
      a_bytes: num,
      b_bytes: num,
      c_bytes: num,
      a_vbytes: opt(num),
      fees: opt(num),
      content_bytes: opt(num),
    }),
  ),
});

export const growthResponse = obj({
  series: arr(
    obj({
      h: num,
      cum_a_bytes: num,
      chain_bytes: opt(num),
      chain_vbytes: opt(num),
      a_bytes: opt(num),
      c_bytes: opt(num),
      txs: opt(num),
      blocks: opt(num),
      t0: opt(num),
      t1: opt(num),
      cum_chain_bytes: opt(num),
      cum_chain_vbytes: opt(num),
      cum_c_bytes: opt(num),
    }),
  ),
  bucket: opt(num),
  frontier_height: opt(num),
  derive_height: opt(num),
  clipped_to: opt(num),
  last_bucket_partial: opt(bool),
});

const chainTip = obj({ height: num, source: opt(str) });

export const meterResponse = obj({
  chain_tip: chainTip,
  counted: opt(num),
  catalogued: opt(num),
  books_raw: opt(num),
  books_written: opt(num),
  counted_at: opt(str),
  catalogued_at: opt(str),
  books_at: opt(str),
  books_mode: opt(str),
  books_from: opt(num),
  tokens_through: opt(num),
  books_hash: opt(obj({ win_lo: opt(num), win_hi: opt(num), rows: opt(num), hash: opt(str) })),
});

const frontierCursor = obj({ name: opt(str), height: opt(num), updated_at: opt(str) });
export const frontierResponse = obj({ cursors: arr(frontierCursor) });

const bookTotals = obj({ bytes: opt(num), protocols: opt(num), measured_protocols: opt(num), complete: opt(bool) });

export const summaryResponse = obj({
  ledger: opt(
    obj({
      blocks_walked: opt(num),
      max_height: opt(num),
      chain_bytes: opt(num),
      chain_vbytes: opt(num),
      chain_fees: opt(num),
      chain_txs: opt(num),
    }),
  ),
  attributed_range: opt(
    obj({
      chain_bytes: opt(num),
      chain_vbytes: opt(num),
      chain_txs: opt(num),
      a_bytes: opt(num),
      b_bytes: opt(num),
      c_bytes: opt(num),
      blocks_touched: opt(num),
    }),
  ),
  books: opt(obj({ a: opt(bookTotals), b: opt(bookTotals), c: opt(bookTotals) })),
  tokens: opt(num),
  ops: opt(num),
  protocols_indexed: opt(num),
  attempts: opt(num),
  supply_deltas: opt(num),
  coverage_classes: opt(arr(obj({ coverage: opt(str), tokens: opt(num) }))),
  frontier: opt(obj({ cursors: opt(arr(frontierCursor)) })),
  chain_tip: opt(chainTip),
  attribution_frontier: opt(num),
  attribution_partial_to: opt(num),
  derive_height: opt(num),
});

export const landmarksResponse = obj({
  rows: arr(obj({ name: opt(str), height: opt(num), descr: opt(str), time: opt(num), walked: opt(bool) })),
});

// ---- compile-time lockstep between guards and interfaces --------------------------------------
type Assert<X extends true> = X;
type Strip<X> = X extends readonly (infer E)[] ? Strip<E>[] : X extends object ? { [K in keyof X as string extends K ? never : K]: Strip<X[K]> } : X;
type Check<G extends Guard<unknown>, I> = Same<Strip<Infer<G>>, Strip<I>>;
export type _Lockstep = [
  Assert<Check<typeof tokenRow, T.TokenRow>>,
  Assert<Check<typeof tokenDetailRow, T.TokenDetailRow>>,
  Assert<Check<typeof tokensResponse, T.TokensResponse>>,
  Assert<Check<typeof protocolsResponse, T.ProtocolsResponse>>,
  Assert<Check<typeof blockDetail, T.BlockDetail>>,
  Assert<Check<typeof growthResponse, T.GrowthResponse>>,
  Assert<Check<typeof meterResponse, T.MeterResponse>>,
  Assert<Check<typeof frontierResponse, T.FrontierResponse>>,
  Assert<Check<typeof summaryResponse, T.SummaryResponse>>,
  Assert<Check<typeof landmarksResponse, T.LandmarksResponse>>,
];
