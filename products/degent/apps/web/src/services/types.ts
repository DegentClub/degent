/**
 * Ports: every external interaction of the front end goes through one of these small interfaces.
 * Real adapters live in `./real/*` (delegating to @bsh/degent-mint-sdk, @bsh/wallet-kit,
 * @bsh/inscription, esplora and the browser canvas); fakes live in `./fakes.ts` and power the
 * tests and `?demo=1`.
 */
import type {
  ServiceConfig,
  CreateOrderRequest,
  Network,
  Order,
  Quote,
  RescueInputs,
  SubmitRevealRequest,
} from '@bsh/degent-mint-sdk';
import type { StudioApi } from './studioApi';
import type { CertifyApi } from './certifyApi';
import type { OrdApi } from './ordApi';

export type { StudioApi } from './studioApi';
export type { CertifyApi } from './certifyApi';
export type { OrdApi } from './ordApi';

// ---------------------------------------------------------------- studio artworks in mint orders (plan §3.1)

/**
 * The mint contract is gaining these fields for studio artwork orders (plan §3.1, ADR-0007 §5).
 * They are OPTIONAL on the wire and read defensively here: an order without them is a plain
 * self-made Degent and renders exactly as before.
 */
export interface ArtworkQuoteFields {
  /** The club's share, output [2] of the funding transaction. */
  clubFeeSats: number;
  /** The artist's royalty, output [1] of the funding transaction (never a reveal output). */
  artistRoyaltySats: number;
  /** The artist's proven payout address (ADR-0007 §3). */
  artistAddress: string;
  artworkId: string;
  mintPriceSats: number;
  /** Edition number reserved at quote time (plan §3.4). */
  edition: number;
}

export interface ArtworkOrderFields {
  artworkId: string;
  artistAddress: string;
  artistRoyaltySats: number;
  clubFeeSats: number;
  edition: number;
  /** Set by the mint once it verified output [1] of the funding transaction. */
  royaltyPaid: { txid: string; vout: number; sats: number };
}

export type QuoteExt = Quote & Partial<ArtworkQuoteFields>;
export type OrderExt = Order & Partial<ArtworkOrderFields>;
export type CreateOrderRequestExt = CreateOrderRequest & { artworkId?: string };

const isSats = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The four-line breakdown facts, or null when the quote is for a self-made Degent. */
export function artworkQuote(q: Quote | null | undefined): {
  clubFeeSats: number;
  artistRoyaltySats: number;
  artistAddress: string | null;
  artworkId: string | null;
  mintPriceSats: number | null;
  edition: number | null;
} | null {
  if (!q) return null;
  const x = q as QuoteExt;
  if (!isSats(x.clubFeeSats) || !isSats(x.artistRoyaltySats)) return null;
  return {
    clubFeeSats: x.clubFeeSats,
    artistRoyaltySats: x.artistRoyaltySats,
    artistAddress: typeof x.artistAddress === 'string' && x.artistAddress.length > 0 ? x.artistAddress : null,
    artworkId: typeof x.artworkId === 'string' ? x.artworkId : null,
    mintPriceSats: isSats(x.mintPriceSats) ? x.mintPriceSats : null,
    edition: typeof x.edition === 'number' && Number.isSafeInteger(x.edition) ? x.edition : null,
  };
}

/** `order.royaltyPaid` when the mint has verified the artist's output. */
export function royaltyPaidOf(o: Order | null | undefined): { txid: string; vout: number; sats: number } | null {
  const r = (o as OrderExt | null | undefined)?.royaltyPaid;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.txid !== 'string' || !/^[0-9a-f]{64}$/.test(r.txid) || !Number.isSafeInteger(r.vout) || !isSats(r.sats)) return null;
  return { txid: r.txid, vout: r.vout, sats: r.sats };
}

export function orderArtworkId(o: Order | null | undefined): string | null {
  const id = (o as OrderExt | null | undefined)?.artworkId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function orderEdition(o: Order | null | undefined): number | null {
  const e = (o as OrderExt | null | undefined)?.edition ?? artworkQuote(o?.quote)?.edition ?? null;
  return typeof e === 'number' && Number.isSafeInteger(e) ? e : null;
}

// ---------------------------------------------------------------- mint service

export interface FeeSnapshot {
  /** sat/vB */
  economy: number;
  normal: number;
  priority: number;
  /** Floor enforced by the service (sat/vB). */
  minimum: number;
  /** Recommended rate for the block lane (Block Degents), when the service offers one. */
  blockRecommended?: number;
  updatedAt?: string;
}

export interface QueueSnapshot {
  /** Block Degents waiting for their own block, including the one being revealed. */
  blockLaneLength: number;
  /** Minutes until a Block Degent ordered now would be revealed (position x ~10 min). */
  blockLaneEtaMinutes: number;
  /** Standard Degents currently queued (many fit in one block). */
  standardLaneLength: number;
  updatedAt?: string;
}

export interface RescueTx {
  hex: string;
  txid: string;
  /** Exact weight (WU) and fee (sats) of the re-signed rescue. */
  weight: number;
  fee: bigint;
}

/**
 * POST /v1/orders returns a random `orderToken` exactly once. It authorises the order's mutating
 * calls (`Authorization: Bearer <token>`). The front end keeps it in memory and persists it ONLY
 * inside the local recovery bundle. Never in URLs, never in logs.
 */
export interface CreatedOrder {
  order: Order;
  orderToken: string;
}

export interface MintApi {
  getConfig(): Promise<ServiceConfig>;
  getFees(): Promise<FeeSnapshot>;
  getQueue(): Promise<QueueSnapshot>;
  /** With `artworkId` (plan §3.1) the bytes come from the studio; the service may skip the upload. */
  createOrder(req: CreateOrderRequestExt): Promise<CreatedOrder>;
  /** PUT /v1/orders/{id}/content (application/octet-stream). Starts the automated art review. */
  uploadContent(orderId: string, orderToken: string, bytes: Uint8Array): Promise<Order>;
  /** POST /v1/orders/{id}/reveal with the half-signed reveal. */
  submitReveal(orderId: string, orderToken: string, req: SubmitRevealRequest): Promise<Order>;
  getOrder(orderId: string): Promise<Order>;
  /**
   * GET /v1/orders/{id}/rescue (ADR-0005 §2): the INPUTS for a parent-less rescue. The transaction
   * itself is built and signed here, in the browser, with K_e from the recovery bundle.
   */
  getRescue(orderId: string, orderToken: string): Promise<RescueInputs>;
}

// ---------------------------------------------------------------- wallet

/** Wallet ids are the wallet-kit's (the registry grows there, e.g. `xcp`, `horizon`). */
export type WalletId = import('@bsh/wallet-kit').WalletId;
export type AddressType = 'p2tr' | 'p2wpkh' | 'p2sh-p2wpkh' | 'p2pkh' | 'unknown';

export interface WalletAccount {
  address: string;
  publicKey: string;
  addressType: AddressType;
}

export interface WalletOption {
  id: WalletId;
  name: string;
  installed: boolean;
  installUrl: string;
  icon?: string;
}

export interface SignPsbtRequest {
  inputsToSign: Array<{ index: number; address: string }>;
  finalize: boolean;
  broadcast: boolean;
}

export interface SignPsbtResult {
  psbtBase64: string;
  txid?: string;
}

export type MessageSignatureType = 'bip322-simple' | 'ecdsa';

export interface WalletSession {
  id: WalletId;
  name: string;
  network: Network;
  ordinals: WalletAccount;
  payment: WalletAccount;
  signPsbt(psbtBase64: string, req: SignPsbtRequest): Promise<SignPsbtResult>;
  /**
   * Sign a text message with one of the wallet's own addresses (Sign-in-with-Bitcoin and the payout
   * proof, ADR-0007 §2-3). BIP-322 simple by default; base64 signature.
   */
  signMessage?(message: string, address: string, type?: MessageSignatureType): Promise<string>;
  pushTx?(hex: string): Promise<string>;
  disconnect(): Promise<void>;
}

export interface WalletService {
  list(): WalletOption[];
  connect(id: WalletId, network: Network): Promise<WalletSession>;
}

// ---------------------------------------------------------------- chain (esplora + ord)

export interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

export interface ChainApi {
  /** esplora `GET /address/:addr/utxo` */
  getUtxos(address: string): Promise<Utxo[]>;
  /** esplora `POST /tx` (raw hex body) → txid */
  broadcast(hex: string): Promise<string>;
  /** ord `GET /content/:id` → exact inscribed bytes */
  getInscriptionContent(inscriptionId: string): Promise<Uint8Array>;
  /** URL of the on-chain rendering */
  contentUrl(inscriptionId: string): string;
}

// ---------------------------------------------------------------- inscription maths

export interface InscriptionContentInput {
  contentType: string;
  body: Uint8Array;
  parentId?: string;
}

export interface EphemeralKey {
  privkey: Uint8Array;
  pubkeyHex: string;
}

export interface InscriptionOps {
  generateEphemeralKey(): EphemeralKey;
  commitAddress(pubkeyHex: string, content: InscriptionContentInput, network: Network): string;
  /**
   * Exact weight (WU) of the parent-linked reveal for this content and recipient. The lane is decided
   * from it (`laneForWeight`), so the UI can say before the quote that a 397-400 KB Standard Degent
   * travels the block lane (ADR-0005 §3).
   */
  revealWeight(content: InscriptionContentInput, recipientAddress: string, network: Network): number;
  /**
   * ADR-0005 §1: `[commit] -> [parent return, child]`, commit input signed SIGHASH_ALL|ANYONECANPAY
   * (0x81). `parentReturnAddress` / `parentValue` come from GET /v1/config and are signed up front.
   */
  buildHalfSignedReveal(args: {
    network: Network;
    revealPrivkey: Uint8Array;
    content: InscriptionContentInput;
    commitOutpoint: { txid: string; vout: number };
    commitValue: bigint;
    recipientAddress: string;
    postage: bigint;
    parentReturnAddress: string;
    parentValue: bigint;
  }): { psbtBase64: string };
  /**
   * ADR-0005 §2: self-rescue by re-signing `[commit] -> [child]` with K_e (SIGHASH_DEFAULT). K_e only
   * ever controls the user's own commit output.
   */
  buildResignedRescue(args: {
    network: Network;
    revealPrivkey: Uint8Array;
    content: InscriptionContentInput;
    commitOutpoint: { txid: string; vout: number };
    commitValue: bigint;
    recipientAddress: string;
    postage: bigint;
  }): RescueTx;
  sha256Hex(bytes: Uint8Array): string;
}

// ---------------------------------------------------------------- images

export type EncodeType = 'image/webp' | 'image/jpeg' | 'image/png';

export interface SourceImage {
  width: number;
  height: number;
  /** Opaque decoded handle (ImageBitmap in the browser). */
  handle: unknown;
}

export interface EncodedImage {
  blob: Blob;
  width: number;
  height: number;
}

export interface ImageTools {
  decode(blob: Blob): Promise<SourceImage>;
  encode(src: SourceImage, opts: { type: EncodeType; quality: number; scale: number }): Promise<EncodedImage>;
  /** A generated sample for demo mode (not the real brief art). */
  sample?(): Promise<Blob>;
}

// ---------------------------------------------------------------- bundle

export interface Services {
  mode: 'live' | 'demo';
  mintApi: MintApi;
  /** The Artist Studio (ADR-0007): gallery, sign-in, artworks, royalties. */
  studio: StudioApi;
  /** block.space collection certification: the ONE source of every count on the site (site spec). */
  certify: CertifyApi;
  /** ord reads for the collection lightbox (owner, timestamp, fee) and member images. */
  ord: OrdApi;
  wallets: WalletService;
  chain: ChainApi;
  inscription: InscriptionOps;
  images: ImageTools;
}
