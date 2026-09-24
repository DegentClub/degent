/**
 * Quote maths. Everything goes through @bsh/inscription so the numbers are the same ones the
 * browser computes and the same ones the signed transaction will have (weight is exact).
 *
 * The TIER is the caller's (validated) choice by content bytes; the LANE is decided here from the
 * exact reveal weight (ADR-0005 §3). A Standard Degent that weighs > 400,000 WU gets `lane: 'block'`.
 */
import {
  addressToScript,
  commitAddress,
  estimateRevealWeight,
  laneFor,
  LIMITS,
  quoteReveal,
  type InscriptionContent,
  type Network,
} from '@bsh/inscription';
import type { Attribution } from '@bsh/inscription';
import type { CollectionConfig, Lane, PayoutScriptType, Quote, Tier } from '@bsh/degent-mint-sdk';
import { BLOCK_LANE_WEIGHT_BUDGET, computeRoyaltySplit, etaMinutesForPosition, laneForWeight, STANDARD_LANE_MAX_WEIGHT, tierRule } from '@bsh/degent-mint-sdk';
import { invalid } from './errors.js';

/** The studio slug carried in every Open Studio attribution (ord tag 5 metadata, plan §3.4). */
export const ATTRIBUTION_STUDIO = 'degent.club';

/** Open Studio facts a quote needs beyond the plain order (plan §3.1, §3.4). */
export interface ArtworkQuoteInput {
  artworkId: string;
  artistAddress: string;
  /** The edition reserved for this order: signed into the envelope, so it changes the weight and the commit address. */
  edition: number;
  payoutScriptType: PayoutScriptType;
  clubFeeBps: number;
  royaltyBps: number;
}

/** The attribution map for an artwork order (deterministic CBOR: same inputs, same envelope). */
export function attributionFor(a: Pick<ArtworkQuoteInput, 'artworkId' | 'artistAddress' | 'edition'>): Attribution {
  return { artist: a.artistAddress, artwork: a.artworkId, edition: a.edition, studio: ATTRIBUTION_STUDIO };
}

// One implementation of the maths: the SDK's lane thresholds must be the library's limits.
if (STANDARD_LANE_MAX_WEIGHT !== LIMITS.MAX_STANDARD_TX_WEIGHT || BLOCK_LANE_WEIGHT_BUDGET !== LIMITS.BLOCK_LANE_MAX_TX_WEIGHT)
  throw new Error('@bsh/degent-mint-sdk lane thresholds disagree with @bsh/inscription.LIMITS');

export interface QuoteInput {
  network: Network;
  config: CollectionConfig;
  tier: Tier;
  contentType: string;
  /** Exact bytes when known (binding quote); otherwise only the length (indicative quote). */
  body: Uint8Array | { length: number };
  parentId: string | null;
  collectionAddress: string;
  recipientAddress: string;
  revealPubkey: Uint8Array;
  feeRate: number;
  expiresAt: Date;
  /** Block lane: the 1-based block slot this order would land in (ADR-0005 §4). Ignored for the standard lane. */
  queuePosition: number | null;
  /** Open Studio: present on artwork orders; adds the attribution metadata and the club fee / royalty lines. */
  artwork?: ArtworkQuoteInput;
}

export function inscriptionContent(contentType: string, body: Uint8Array, parentId: string | null, attribution?: Attribution): InscriptionContent {
  return { contentType, body, ...(parentId ? { parentId } : {}), ...(attribution ? { attribution } : {}) };
}

/**
 * The envelope size depends only on body LENGTH, so an indicative quote from a zero-filled body
 * of the declared length has the same weight as the binding one. The commit address, however,
 * depends on the bytes and is only returned on the binding quote.
 */
export function computeQuote(q: QuoteInput): Quote {
  const rule = tierRule(q.tier, q.config);
  if (!rule) throw invalid(`unknown tier ${q.tier}`);
  const binding = q.body instanceof Uint8Array;
  const body = binding ? (q.body as Uint8Array) : new Uint8Array(q.body.length);
  const content = inscriptionContent(q.contentType, body, q.parentId, q.artwork ? attributionFor(q.artwork) : undefined);
  const collectionScript = addressToScript(q.collectionAddress, q.network);
  const recipientScript = addressToScript(q.recipientAddress, q.network);
  const revealWeight = estimateRevealWeight({
    content,
    withParent: true,
    recipientScript,
    parentReturnScript: collectionScript,
    parentInputScript: collectionScript,
  });
  const lane: Lane | null = laneFor(revealWeight);
  if (lane === null) throw invalid(`reveal weight ${revealWeight} WU exceeds every lane`, { revealWeight });
  if (laneForWeight(revealWeight) !== lane) throw new Error('lane maths disagree between the SDK and @bsh/inscription');
  const postage = BigInt(q.config.postageSats);
  const { revealVsize, revealFee, commitValue } = quoteReveal({ revealWeight, feeRate: q.feeRate, postage });
  // Artwork orders replace the flat per-tier service fee with the club fee (bps of the network cost) and add
  // the artist royalty; plain orders keep the flat fee and both extras are absent (plan §3.1).
  const serviceFeeSats = q.artwork ? 0 : q.config.serviceFeeSats[q.tier];
  const queuePosition = lane === 'block' ? q.queuePosition : null;
  const base: Quote = {
    tier: q.tier,
    lane,
    feeRate: q.feeRate,
    revealWeight,
    revealVsize,
    revealFeeSats: Number(revealFee),
    postageSats: q.config.postageSats,
    serviceFeeSats,
    commitValueSats: Number(commitValue),
    totalSats: Number(commitValue) + serviceFeeSats,
    commitAddress: binding ? commitAddress(q.revealPubkey, content, q.network).address : null,
    binding,
    expiresAt: q.expiresAt.toISOString(),
    queuePosition,
    etaMinutes: lane === 'block' ? etaMinutesForPosition(queuePosition) : null,
  };
  if (!q.artwork) return base;
  const split = computeRoyaltySplit({
    commitValueSats: Number(commitValue),
    clubFeeBps: q.artwork.clubFeeBps,
    royaltyBps: q.artwork.royaltyBps,
    payoutScriptType: q.artwork.payoutScriptType,
  });
  return {
    ...base,
    totalSats: split.totalSats,
    clubFeeSats: split.clubFeeSats,
    artistRoyaltySats: split.artistRoyaltySats,
    artistAddress: q.artwork.artistAddress,
    artworkId: q.artwork.artworkId,
    mintPriceSats: split.mintPriceSats,
    edition: q.artwork.edition,
    royaltyRaisedToDust: split.raisedToDust,
  };
}
