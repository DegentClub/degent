/**
 * Response types of the live block.space Meter API (https://block.space/api/*).
 *
 * Ported from the tracker client (`skrybit-suite/tracker/src/types/blockspace.ts`), which is the only
 * written description of the API we have. Confirmation rule used here:
 *
 * - **Required** = the field is read by the tracker's shipped UI against the live API, or the tracker
 *   explicitly notes it was "confirmed live" (the flat `/api/token/<p>/<ref>` row).
 * - **Optional** (`?`) = documented by the tracker but not observed in use; we could not confirm it
 *   (the live API is not reachable from CI). Optional fields are still type-checked when present.
 *
 * Unknown extra fields are allowed everywhere (`[key: string]: unknown` where the tracker had it);
 * additive API changes are not drift.
 *
 * Books: A = attributed blockspace, B = (protocol-measured) book B, C = content bytes.
 * Denominations: `bytes` (raw serialized bytes) or `vbytes` (weight / 4).
 */

export type Book = 'a' | 'b' | 'c';
export type Denom = 'bytes' | 'vbytes';

export const BOOKS: readonly Book[] = ['a', 'b', 'c'];
export const DENOMS: readonly Denom[] = ['bytes', 'vbytes'];

/** The 21 protocols block.space attributes blockspace to (as of the tracker port). Rows use `string`. */
export const KNOWN_PROTOCOLS = [
  'sat',
  'rune',
  'brc20',
  'omni_property',
  'arc20',
  'xcp_asset',
  'tap',
  'alkane',
  'src20',
  'colu',
  'brc100',
  'openassets',
  'pipe',
  'atomicals-nft',
  'epobc',
  'spool_edition',
  'mezcal',
  'coinspark',
  'src101_name',
  'op20',
  'charms',
] as const;
export type Protocol = (typeof KNOWN_PROTOCOLS)[number];

export interface ModeInfo {
  book?: Book;
  denom?: Denom;
  /** Unit ladder, e.g. `["B","kB","MB","GB","TB","PB"]`. */
  ladder?: string[];
  [key: string]: unknown;
}

/** One row of `GET /api/tokens` (ranked list). */
export interface TokenRow {
  /** Rank within the requested sort. */
  rn: number;
  token_id: number;
  protocol: Protocol | string;
  ref: string;
  created_height: number;
  /** Attributed size in the requested book/denomination (the ranking value). */
  attributed: number;
  op_count: number;
  burned_height?: number | null;
  a_bytes?: number;
  a_vbytes?: number;
  a_fees?: number;
  b_bytes?: number;
  b_vbytes?: number;
  c_bytes?: number;
  c_vbytes?: number;
  last_height?: number;
  current_supply?: number | null;
  /** Books measured for this token, e.g. `"ABC"`. */
  coverage?: string;
  op_mint?: number;
  op_transfer?: number;
  op_inscribe?: number;
  [key: string]: unknown;
}

/**
 * `GET /api/token/<protocol>/<ref>`: the row flat (not wrapped), without the list-only `rn` /
 * `attributed`, plus protocol-adapter fields. Confirmed live by the tracker.
 */
export interface TokenDetailRow {
  token_id: number;
  protocol: Protocol | string;
  ref: string;
  name?: string | null;
  created_height: number | null;
  burned_height: number | null;
  a_bytes: number;
  a_vbytes: number;
  a_fees: number;
  b_bytes: number;
  b_vbytes: number;
  c_bytes: number;
  c_vbytes: number;
  op_count: number;
  last_height: number;
  current_supply: number | null;
  coverage: string;
  protocol_books?: string;
  protocol_note?: string | null;
  claims?: number;
  attempts?: number;
  [key: string]: unknown;
}

export interface TokensResponse {
  total: number;
  rows: TokenRow[];
  book?: Book;
  denom?: Denom;
  sort?: string;
  protocol?: string | null;
  q?: string | null;
  limit?: number;
  offset?: number;
  mode?: ModeInfo;
}

export interface ProtocolRow {
  protocol: string;
  tokens: number;
  attributed: number;
  /** Coverage string, e.g. `"ABC"`. */
  books?: string;
  note?: string;
  book_measured?: string;
  attributed_vb?: number;
  a_bytes?: number;
  b_bytes?: number;
  c_bytes?: number;
  [key: string]: unknown;
}

export interface ProtocolsResponse {
  rows: ProtocolRow[];
  book?: Book;
  denom?: Denom;
  mode?: ModeInfo;
}

export interface BlockLedger {
  height: number;
  /** Unix seconds. */
  time: number;
  n_tx: number;
  total_bytes: number;
  total_vbytes: number;
  total_weight: number;
  total_fees: number;
  block_hash: string;
}

export interface BlockAttributed {
  claimed_bytes: number;
  carriage_bytes: number;
  burned_bytes: number;
  unclaimed_bytes: number;
  content_bytes: number;
  a_claimed_bytes?: number;
  b_claimed_bytes?: number;
  c_claimed_bytes?: number;
}

export interface BlockProtocolSplit {
  protocol: string;
  a_bytes: number;
  b_bytes: number;
  c_bytes: number;
  a_vbytes?: number;
  fees?: number;
  content_bytes?: number;
}

/** `GET /api/block/<height>`. */
export interface BlockDetail {
  ledger: BlockLedger;
  attributed: BlockAttributed;
  protocols: BlockProtocolSplit[];
}

export interface GrowthPoint {
  /** Bucket start height. */
  h: number;
  cum_a_bytes: number;
  chain_bytes?: number;
  chain_vbytes?: number;
  a_bytes?: number;
  c_bytes?: number;
  txs?: number;
  blocks?: number;
  /** Unix seconds (bucket start / end). */
  t0?: number;
  t1?: number;
  cum_chain_bytes?: number;
  cum_chain_vbytes?: number;
  cum_c_bytes?: number;
}

export interface GrowthResponse {
  series: GrowthPoint[];
  bucket?: number;
  frontier_height?: number;
  derive_height?: number;
  clipped_to?: number;
  last_bucket_partial?: boolean;
}

export interface ChainTip {
  height: number;
  source?: string;
}

export interface BooksHash {
  win_lo?: number;
  win_hi?: number;
  rows?: number;
  hash?: string;
}

/** `GET /api/meter`: the index's own progress counters. */
export interface MeterResponse {
  chain_tip: ChainTip;
  counted?: number;
  catalogued?: number;
  books_raw?: number;
  books_written?: number;
  counted_at?: string;
  catalogued_at?: string;
  books_at?: string;
  books_mode?: string;
  books_from?: number;
  tokens_through?: number;
  books_hash?: BooksHash;
}

export interface FrontierCursor {
  name?: string;
  height?: number;
  updated_at?: string;
}

/** `GET /api/frontier`. Only the `cursors` container is assumed; see the module note. */
export interface FrontierResponse {
  cursors: FrontierCursor[];
}

export interface CoverageClass {
  coverage?: string;
  tokens?: number;
}

export interface BookTotals {
  bytes?: number;
  protocols?: number;
  measured_protocols?: number;
  complete?: boolean;
}

/** `GET /api/summary`. Not used by the tracker UI, so every field is unconfirmed (optional). */
export interface SummaryResponse {
  ledger?: {
    blocks_walked?: number;
    max_height?: number;
    chain_bytes?: number;
    chain_vbytes?: number;
    chain_fees?: number;
    chain_txs?: number;
  };
  attributed_range?: {
    chain_bytes?: number;
    chain_vbytes?: number;
    chain_txs?: number;
    a_bytes?: number;
    b_bytes?: number;
    c_bytes?: number;
    blocks_touched?: number;
  };
  books?: Partial<Record<Book, BookTotals>>;
  tokens?: number;
  ops?: number;
  protocols_indexed?: number;
  attempts?: number;
  supply_deltas?: number;
  coverage_classes?: CoverageClass[];
  frontier?: { cursors?: FrontierCursor[] };
  chain_tip?: ChainTip;
  attribution_frontier?: number;
  attribution_partial_to?: number;
  derive_height?: number;
}

export interface LandmarkRow {
  name?: string;
  height?: number;
  descr?: string;
  time?: number;
  walked?: boolean;
}

/** `GET /api/landmarks`. Only the `rows` container is assumed. */
export interface LandmarksResponse {
  rows: LandmarkRow[];
}
