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
  RescueInputs,
  SubmitRevealRequest,
} from '@bsh/degent-mint-sdk';

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
  createOrder(req: CreateOrderRequest): Promise<CreatedOrder>;
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

export type WalletId = 'unisat' | 'xverse' | 'leather' | 'okx' | 'magiceden';
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

export interface WalletSession {
  id: WalletId;
  name: string;
  network: Network;
  ordinals: WalletAccount;
  payment: WalletAccount;
  signPsbt(psbtBase64: string, req: SignPsbtRequest): Promise<SignPsbtResult>;
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
  wallets: WalletService;
  chain: ChainApi;
  inscription: InscriptionOps;
  images: ImageTools;
}
