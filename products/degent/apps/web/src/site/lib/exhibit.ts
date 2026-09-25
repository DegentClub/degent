/**
 * Full Block Exhibit maths and data shaping (pure, no I/O, no React).
 *
 * A "Full Block Degent" is a Degent whose CONTENT is at least the mint SDK's `fullblock` tier
 * minimum (`FULLBLOCK_MIN_BYTES`, 3.5 MB). Its reveal transaction is a single inscription envelope
 * that fills nearly a whole Bitcoin block: the block-weight consensus limit is 4,000,000 WU
 * (`@bsh/inscription` `LIMITS.MAX_BLOCK_WEIGHT`), a witness byte weighs 1 WU, so ~3.96 MB of witness
 * data lands one artwork in one block — by construction one per block (ADR-0005 §3-§4).
 *
 * THE MATHS IS NOT RE-DERIVED HERE. Reveal weight comes from `@bsh/inscription.estimateRevealWeight`
 * (the exact serializer the mint quotes and the service enforces); vsize from `vsizeFromWeight`;
 * the lane from `laneFor`; the tier threshold from `@bsh/degent-mint-sdk`. The only thing this module
 * adds is the museum framing: given an item's on-chain content length, estimate the reveal weight and
 * express it as a fraction of one block.
 *
 * WHAT IS ESTIMATED. Historical Degents were inscribed before this mint service existed; we do not
 * have their exact reveal transactions, only the content length (from the certification list or the
 * bundled manifest). So the reveal weight here is an ESTIMATE from the content length assuming a
 * single-input single-output reveal of a JPEG envelope; it is labelled `estimated: true` everywhere.
 * Content bytes and (when ord provides them) block height and fee are the recorded facts.
 */
import {
  estimateRevealWeight,
  laneFor,
  vsizeFromWeight,
  LIMITS,
  type Lane,
} from '@bsh/inscription';
import { FULLBLOCK_MIN_BYTES, FULLBLOCK_MAX_BYTES } from '@bsh/degent-mint-sdk';
import type { CollectionItem } from '../services/types';

/** Consensus block-weight limit (WU): the whole point of the exhibit. */
export const BLOCK_WEIGHT_LIMIT = LIMITS.MAX_BLOCK_WEIGHT; // 4,000,000

export { FULLBLOCK_MIN_BYTES, FULLBLOCK_MAX_BYTES };

/** The content type every Degent is inscribed as (the collection is square JPEG). */
const DEGENT_CONTENT_TYPE = 'image/jpeg';

/** A dummy 34-byte P2TR scriptPubKey (OP_1 <32 zero bytes>): only its length feeds the sizing. */
const P2TR_RECIPIENT = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32));

/** Content length in bytes from a collection item's `size_kb` (manifest kB, decimal). Null when unknown. */
export function contentBytesOf(item: Pick<CollectionItem, 'size_kb'>): number | null {
  return typeof item.size_kb === 'number' && Number.isFinite(item.size_kb) ? Math.round(item.size_kb * 1000) : null;
}

/**
 * Is this a Full Block Degent for the exhibit? Content bytes at or above the `fullblock` tier
 * minimum. Historical items may exceed the tier's *upper* bound (the mint reserves headroom for new
 * mints; the chain itself only caps the block), so we do not use `tierForSize` (which would drop the
 * very largest, block-filling items) — we use the tier floor from the SDK.
 */
export function isFullBlock(item: Pick<CollectionItem, 'size_kb'>): boolean {
  const b = contentBytesOf(item);
  return b !== null && b >= FULLBLOCK_MIN_BYTES;
}

/** The Full Block Degents in a membership list, largest first (the biggest fills the most block). */
export function fullBlockItems(items: readonly CollectionItem[]): CollectionItem[] {
  return items.filter(isFullBlock).sort((a, b) => (contentBytesOf(b) ?? 0) - (contentBytesOf(a) ?? 0));
}

export interface RevealEstimate {
  /** Estimated reveal weight (WU) of the single-envelope reveal for this content length. */
  weight: number;
  /** ceil(weight / 4). */
  vsize: number;
  /** Transport lane at this weight (`block` for every Full Block Degent). */
  lane: Lane | null;
  /** weight / 4,000,000, clamped to [0, 1]. */
  fraction: number;
}

const weightCache = new Map<number, number>();

/** Estimated reveal weight for `contentBytes` of JPEG content (memoised; the sizing reads only the length). */
export function estimateWeightForContent(contentBytes: number): number {
  if (!Number.isInteger(contentBytes) || contentBytes < 0) throw new RangeError(`contentBytes must be a non-negative integer: ${contentBytes}`);
  let w = weightCache.get(contentBytes);
  if (w === undefined) {
    w = estimateRevealWeight({
      content: { contentType: DEGENT_CONTENT_TYPE, body: new Uint8Array(contentBytes) },
      withParent: false,
      recipientScript: P2TR_RECIPIENT,
    });
    weightCache.set(contentBytes, w);
  }
  return w;
}

export function blockFraction(weight: number): number {
  return Math.max(0, Math.min(1, weight / BLOCK_WEIGHT_LIMIT));
}

/** Full reveal estimate for a content length. */
export function estimateReveal(contentBytes: number): RevealEstimate {
  const weight = estimateWeightForContent(contentBytes);
  return { weight, vsize: vsizeFromWeight(weight), lane: laneFor(weight), fraction: blockFraction(weight) };
}

/** The reveal txid of a `<txid>i<index>` inscription id (index 0 for every Degent): the txid part. */
export function revealTxidOf(inscriptionId: string): string | null {
  const m = /^([0-9a-f]{64})i\d+$/i.exec(inscriptionId);
  return m ? m[1]!.toLowerCase() : null;
}

/** Fee rate a reveal paid, sat/vB, from its recorded fee and estimated vsize. Null when fee unknown. */
export function feeRateFromFee(feeSats: number | null | undefined, vsize: number): number | null {
  if (typeof feeSats !== 'number' || !Number.isFinite(feeSats) || feeSats < 0 || !(vsize > 0)) return null;
  return feeSats / vsize;
}

// ------------------------------------------------------------------ links

export interface ExhibitLinks {
  ordinals: string;
  ordiscan: string;
  magicEden: string;
  /** block.space Transaction X-Ray on the reveal tx (ADR-0008). Null when the txid is unparseable. */
  xray: string | null;
  /** block.space Block Theater at the inscription's block (ADR-0008). Null when the height is unknown. */
  theater: string | null;
}

export interface LinkBases {
  /** ord explorer base, e.g. https://ordinals.com */
  ordinals: string;
  /** Magic Eden collection/item base host (item-details path is appended). */
  magicEden?: string;
  /** block.space base for X-Ray / Theater (ADR-0008 tools). */
  blockspace: string;
}

export function exhibitLinks(item: Pick<CollectionItem, 'id'>, height: number | null, bases: LinkBases): ExhibitLinks {
  const txid = revealTxidOf(item.id);
  const bs = bases.blockspace.replace(/\/+$/, '');
  return {
    ordinals: `${bases.ordinals.replace(/\/+$/, '')}/inscription/${item.id}`,
    ordiscan: `https://ordiscan.com/inscription/${item.id}`,
    magicEden: `${(bases.magicEden ?? 'https://magiceden.io').replace(/\/+$/, '')}/ordinals/item-details/${item.id}`,
    xray: txid ? `${bs}/xray/${txid}` : null,
    theater: height !== null ? `${bs}/theater?block=${height}` : null,
  };
}

// ------------------------------------------------------------------ machine-native shapes (JSON twin + index)

/** The recorded on-chain facts an exhibit item exposes (some null until ord is read). */
export interface ExhibitFacts {
  /** ISO 8601 timestamp of the inscription, when known. */
  timestamp: string | null;
  /** Block height the reveal confirmed in, when known. */
  height: number | null;
  /** Fee the reveal paid, in sats, when known. */
  feeSats: number | null;
  /** Address that holds the inscription now, when known. */
  address: string | null;
  /** Content type reported by ord, when known. */
  contentType: string | null;
}

export interface ExhibitItemJson {
  number: number;
  id: string;
  name: string;
  tier: 'fullblock';
  lane: Lane;
  /** Recorded content length in bytes (from the certified/bundled size). */
  contentBytes: number;
  /** ESTIMATED reveal weight in WU (`estimated` is always true for historical items). */
  revealWeightWU: number;
  revealVsize: number;
  /** Consensus block-weight limit this is measured against. */
  blockWeightLimitWU: number;
  /** revealWeightWU / blockWeightLimitWU, 0..1. */
  blockFraction: number;
  /** Estimated fee rate (sat/vB) from a recorded fee, else null. */
  feeRate: number | null;
  facts: ExhibitFacts;
  /** True: reveal weight/vsize/fraction are estimated from the content length, not read on chain. */
  estimated: boolean;
  links: ExhibitLinks;
}

export const EMPTY_FACTS: ExhibitFacts = { timestamp: null, height: null, feeSats: null, address: null, contentType: null };

/** Build the machine-native item twin. `facts` come from ord (or empty for the index/offline twin). */
export function exhibitItemJson(item: CollectionItem, bases: LinkBases, facts: ExhibitFacts = EMPTY_FACTS): ExhibitItemJson {
  const contentBytes = contentBytesOf(item) ?? 0;
  const est = estimateReveal(contentBytes);
  const links = exhibitLinks(item, facts.height, bases);
  return {
    number: item.number,
    id: item.id,
    name: item.name,
    tier: 'fullblock',
    lane: 'block',
    contentBytes,
    revealWeightWU: est.weight,
    revealVsize: est.vsize,
    blockWeightLimitWU: BLOCK_WEIGHT_LIMIT,
    blockFraction: est.fraction,
    feeRate: feeRateFromFee(facts.feeSats, est.vsize),
    facts,
    estimated: true,
    links,
  };
}

export interface ExhibitIndexJson {
  collection: string;
  /** 'certified' when the membership came from block.space certification, else 'bundled' (demo/uncertified). */
  source: 'certified' | 'bundled';
  /** True only when `source === 'certified'`. */
  certified: boolean;
  blockWeightLimitWU: number;
  fullBlockTierMinBytes: number;
  count: number;
  /** All Full Block Degents, largest first. Facts are empty in the offline index (read per item from ord). */
  items: ExhibitItemJson[];
}

export function exhibitIndexJson(list: { source: 'certified' | 'bundled'; items: readonly CollectionItem[] }, bases: LinkBases): ExhibitIndexJson {
  const items = fullBlockItems(list.items).map((it) => exhibitItemJson(it, bases));
  return {
    collection: 'degents',
    source: list.source,
    certified: list.source === 'certified',
    blockWeightLimitWU: BLOCK_WEIGHT_LIMIT,
    fullBlockTierMinBytes: FULLBLOCK_MIN_BYTES,
    count: items.length,
    items,
  };
}
