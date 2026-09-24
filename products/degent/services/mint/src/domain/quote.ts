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
import type { CollectionConfig, Lane, Quote, Tier } from '@bsh/degent-mint-sdk';
import { BLOCK_LANE_WEIGHT_BUDGET, etaMinutesForPosition, laneForWeight, STANDARD_LANE_MAX_WEIGHT, tierRule } from '@bsh/degent-mint-sdk';
import { invalid } from './errors.js';

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
}

export function inscriptionContent(contentType: string, body: Uint8Array, parentId: string | null): InscriptionContent {
  return parentId ? { contentType, body, parentId } : { contentType, body };
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
  const content = inscriptionContent(q.contentType, body, q.parentId);
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
  const serviceFeeSats = q.config.serviceFeeSats[q.tier];
  const queuePosition = lane === 'block' ? q.queuePosition : null;
  return {
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
}
