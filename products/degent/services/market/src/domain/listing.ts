/**
 * Listing and buy-session records, the public projection, and the settlement watcher's pure transition
 * function: `sold` is never a client call, it is derived from chain facts.
 *
 *   active  ─ outpoint spent by a tx paying the seller the price ─▶ sold
 *   active  ─ outpoint spent by anything else ───────────────────▶ invalid
 *   active  ─ ord: inscription moved / other owner / gone ───────▶ invalid
 *   active  ─ expiresAt passed ──────────────────────────────────▶ expired
 *   pending ─ spend visible (paying the seller the price) ───────▶ sold, otherwise invalid
 *   pending ─ nothing seen for PENDING_TIMEOUT_MS ───────────────▶ active (the purchase never appeared)
 */
import type { DegentRef, Listing, ListingStatus } from '@bsh/degent-market-sdk';
import { royaltyFor } from '@bsh/degent-market-sdk';
import type { ChainTx, Outspend } from '../ports/chain.js';
import type { InscriptionLocation } from '../ports/ord.js';
import type { SellerSignature } from './settlement/seller.js';

export interface ListingRecord {
  inscriptionId: string;
  inscriptionNumber: number | null;
  degent: DegentRef;
  contentType: string;
  outputValue: number;
  location: string;
  satOffset: number;
  priceSats: number;
  sellerAddress: string;
  sellerPublicKey: string;
  /** Seller's 0x83 signature on input #2. Wiped (null) once the listing is closed. Never returned. */
  sellerSignature: SellerSignature | null;
  status: ListingStatus;
  statusReason: string | null;
  settlementTxid: string | null;
  buyerAddress: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastCheckedAt: string | null;
  version: number;
}

export type BuySessionStatus = 'open' | 'broadcasting' | 'broadcast';

export interface BuySession {
  id: string;
  inscriptionId: string;
  buyerAddress: string;
  kind: 'buy' | 'dummies';
  psbtHex: string;
  buyerInputIndexes: number[];
  /** outpoint → value (decimal string) of every input, for the guard on the raw bytes. */
  prevouts: Array<[string, string]>;
  /** Buy sessions: what the guard asserts before broadcast. */
  guard: { satOffset: number; postage: number; buyerScriptHex: string } | null;
  status: BuySessionStatus;
  txid: string | null;
  createdAt: string;
  expiresAt: string;
}

export const TERMINAL: readonly ListingStatus[] = ['sold', 'invalid', 'expired', 'cancelled'];

export function toPublicListing(r: ListingRecord, royaltyBps: number): Listing {
  return {
    inscriptionId: r.inscriptionId,
    inscriptionNumber: r.inscriptionNumber,
    degent: r.degent,
    contentType: r.contentType,
    outputValue: r.outputValue,
    location: r.location,
    satOffset: r.satOffset,
    priceSats: r.priceSats,
    royaltySats: Number(royaltyFor(r.priceSats, royaltyBps)),
    sellerAddress: r.sellerAddress,
    status: r.status,
    statusReason: r.statusReason,
    settlementTxid: r.settlementTxid,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    expiresAt: r.expiresAt,
  };
}

export interface ChainFacts {
  /** null = the backend does not know the outpoint; undefined = not checked. */
  outspend: Outspend | null | undefined;
  spendingTx?: ChainTx | null;
  /** null = the indexer no longer knows it; undefined = not checked this round (indexer down). */
  inscription?: InscriptionLocation | null;
}

export interface Transition {
  status: ListingStatus;
  reason: string;
  txid?: string | null;
}

/** Pure transition function of the settlement watcher. Returns null when nothing changes. */
export function nextState(
  listing: Pick<ListingRecord, 'status' | 'location' | 'sellerAddress' | 'priceSats' | 'expiresAt' | 'updatedAt'>,
  facts: ChainFacts,
  opts: { now: Date; pendingTimeoutMs: number; sellerScriptHex?: string },
): Transition | null {
  const { outspend, spendingTx, inscription } = facts;
  if (outspend?.spent) {
    const paysSeller = !!spendingTx?.vout.some(
      (o) => (o.address === listing.sellerAddress || (opts.sellerScriptHex !== undefined && o.scriptHex === opts.sellerScriptHex)) && o.value === BigInt(listing.priceSats),
    );
    if (paysSeller) return { status: 'sold', reason: 'outpoint spent by a transaction paying the seller the listed price', txid: outspend.txid };
    if (spendingTx === undefined) return null; // spend seen but the spending tx could not be fetched: decide next round
    return { status: 'invalid', reason: 'inscription outpoint spent outside the marketplace', txid: outspend.txid };
  }
  if (inscription === null) return { status: 'invalid', reason: 'inscription no longer found in the indexer' };
  if (inscription) {
    if (inscription.outpoint !== listing.location) return { status: 'invalid', reason: `inscription moved to ${inscription.outpoint}` };
    if (inscription.address && inscription.address !== listing.sellerAddress) return { status: 'invalid', reason: `inscription now held by ${inscription.address}` };
  }
  const now = opts.now.getTime();
  if (listing.status === 'active' && Date.parse(listing.expiresAt) < now) return { status: 'expired', reason: 'listing expiry reached' };
  if (listing.status === 'pending' && now - Date.parse(listing.updatedAt) > opts.pendingTimeoutMs)
    return { status: 'active', reason: 'broadcast purchase never appeared; listing re-opened', txid: null };
  return null;
}
