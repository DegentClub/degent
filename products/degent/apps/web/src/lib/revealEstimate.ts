/**
 * Reveal size and fee for a design BEFORE an order exists, from @bsh/inscription (the same functions the mint
 * service quotes with; nothing is re-derived here). The envelope's weight depends only on the body LENGTH, the
 * content type, the parent id and the output scripts, so a zero-filled body of the right length is exact.
 * The binding quote still comes from the service once the bytes are uploaded.
 */
import { addressToScript, estimateRevealWeight, laneFor, quoteReveal, type Network } from '@bsh/inscription';

export interface RevealEstimateInput {
  contentType: string;
  bodyLength: number;
  parentId: string | null;
  network: Network;
  /** The minter's ordinals address; a P2TR script of the same length is assumed when unknown. */
  recipientAddress?: string | null;
  /** Output 0 of a parent-linked reveal (the collection address). */
  collectionAddress?: string | null;
  feeRate: number;
  postageSats: number;
}

export interface RevealEstimate {
  weight: number;
  vsize: number;
  feeSats: number;
  /** Reveal fee + postage: what the commit output must hold. */
  commitValueSats: number;
  lane: 'standard' | 'block' | null;
}

/** OP_1 <32 bytes>: the length of any P2TR output script. */
const P2TR_PLACEHOLDER = Uint8Array.from([0x51, 0x20, ...new Uint8Array(32)]);

function scriptOr(address: string | null | undefined, network: Network): Uint8Array | undefined {
  if (!address) return undefined;
  try {
    return addressToScript(address, network);
  } catch {
    return undefined;
  }
}

export function estimateReveal(i: RevealEstimateInput): RevealEstimate {
  const content = i.parentId
    ? { contentType: i.contentType, body: new Uint8Array(i.bodyLength), parentId: i.parentId }
    : { contentType: i.contentType, body: new Uint8Array(i.bodyLength) };
  const parentReturnScript = scriptOr(i.collectionAddress, i.network);
  const weight = estimateRevealWeight({
    content,
    withParent: !!i.parentId,
    recipientScript: scriptOr(i.recipientAddress, i.network) ?? P2TR_PLACEHOLDER,
    ...(parentReturnScript ? { parentReturnScript } : {}),
  });
  const q = quoteReveal({ revealWeight: weight, feeRate: i.feeRate, postage: BigInt(i.postageSats) });
  return { weight, vsize: q.revealVsize, feeSats: Number(q.revealFee), commitValueSats: Number(q.commitValue), lane: laneFor(weight) };
}
