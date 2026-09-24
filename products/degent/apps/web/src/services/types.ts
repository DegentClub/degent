/**
 * Ports: every external interaction of the front end goes through one of these small interfaces.
 * Real adapters live in `./real/*` (delegating to @bsh/degent-mint-sdk, @bsh/wallet-kit,
 * @bsh/inscription, esplora and the browser canvas); fakes live in `./fakes.ts` and power the
 * tests and `?demo=1`.
 */
import type {
  AuthChallengeResponse,
  AuthVerifyResponse,
  CastVoteRequest,
  CreateOrderRequest,
  ExplorerQuery,
  ExplorerResponse,
  HolderResponse,
  Network,
  Order,
  RegisterMember,
  RegisterSummary,
  RescueResponse,
  ReviewQueueResponse,
  ServiceConfig,
  StatsResponse,
  SubmitRevealRequest,
  VerifyMembershipResponse,
  VotesResponse,
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
   * GET /v1/orders/{id}/rescue: the parameters (incl. the content bytes) of the parent-less [commit] -> [child]
   * rescue. Not a transaction: only the user's K_e can sign it (ADR-0005).
   */
  getRescue(orderId: string, orderToken: string): Promise<RescueResponse>;

  // Member approval (ADR-0007): holder sign-in, review queue, votes
  authChallenge(address: string): Promise<AuthChallengeResponse>;
  authVerify(address: string, message: string, signature: string): Promise<AuthVerifyResponse>;
  getReviewQueue(sessionToken: string): Promise<ReviewQueueResponse>;
  castVote(orderId: string, sessionToken: string, req: CastVoteRequest): Promise<VotesResponse>;
  getVotes(orderId: string): Promise<VotesResponse>;

  // The Register (public)
  getRegister(): Promise<RegisterSummary>;
  getRegisterMember(n: number): Promise<RegisterMember>;
  getHolder(address: string): Promise<HolderResponse>;
  verifyMember(inscriptionId: string): Promise<VerifyMembershipResponse>;
  getExplorer(query: ExplorerQuery): Promise<ExplorerResponse>;
  getStats(): Promise<StatsResponse>;
}

// ---------------------------------------------------------------- telegram gate (/verify)

export interface GateSubmission {
  token: string;
  address: string;
  message: string;
  signature: string;
}

/** The holders-only Telegram gate service (built separately): POST {token, address, message, signature}. */
export interface GateApi {
  submit(url: string, body: GateSubmission): Promise<{ ok: boolean; invite?: string; message?: string }>;
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
  /** BIP-322 simple signature (base64) of `message` by `address` (SIWB sign-in, member votes). */
  signMessage(message: string, address: string): Promise<string>;
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

export interface ResignedRescueTx extends RescueTx {
  weight: number;
  vsize: number;
  fee: bigint;
}

export interface InscriptionOps {
  generateEphemeralKey(): EphemeralKey;
  /** x-only public key (hex) of a reveal key, to check a decrypted K_e belongs to the order. */
  publicKeyHex(privkey: Uint8Array): string;
  commitAddress(pubkeyHex: string, content: InscriptionContentInput, network: Network): string;
  /**
   * SIGHASH_ALL|ANYONECANPAY (0x81, ADR-0005): [commit] -> [parent return, child]. Output 0 (the collection
   * address, exactly `parentValue`) comes from the binding quote and is signed up front.
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
  /** Self-rescue (ADR-0005): re-sign [commit] -> [child] with K_e (SIGHASH_DEFAULT); no parent. */
  buildResignedRescue(args: {
    network: Network;
    revealPrivkey: Uint8Array;
    content: InscriptionContentInput;
    commitOutpoint: { txid: string; vout: number };
    commitValue: bigint;
    recipientAddress: string;
    postage: bigint;
    feeRate?: number;
  }): ResignedRescueTx;
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
  gate: GateApi;
}
