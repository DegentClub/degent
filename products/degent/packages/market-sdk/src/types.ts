/**
 * Domain and wire types of the degent.club marketplace (contracts/openapi/degent-market.yaml,
 * contracts/asyncapi/degent-market.yaml). Amounts are integer sats as JSON numbers; timestamps are
 * ISO 8601 UTC; txids/keys are lowercase hex. Membership vocabulary (`MembershipVia`) and `Network`
 * come from the mint SDK so both products speak about Degents the same way.
 */
import type { MembershipVia, Network } from '@bsh/degent-mint-sdk';

export type { MembershipVia, Network };

/** Every status a listing can be in. Order is the contract order (OpenAPI, AsyncAPI, tests). */
export const LISTING_STATUSES = ['active', 'pending', 'sold', 'invalid', 'expired', 'cancelled'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** Statuses the settlement watcher keeps checking; also "already listed" for a new listing. */
export const OPEN_LISTING_STATUSES: readonly ListingStatus[] = ['active', 'pending'];

/**
 * Allowed transitions. `sold`/`invalid`/`expired`/`cancelled` are terminal for that listing row (the
 * inscription can be listed again as a new row). A `pending` listing cannot be cancelled: a purchase is
 * already on the wire; the watcher decides it.
 */
export const LISTING_TRANSITIONS: Readonly<Record<ListingStatus, readonly ListingStatus[]>> = {
  active: ['pending', 'sold', 'invalid', 'expired', 'cancelled'],
  pending: ['active', 'sold', 'invalid'],
  sold: [],
  invalid: [],
  expired: [],
  cancelled: [],
};

export function canTransition(from: ListingStatus, to: ListingStatus): boolean {
  return LISTING_TRANSITIONS[from].includes(to);
}

export type ChallengeAction = 'list' | 'cancel';
export type FeeTier = 'economy' | 'normal' | 'fast';
export const FEE_TIERS: readonly FeeTier[] = ['economy', 'normal', 'fast'];

export interface DegentRef {
  via: MembershipVia;
  /** Degent number (Gallery #1..4112 or a numbered child), null when not numbered yet. */
  n: number | null;
}

/** Public projection of a listing. Never carries the seller's signature or signed PSBT. */
export interface Listing {
  inscriptionId: string;
  inscriptionNumber: number | null;
  degent: DegentRef;
  contentType: string;
  /** Sats in the inscription UTXO (postage); the buyer receives exactly this output. */
  outputValue: number;
  /** `txid:vout` of the inscription UTXO. */
  location: string;
  /** Offset of the inscribed sat inside that UTXO. */
  satOffset: number;
  /** What the seller receives (output #2). */
  priceSats: number;
  /** Royalty the buyer pays on top, at the royalty rate in force when the listing was read. */
  royaltySats: number;
  sellerAddress: string;
  status: ListingStatus;
  statusReason: string | null;
  settlementTxid: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ListingsResponse {
  items: Listing[];
  total: number;
}

/** The fixed purchase layout (docs/SETTLEMENT.md). Published so the front end can explain it. */
export interface SettlementLayout {
  dummyCount: 2;
  inscriptionInput: 2;
  priceOutput: 2;
  inscriptionOutput: 1;
  /** SIGHASH_SINGLE | SIGHASH_ANYONECANPAY. */
  sellerSighash: 131;
  minDummyValue: number;
}

export interface MarketConfig {
  network: Network;
  buysEnabled: boolean;
  royaltyBps: number;
  treasuryAddress: string | null;
  priceMinSats: number;
  priceMaxSats: number;
  listingMaxDays: number;
  /** Value of each padding UTXO created by the dummy round. */
  dummyValueSats: number;
  layout: SettlementLayout;
  /** Prefix for explorer links: `${explorerTxUrl}/<txid>`. */
  explorerTxUrl: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  network: Network;
  buysEnabled: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export interface FeesResponse {
  economy: number;
  normal: number;
  fast: number;
  minimum: number;
}

export interface ChallengeRequest {
  action: ChallengeAction;
  address: string;
  inscriptionId: string;
  /** Required for `list`: the challenge binds the price. */
  priceSats?: number;
}

export interface ChallengeResponse {
  /** SIWB message to sign with BIP-322 simple (UniSat: `signMessage(message, 'bip322-simple')`). */
  message: string;
  expiresAt: string;
}

export interface PrepareListingRequest {
  inscriptionId: string;
  sellerAddress: string;
  /** 33-byte compressed public key (hex) from the wallet. */
  sellerPublicKey: string;
  priceSats: number;
}

export interface ToSignInput {
  index: number;
  address: string;
  sighashTypes?: number[];
}

export interface PrepareListingResponse {
  psbtHex: string;
  psbtBase64: string;
  signIndex: 2;
  sighashType: 131;
  toSignInputs: ToSignInput[];
  inscription: { outpoint: string; offset: number; value: number; contentType: string; number: number | null };
}

export interface CreateListingRequest extends PrepareListingRequest {
  expiresInDays?: number;
  /** Seller-signed template PSBT (hex or base64). */
  signedPsbt: string;
  /** The `list` challenge message and its BIP-322 signature (base64). */
  message: string;
  signature: string;
}

export interface CreateListingResponse {
  listing: Listing;
}

export interface CancelListingRequest {
  sellerAddress: string;
  message: string;
  signature: string;
}

export interface BuyPrepareRequest {
  inscriptionId: string;
  buyerAddress: string;
  buyerPublicKey: string;
  feeTier?: FeeTier;
  /** Every outpoint the wallet reports as carrying an inscription; never spent as payment. */
  excludeOutpoints?: string[];
}

export type TxParty = 'buyer' | 'seller' | 'treasury';
export type InputRole = 'dummy' | 'inscription' | 'payment';
export type OutputRole = 'dummy_merge' | 'inscription' | 'price' | 'royalty' | 'change' | 'dummy';

/** One input of the real transaction the buyer signs. */
export interface TxInputView {
  index: number;
  outpoint: string;
  value: number;
  address: string;
  owner: TxParty;
  role: InputRole;
  /** True when the buyer's wallet must sign it. */
  buyerSigns: boolean;
}

/** One output of the real transaction the buyer signs. */
export interface TxOutputView {
  index: number;
  value: number;
  address: string;
  owner: TxParty;
  role: OutputRole;
}

export interface BuySummary {
  priceSats: number;
  royaltySats: number;
  feeSats: number;
  feeRate: number;
  vsize: number;
  changeSats: number;
  postageSats: number;
  totalBuyerCostSats: number;
  inputs: TxInputView[];
  outputs: TxOutputView[];
}

export interface DummySummary {
  feeSats: number;
  feeRate: number;
  changeSats: number;
  dummyCount: number;
  dummyValueSats: number;
  inputs: TxInputView[];
  outputs: TxOutputView[];
}

interface BuyPrepareBase {
  sessionId: string;
  expiresAt: string;
  psbtHex: string;
  psbtBase64: string;
  toSignInputs: ToSignInput[];
  note: string;
}

export interface BuyPrepareBuy extends BuyPrepareBase {
  kind: 'buy';
  summary: BuySummary;
  /** Where ord's FIFO rule puts the inscription (asserted server side: always output 1, the buyer's). */
  inscriptionDestination: { vout: number; offset: number };
}

export interface BuyPrepareDummies extends BuyPrepareBase {
  kind: 'dummies';
  summary: DummySummary;
}

export type BuyPrepareResponse = BuyPrepareBuy | BuyPrepareDummies;

export interface BuySubmitRequest {
  sessionId: string;
  signedPsbt: string;
}

export interface BuySubmitResponse {
  txid: string;
  kind: 'buy' | 'dummies';
  vsize: number;
  feeSats: number;
  explorerUrl: string;
}

export const MARKET_ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unsupported_media_type',
  'payload_too_large',
  'not_found',
  'conflict',
  'forbidden_origin',
  'rate_limited',
  'internal',
  'not_a_degent',
  'not_owner',
  'not_seller',
  'already_listed',
  'listing_invalid',
  'listing_not_active',
  'listing_expired',
  'own_listing',
  'auth_failed',
  'buys_paused',
  'insufficient_funds',
  'need_dummies',
  'bad_psbt',
  'bad_seller_signature',
  'inscription_misrouted',
  'session_closed',
  'session_expired',
  'upstream_unavailable',
  'broadcast_rejected',
] as const;
export type MarketErrorCode = (typeof MARKET_ERROR_CODES)[number];

/** Why a listing is not (or no longer) valid, carried in `details.reason` of `listing_invalid`. */
export type ListingInvalidReason = 'unknown_outpoint' | 'spent' | 'not_indexed' | 'moved' | 'wrong_owner';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** `degent.market.listing.{status}` payload (contracts/asyncapi/degent-market.yaml). */
export interface ListingStatusEvent {
  /** `degent.market.listing.<status>`; equals the routing key. */
  type: `degent.market.listing.${ListingStatus}`;
  /** `<inscriptionId>:<listing createdAt epoch ms>:<listing version>`: stable across redeliveries. */
  eventId: string;
  inscriptionId: string;
  network: Network;
  status: ListingStatus;
  /** Null only for the creation event (`active`). */
  previousStatus: ListingStatus | null;
  at: string;
  priceSats: number;
  sellerAddress: string;
  /** Human-readable context (never PSBTs, signatures or keys). */
  reason?: string;
  /** Spending txid on `pending` (our broadcast), `sold` and chain-driven `invalid`. */
  txid?: string;
}
