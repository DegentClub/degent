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
}

export interface MintApi {
  getConfig(): Promise<ServiceConfig>;
  getFees(): Promise<FeeSnapshot>;
  getQueue(): Promise<QueueSnapshot>;
  createOrder(req: CreateOrderRequest): Promise<Order>;
  /** PUT /v1/orders/{id}/content (application/octet-stream). Starts the automated art review. */
  uploadContent(orderId: string, bytes: Uint8Array, contentType: string): Promise<Order>;
  /** POST /v1/orders/{id}/reveal with the half-signed reveal. */
  submitReveal(orderId: string, req: SubmitRevealRequest): Promise<Order>;
  getOrder(orderId: string): Promise<Order>;
  /** GET /v1/orders/{id}/rescue: the parent-less [commit] -> [child] reveal, fully signed. */
  getRescue(orderId: string): Promise<RescueTx>;
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
  buildHalfSignedReveal(args: {
    network: Network;
    revealPrivkey: Uint8Array;
    content: InscriptionContentInput;
    commitOutpoint: { txid: string; vout: number };
    commitValue: bigint;
    recipientAddress: string;
    postage: bigint;
  }): { psbtBase64: string };
  buildRescueReveal(args: { network: Network; halfSignedPsbtBase64: string }): RescueTx;
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
